import Link from "next/link";
import { prisma } from "@/db/client";
import { getEvalStats } from "@/db/eval-stats";

const DEMO_USER_ID = "demo-user";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;

type Metric = {
  label: string;
  value: string;
  note?: string;
  source: "live" | "mock";
};

async function loadMetrics(): Promise<Metric[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);

  const [episodesCount, runsTotal, runsSucceeded, usersActive, episodes, runsSucceededFull] =
    await Promise.all([
      prisma.episode.count({ where: { createdAt: { gte: since } } }),
      prisma.run.count({ where: { startedAt: { gte: since } } }),
      prisma.run.count({ where: { startedAt: { gte: since }, status: "SUCCEEDED" } }),
      prisma.run
        .groupBy({
          by: ["userId"],
          where: { startedAt: { gte: since } },
        })
        .then((g) => g.length),
      prisma.episode.findMany({
        where: { createdAt: { gte: since } },
        select: { costCents: true },
      }),
      prisma.run.findMany({
        where: { startedAt: { gte: since }, status: "SUCCEEDED", finishedAt: { not: null } },
        select: { startedAt: true, finishedAt: true },
      }),
    ]);

  const avgCostCents = avg(episodes.map((e) => e.costCents));
  const avgDurationSec = avg(
    runsSucceededFull.map((r) => (r.finishedAt!.getTime() - r.startedAt.getTime()) / 1000),
  );
  const successRate = runsTotal === 0 ? 0 : runsSucceeded / runsTotal;

  return [
    { label: `Active users (${WINDOW_DAYS}d)`, value: String(usersActive), source: "live" },
    { label: `Episodes generated (${WINDOW_DAYS}d)`, value: String(episodesCount), source: "live" },
    {
      label: `Generation success rate`,
      value: runsTotal === 0 ? "—" : `${(successRate * 100).toFixed(0)}%`,
      note: `${runsSucceeded}/${runsTotal} runs`,
      source: "live",
    },
    {
      label: `Avg generation time`,
      value: runsSucceededFull.length === 0 ? "—" : `${avgDurationSec.toFixed(0)}s`,
      source: "live",
    },
    {
      label: `Avg cost per episode`,
      value: episodes.length === 0 ? "—" : `$${(avgCostCents / 100).toFixed(2)}`,
      source: "live",
    },
    {
      label: "Listen-through rate",
      value: "62%",
      note: "no player events tracked yet",
      source: "mock",
    },
    {
      label: "Avg groundedness score",
      value: "0.91",
      note: "eval harness not wired",
      source: "mock",
    },
    {
      label: "Avg tone/engagement score",
      value: "0.78",
      note: "eval harness not wired",
      source: "mock",
    },
  ];
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export default async function DashboardPage() {
  const [metrics, evalStats] = await Promise.all([
    loadMetrics(),
    getEvalStats(DEMO_USER_ID, 30),
  ]);

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-neutral-500">{m.label}</p>
              <Badge source={m.source} />
            </div>
            <p className="mt-2 text-2xl font-semibold">{m.value}</p>
            {m.note && <p className="mt-1 text-xs text-neutral-500">{m.note}</p>}
          </div>
        ))}
      </div>

      <section className="mt-12">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Output quality (deterministic evals)</h2>
          <span className="text-xs text-neutral-500">
            {evalStats.episodesWithScores}/{evalStats.totalEpisodes} episodes scored · last{" "}
            {evalStats.windowDays} days
          </span>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          Per-check pass rate + average score. Lowest pass rate at the top — that&apos;s
          where prompt or pipeline iteration pays off.
        </p>

        {evalStats.perCheck.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No evals scored yet. Generate an episode to populate this view.
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="min-w-full divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
                <tr>
                  <th className="px-4 py-2 text-left">Check</th>
                  <th className="px-4 py-2 text-right">Pass rate</th>
                  <th className="px-4 py-2 text-right">Avg score</th>
                  <th className="px-4 py-2 text-right">Episodes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {evalStats.perCheck.map((c) => (
                  <tr key={c.name}>
                    <td className="px-4 py-2 font-mono text-xs">{c.name}</td>
                    <td className="px-4 py-2 text-right">
                      <PassRateChip rate={c.passRate} />
                    </td>
                    <td className="px-4 py-2 text-right text-neutral-700 dark:text-neutral-300">
                      {c.avgScore === null ? "—" : c.avgScore.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right text-neutral-500">
                      {c.episodesMeasured}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {evalStats.recent.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium">Per-episode</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {evalStats.recent.map((e) => (
                <li key={e.episodeId} className="flex items-center justify-between gap-3">
                  <Link
                    href={`/episodes/${e.episodeId}`}
                    className="font-mono text-xs text-neutral-500 hover:underline"
                  >
                    {new Date(e.createdAt).toLocaleString()}
                  </Link>
                  <span className="text-xs text-neutral-500">
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {e.passed} ✓
                    </span>
                    {" / "}
                    <span className="text-red-600 dark:text-red-400">{e.failed} ✗</span>
                    {" · "}
                    avg {e.avgScore === null ? "—" : e.avgScore.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function PassRateChip({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  const cls =
    rate >= 0.8
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
      : rate >= 0.5
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
        : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{pct}%</span>
  );
}

function Badge({ source }: { source: "live" | "mock" }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        source === "live"
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
      }`}
    >
      {source}
    </span>
  );
}
