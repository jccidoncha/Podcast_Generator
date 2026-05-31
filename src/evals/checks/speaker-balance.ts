import type { Format, Script } from "@/pipeline/types";
import type { CheckResult } from "../types";

// Multi-speaker formats need both voices to participate meaningfully. If
// secondary speaks only 5% of the time, the format is broken — it's just a
// monologue with a few "right." interjections. This check measures the ratio
// in segment lines (intro/outro are always primary, excluded from the count).

const MIN_SECONDARY_RATIO = 0.25; // secondary must speak ≥25% of segment lines
const MAX_SECONDARY_RATIO = 0.6; // and ≤60% (primary is still the host)

export function checkSpeakerBalance(script: Script, format: Format): CheckResult {
  if (format === "solo") {
    return {
      name: "speaker-balance",
      passed: true,
      detail: "skipped for solo format",
      measurements: { skipped: 1 },
    };
  }

  let primary = 0;
  let secondary = 0;
  for (const seg of script.segments) {
    for (const line of seg.lines) {
      if (line.speaker === "primary") primary += 1;
      else secondary += 1;
    }
  }

  const total = primary + secondary;
  if (total === 0) {
    return { name: "speaker-balance", passed: false, detail: "no segment lines" };
  }

  const secondaryRatio = secondary / total;
  const passed =
    secondaryRatio >= MIN_SECONDARY_RATIO && secondaryRatio <= MAX_SECONDARY_RATIO;

  // Score peaks at the band midpoint (~0.425), drops linearly toward 0/1.
  const target = (MIN_SECONDARY_RATIO + MAX_SECONDARY_RATIO) / 2;
  const score = Math.max(0, 1 - Math.abs(secondaryRatio - target) / target);

  return {
    name: "speaker-balance",
    passed,
    detail: passed
      ? undefined
      : `secondary speaks ${Math.round(secondaryRatio * 100)}% of segment lines (want ${Math.round(MIN_SECONDARY_RATIO * 100)}–${Math.round(MAX_SECONDARY_RATIO * 100)}%)`,
    score,
    measurements: { primary, secondary, secondaryRatio },
  };
}
