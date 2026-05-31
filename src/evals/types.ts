// Shape of a single deterministic check. `passed` is a boolean for pass/fail
// gates; `score` (0-1) and `measurements` carry the numeric detail so the
// dashboard can plot trends instead of just counting pass/fail.
export type CheckResult = {
  name: string;
  passed: boolean;
  detail?: string;
  score?: number; // 0..1 if applicable (e.g. 0.85 = 85% of lines in band)
  measurements?: Record<string, number>; // raw numbers
};

// Snapshot of all deterministic checks for one episode. Stored in
// Episode.evalScoreJson — the schema is versioned so we can migrate later.
export type EvalReport = {
  version: "v1";
  ranAt: string; // ISO timestamp
  results: CheckResult[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    avgScore: number | null; // mean of scores that exist
  };
};

export function summarize(results: CheckResult[]): EvalReport["summary"] {
  const withScore = results.filter((r) => typeof r.score === "number");
  const avgScore =
    withScore.length === 0
      ? null
      : withScore.reduce((s, r) => s + (r.score ?? 0), 0) / withScore.length;
  return {
    totalChecks: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    avgScore,
  };
}
