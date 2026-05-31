import type { Format, Script } from "@/pipeline/types";
import type { CheckResult } from "../types";

// For multi-speaker formats we want short, dialogue-like turns. If the model
// keeps producing 60+ word "monologues per line", the conversation feels stiff
// even though the prompt asked for turns. This check measures the actual turn
// length distribution and fails when too many lines exceed the band.

const BAND: Record<Exclude<Format, "solo">, { min: number; max: number }> = {
  co_host: { min: 10, max: 50 },
  debate: { min: 10, max: 50 },
  interview: { min: 10, max: 70 }, // interview answers can be longer
};

const MIN_IN_BAND_RATIO = 0.7; // ≥70% of turns must be inside the band

export function checkTurnLength(script: Script, format: Format): CheckResult {
  // Solo doesn't have turns — skip with a "passed" no-op so the report stays
  // uniform across formats.
  if (format === "solo") {
    return {
      name: "turn-length",
      passed: true,
      detail: "skipped for solo format",
      measurements: { skipped: 1 },
    };
  }

  const band = BAND[format];
  const counts: number[] = [];
  for (const seg of script.segments) {
    for (const line of seg.lines) {
      counts.push(countWords(line.text));
    }
  }

  if (counts.length === 0) {
    return { name: "turn-length", passed: false, detail: "no lines to measure" };
  }

  const inBand = counts.filter((n) => n >= band.min && n <= band.max).length;
  const ratio = inBand / counts.length;
  const avg = counts.reduce((s, n) => s + n, 0) / counts.length;
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const tooLong = counts.filter((n) => n > band.max).length;
  const tooShort = counts.filter((n) => n < band.min).length;

  const passed = ratio >= MIN_IN_BAND_RATIO;

  return {
    name: "turn-length",
    passed,
    detail: passed
      ? undefined
      : `only ${Math.round(ratio * 100)}% of ${counts.length} turns inside [${band.min}, ${band.max}] words (avg ${avg.toFixed(1)}, median ${median}, ${tooLong} too long, ${tooShort} too short)`,
    score: ratio,
    measurements: {
      totalLines: counts.length,
      inBand,
      tooLong,
      tooShort,
      avgWords: avg,
      medianWords: median,
    },
  };
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
