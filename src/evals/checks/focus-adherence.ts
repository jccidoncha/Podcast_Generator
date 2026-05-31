import type { Script } from "@/pipeline/types";
import type { CheckResult } from "../types";

// When the user picked a focusTopic (POST /api/runs { focusTopic }), we want
// the script to actually concentrate there. We approximate "concentration" by
// (a) matching segment topics against the focus string, and (b) measuring how
// many segments / words go to focus-matching segments.
//
// Layer B will replace this with embeddings for semantic match. For now, a
// substring match catches the common case (focusTopic comes from the user's
// own interest list or our proposals, both of which use the same topic vocab).

const TARGET_FOCUS_RATIO = 0.6; // ≥60% of words in focus-matching segments

export function checkFocusAdherence(
  script: Script,
  focusTopic: string | null,
): CheckResult {
  // No focus → check trivially passes; consumers can filter these out of
  // averages by reading `skipped` in measurements.
  if (!focusTopic) {
    return {
      name: "focus-adherence",
      passed: true,
      detail: "no focus topic set",
      measurements: { skipped: 1 },
    };
  }

  const focusLower = focusTopic.toLowerCase().trim();
  let totalWords = 0;
  let focusWords = 0;
  let focusSegments = 0;

  for (const seg of script.segments) {
    const matches = matchesFocus(seg.topic, focusLower);
    if (matches) focusSegments += 1;
    for (const line of seg.lines) {
      const words = countWords(line.text);
      totalWords += words;
      if (matches) focusWords += words;
    }
  }

  if (totalWords === 0) {
    return { name: "focus-adherence", passed: false, detail: "empty script" };
  }

  const ratio = focusWords / totalWords;
  const passed = ratio >= TARGET_FOCUS_RATIO;

  return {
    name: "focus-adherence",
    passed,
    detail: passed
      ? undefined
      : `only ${Math.round(ratio * 100)}% of words in focus-matching segments (${focusSegments}/${script.segments.length}); target ${Math.round(TARGET_FOCUS_RATIO * 100)}%`,
    score: ratio,
    measurements: {
      focusSegments,
      totalSegments: script.segments.length,
      focusWords,
      totalWords,
      focusRatio: ratio,
    },
  };
}

function matchesFocus(topic: string, focusLower: string): boolean {
  const t = topic.toLowerCase().trim();
  if (!t) return false;
  return t.includes(focusLower) || focusLower.includes(t);
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
