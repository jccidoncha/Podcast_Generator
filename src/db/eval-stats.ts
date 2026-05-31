import { prisma } from "./client";
import type { EvalReport } from "@/evals/types";

const DEFAULT_WINDOW_DAYS = 30;

export type CheckAggregate = {
  name: string;
  episodesMeasured: number;
  passRate: number; // 0..1
  avgScore: number | null;
};

export type EvalStats = {
  windowDays: number;
  totalEpisodes: number;
  episodesWithScores: number;
  overallPassRate: number;
  perCheck: CheckAggregate[];
  recent: Array<{
    episodeId: string;
    createdAt: string;
    passed: number;
    failed: number;
    avgScore: number | null;
  }>;
};

// Aggregate Episode.evalScoreJson across recent episodes for a user. Used by
// /api/evals/recent and the dashboard.
export async function getEvalStats(
  userId: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<EvalStats> {
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const episodes = await prisma.episode.findMany({
    where: {
      createdAt: { gte: since },
      run: { userId },
    },
    select: {
      id: true,
      createdAt: true,
      evalScoreJson: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const totalEpisodes = episodes.length;
  const withReports = episodes
    .map((ep) => ({
      id: ep.id,
      createdAt: ep.createdAt,
      report: parseReport(ep.evalScoreJson),
    }))
    .filter((ep): ep is { id: string; createdAt: Date; report: EvalReport } => ep.report !== null);

  const perCheckMap = new Map<
    string,
    { passes: number; total: number; scoreSum: number; scoreN: number }
  >();
  let overallPasses = 0;
  let overallTotal = 0;

  for (const { report } of withReports) {
    for (const r of report.results) {
      const acc = perCheckMap.get(r.name) ?? { passes: 0, total: 0, scoreSum: 0, scoreN: 0 };
      acc.total += 1;
      if (r.passed) acc.passes += 1;
      if (typeof r.score === "number") {
        acc.scoreSum += r.score;
        acc.scoreN += 1;
      }
      perCheckMap.set(r.name, acc);
      overallTotal += 1;
      if (r.passed) overallPasses += 1;
    }
  }

  const perCheck: CheckAggregate[] = [...perCheckMap.entries()].map(([name, a]) => ({
    name,
    episodesMeasured: a.total,
    passRate: a.total === 0 ? 0 : a.passes / a.total,
    avgScore: a.scoreN === 0 ? null : a.scoreSum / a.scoreN,
  }));
  perCheck.sort((a, b) => a.passRate - b.passRate); // worst first

  return {
    windowDays,
    totalEpisodes,
    episodesWithScores: withReports.length,
    overallPassRate: overallTotal === 0 ? 0 : overallPasses / overallTotal,
    perCheck,
    recent: withReports.slice(0, 10).map(({ id, createdAt, report }) => ({
      episodeId: id,
      createdAt: createdAt.toISOString(),
      passed: report.summary.passed,
      failed: report.summary.failed,
      avgScore: report.summary.avgScore,
    })),
  };
}

function parseReport(json: unknown): EvalReport | null {
  if (!json || typeof json !== "object") return null;
  const candidate = json as Partial<EvalReport>;
  if (candidate.version !== "v1" || !Array.isArray(candidate.results)) return null;
  return json as EvalReport;
}
