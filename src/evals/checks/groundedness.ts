import type { Article, Script } from "@/pipeline/types";
import type { CheckResult } from "../types";

// CLAUDE.md §9.1: groundedness is the HIGHEST-priority eval. Every claim in
// the script must trace back to a source article. This check is structural:
// it verifies that each line's sourceUrl belongs to the selected article set.
// Layer B will add LLM-assisted entailment to also verify the CONTENT of each
// claim against the article body.
export function checkGroundedness(script: Script, articles: Article[]): CheckResult {
  const validUrls = new Set(articles.map((a) => a.url));
  const ungrounded: Array<{ text: string; url: string }> = [];
  let totalLines = 0;

  for (const segment of script.segments) {
    for (const line of segment.lines) {
      totalLines += 1;
      if (!validUrls.has(line.sourceUrl)) {
        ungrounded.push({ text: line.text.slice(0, 60), url: line.sourceUrl });
      }
    }
  }

  const groundedRatio = totalLines === 0 ? 1 : (totalLines - ungrounded.length) / totalLines;

  return {
    name: "groundedness",
    passed: ungrounded.length === 0,
    detail:
      ungrounded.length === 0
        ? undefined
        : `${ungrounded.length}/${totalLines} ungrounded; first: "${ungrounded[0].text}..." → ${ungrounded[0].url}`,
    score: groundedRatio,
    measurements: { totalLines, ungrounded: ungrounded.length },
  };
}
