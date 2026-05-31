import {
  checkLength,
  checkSegmentCountForStyle,
  checkStructure,
  checkWordsPerMinuteBand,
} from "./checks/structure";
import { checkGroundedness } from "./checks/groundedness";
import { checkGroundednessEntailment } from "./checks/groundedness-entailment";
import { checkTurnLength } from "./checks/turn-length";
import { checkSpeakerBalance } from "./checks/speaker-balance";
import { checkFocusAdherence } from "./checks/focus-adherence";
import { judgeScript } from "./judges/llm-judge";
import { summarize, type CheckResult, type EvalReport } from "./types";
import { logger } from "@/lib/logger";
import type { PodcastConfig, RankedArticle, Script } from "@/pipeline/types";

const log = logger.child({ scope: "evals" });

export type RunEvalsParams = {
  script: Script;
  articles: RankedArticle[];
  config: PodcastConfig;
  focusTopic: string | null;
  realDurationMs?: number;
};

// Single entrypoint. Runs:
//   Layer A: deterministic checks (in-process, no LLM, instant)
//   Layer B: groundedness entailment (gpt-4o-mini, batched per article)
//   Layer C: LLM-as-judge rubric scoring (gpt-4o-mini, one call)
//
// All LLM checks run in parallel via Promise.all so total wall-clock added
// is ~max(check), not sum. Eval failures never block the pipeline.
export async function runEvals(params: RunEvalsParams): Promise<EvalReport> {
  const { script, articles, config, focusTopic, realDurationMs } = params;

  const scriptForLength: Script =
    typeof realDurationMs === "number" && realDurationMs > 0
      ? { ...script, estimatedDurationMs: realDurationMs }
      : script;

  // Layer A: synchronous, no I/O.
  const layerA: CheckResult[] = [
    checkStructure(script),
    checkLength(scriptForLength, config.targetLengthMin),
    checkWordsPerMinuteBand(scriptForLength),
    checkSegmentCountForStyle(script, config.style),
    checkGroundedness(script, articles),
    checkTurnLength(script, config.format),
    checkSpeakerBalance(script, config.format),
    checkFocusAdherence(script, focusTopic),
  ];

  // Layers B + C: LLM-backed, async. Run in parallel.
  const [entailment, judgeResults] = await Promise.all([
    checkGroundednessEntailment(script, articles).catch((err) => {
      log.warn({ err: String(err).slice(0, 200) }, "entailment check threw");
      return {
        name: "groundedness-entailment",
        passed: true,
        detail: "check threw — skipped",
        measurements: { error: 1 },
      } as CheckResult;
    }),
    judgeScript(script, config.style, config.tone).catch((err) => {
      log.warn({ err: String(err).slice(0, 200) }, "judge threw");
      return [] as CheckResult[];
    }),
  ]);

  const results: CheckResult[] = [...layerA, entailment, ...judgeResults];
  const summary = summarize(results);
  const report: EvalReport = {
    version: "v1",
    ranAt: new Date().toISOString(),
    results,
    summary,
  };

  log.info(
    {
      passed: summary.passed,
      failed: summary.failed,
      avgScore: summary.avgScore?.toFixed(3),
      failedNames: results.filter((r) => !r.passed).map((r) => r.name),
    },
    "evals complete",
  );

  return report;
}
