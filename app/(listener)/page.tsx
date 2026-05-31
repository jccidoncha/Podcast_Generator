import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/db/client";
import { GenerateButton } from "../_components/GenerateButton";

const DEMO_USER_ID = "demo-user";

export const dynamic = "force-dynamic";

type SearchParams = {
  firstRun?: string;
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { firstRun } = await searchParams;

  // First-time UX: if the user has no interests yet, push them through
  // onboarding instead of dumping them on an empty homepage.
  const interestCount = await prisma.interest.count({
    where: { userId: DEMO_USER_ID },
  });
  if (interestCount === 0) {
    redirect("/onboarding");
  }

  const [episodes, recentRuns] = await Promise.all([
    prisma.episode.findMany({
      where: { run: { userId: DEMO_USER_ID } },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        sources: { select: { url: true, title: true } },
        run: { select: { startedAt: true } },
      },
    }),
    prisma.run.findMany({
      where: { userId: DEMO_USER_ID, status: { in: ["PENDING", "RUNNING"] } },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
  ]);

  const inflightRunId = recentRuns[0]?.id ?? firstRun;

  return (
    <div className="space-y-12">
      <section className="rounded-2xl border border-neutral-200 bg-gradient-to-br from-neutral-50 to-neutral-100 p-8 dark:border-neutral-800 dark:from-neutral-900 dark:to-neutral-950">
        <p className="text-xs uppercase tracking-wider text-neutral-500">Your personal podcast</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          What&apos;s worth your time today?
        </h1>
        <p className="mt-3 max-w-xl text-sm text-neutral-600 dark:text-neutral-400">
          A custom episode built from the news that matters to you — generated on demand
          or on your schedule.
        </p>
        <div className="mt-6">
          <GenerateButton initialRunId={inflightRunId} />
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Recent episodes</h2>
          {episodes.length > 0 && (
            <Link
              href="/episodes"
              className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              View all →
            </Link>
          )}
        </div>

        {episodes.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No episodes yet. Hit <strong>Generate now</strong> above to create your first one.
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
            {episodes.map((ep) => (
              <li key={ep.id} className="py-4">
                <Link
                  href={`/episodes/${ep.id}`}
                  className="flex items-baseline justify-between gap-4 hover:opacity-80"
                >
                  <span className="text-base">
                    Episode of {new Date(ep.createdAt).toLocaleString()}
                    <span className="ml-2 text-xs text-neutral-500">
                      {ep.sources.length} sources
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {Math.round(ep.durationMs / 60_000)} min
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
