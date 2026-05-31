import type { Script, Style } from "@/pipeline/types";
import type { CheckResult } from "../types";

const MIN_BAND = 0.85;
const MAX_BAND = 1.15;

export function checkStructure(script: Script): CheckResult {
  if (!script.intro.trim()) return fail("structure", "missing intro");
  if (!script.outro.trim()) return fail("structure", "missing outro");
  if (script.segments.length === 0) return fail("structure", "no segments");
  return pass("structure");
}

export function checkLength(script: Script, targetLengthMin: number): CheckResult {
  const targetSec = targetLengthMin * 60;
  const minSec = targetLengthMin * MIN_BAND * 60;
  const maxSec = targetLengthMin * MAX_BAND * 60;
  const actualSec = script.estimatedDurationMs / 1000;
  const ok = actualSec >= minSec && actualSec <= maxSec;
  // Score = how close we are to target (1 at target, 0 at 0s or 2x target).
  const score = Math.max(0, 1 - Math.abs(actualSec - targetSec) / targetSec);
  return {
    name: "length",
    passed: ok,
    detail: ok
      ? undefined
      : `est ${Math.round(actualSec)}s outside [${Math.round(minSec)}s, ${Math.round(maxSec)}s]`,
    score,
    measurements: { actualSec, targetSec, minSec, maxSec },
  };
}

// Words-per-minute should be in a natural speech band. If it's way off, either
// the duration estimate is wrong (script too short or way too long) or the
// model produced unnatural pacing.
export function checkWordsPerMinuteBand(script: Script): CheckResult {
  const totalWords = countWordsInScript(script);
  const minutes = script.estimatedDurationMs / 60_000;
  if (minutes === 0) return fail("wpm-band", "zero duration");
  const wpm = totalWords / minutes;
  const ok = wpm >= 130 && wpm <= 170;
  return ok
    ? pass("wpm-band")
    : fail("wpm-band", `${wpm.toFixed(1)} wpm outside [130, 170]`);
}

export function checkSegmentCountForStyle(script: Script, style: Style): CheckResult {
  const n = script.segments.length;
  switch (style) {
    case "deep_dive":
      return n <= 2
        ? pass("segments-for-style")
        : fail("segments-for-style", `deep_dive expects ≤2, got ${n}`);
    case "magazine":
      return n >= 2 && n <= 3
        ? pass("segments-for-style")
        : fail("segments-for-style", `magazine expects 2–3, got ${n}`);
    case "news_roundup":
    default:
      return n >= 3
        ? pass("segments-for-style")
        : fail("segments-for-style", `news_roundup expects ≥3, got ${n}`);
  }
}

function countWordsInScript(script: Script): number {
  const intro = script.intro.trim().split(/\s+/).filter(Boolean).length;
  const outro = script.outro.trim().split(/\s+/).filter(Boolean).length;
  const segments = script.segments.reduce(
    (sum, s) =>
      sum +
      s.lines.reduce(
        (n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length,
        0,
      ),
    0,
  );
  return intro + outro + segments;
}

function pass(name: string): CheckResult {
  return { name, passed: true };
}

function fail(name: string, detail: string): CheckResult {
  return { name, passed: false, detail };
}
