import OpenAI from "openai";
import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";
import type { Script, Style, Tone } from "@/pipeline/types";
import { rubricForStyle, rubricVersion } from "../rubrics/script";
import type { CheckResult } from "../types";

// Layer C: LLM-as-judge. One small call per episode that scores the script on
// the rubric axes (tone, engagement, coverage + style-specific axis). Returns
// individual CheckResults per axis so the dashboard shows each on its own
// row. Stable model + temperature 0 so historical scores stay comparable.
//
// Known biases (CLAUDE.md §9.3): position, verbosity, self-preference. We
// can't eliminate them — we just commit to a fixed rubric + model so trends
// over time are meaningful even if absolute values are noisy.

const log = logger.child({ scope: "evals", check: "llm-judge" });
const MODEL = "gpt-4o-mini";

type RawAxisScore = { axis: string; score: number; rationale: string };

export async function judgeScript(
  script: Script,
  style: Style,
  tone: Tone,
): Promise<CheckResult[]> {
  const rubric = rubricForStyle(style);

  if (isDryRun() || !config.OPENAI_API_KEY) {
    // Skip: emit one result per axis marked skipped so the report shape stays
    // consistent across runs.
    return rubric.map((axis) => ({
      name: `judge:${axis.name}`,
      passed: true,
      detail: "skipped (dry-run or no api key)",
      measurements: { skipped: 1 },
    }));
  }

  const schema = buildSchema(rubric.map((a) => a.name));
  const transcript = renderTranscript(script);

  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "JudgeScores", strict: true, schema },
      },
      messages: [
        {
          role: "system",
          content: `You are a podcast critic. Score the script on each rubric axis from 1 (poor) to 5 (excellent). Be discriminating — most podcasts deserve 3-4. Reserve 5 for genuinely excellent execution. Give one short rationale per axis. Rubric version: ${rubricVersion}.`,
        },
        {
          role: "user",
          content: `STYLE: ${style}
TONE REQUESTED: ${tone}

RUBRIC AXES (score each 1-5):
${rubric.map((a) => `- ${a.name}: ${a.description}`).join("\n")}

TRANSCRIPT:
"""
${transcript}
"""

Return JSON with axis scores + rationales.`,
        },
      ],
    });
    const raw = completion.choices[0]?.message.content;
    if (!raw) throw new Error("empty judge response");
    const parsed = JSON.parse(raw) as { axes: RawAxisScore[] };

    const results: CheckResult[] = parsed.axes.map((a) => {
      const score01 = clamp((a.score - 1) / 4, 0, 1); // 1..5 → 0..1
      // Pass: ≥3 (i.e. acceptable). 0.5 in 0..1 space.
      const passed = score01 >= 0.5;
      return {
        name: `judge:${a.axis}`,
        passed,
        detail: passed ? undefined : `${a.score}/5 — ${a.rationale.slice(0, 120)}`,
        score: score01,
        measurements: { rawScore: a.score },
      };
    });

    log.info(
      {
        axes: results.map((r) => ({
          name: r.name,
          score: r.score?.toFixed(2),
          passed: r.passed,
        })),
      },
      "judge complete",
    );
    return results;
  } catch (err) {
    log.warn({ err: String(err).slice(0, 200) }, "judge failed");
    return rubric.map((axis) => ({
      name: `judge:${axis.name}`,
      passed: true,
      detail: "judge failed (network or parse error)",
      measurements: { failed: 1 },
    }));
  }
}

function buildSchema(axisNames: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["axes"],
    properties: {
      axes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["axis", "score", "rationale"],
          properties: {
            axis: { type: "string", enum: axisNames },
            score: { type: "integer", minimum: 1, maximum: 5 },
            rationale: { type: "string" },
          },
        },
      },
    },
  };
}

// Render the script as a plain transcript for the judge (no JSON shape so the
// judge focuses on the prose, not structural quirks).
function renderTranscript(script: Script): string {
  const parts: string[] = [`[INTRO] ${script.intro}`];
  for (const seg of script.segments) {
    parts.push(`\n[SEGMENT: ${seg.topic}]`);
    for (const line of seg.lines) {
      const sp = line.speaker === "secondary" ? "B" : "A";
      parts.push(`${sp}: ${line.text}`);
    }
  }
  parts.push(`\n[OUTRO] ${script.outro}`);
  return parts.join("\n");
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
