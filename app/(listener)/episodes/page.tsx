import Link from "next/link";
import { prisma } from "@/db/client";

const DEMO_USER_ID = "demo-user";

export const dynamic = "force-dynamic";

export default async function EpisodesPage() {
  const episodes = await prisma.episode.findMany({
    where: { run: { userId: DEMO_USER_ID } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      sources: { select: { url: true, title: true } },
      run: { select: { startedAt: true } },
    },
  });

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Your episodes</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Generated on your schedule. Tap one to listen.
      </p>

      {episodes.length === 0 ? (
        <div className="mt-8 rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No episodes yet. The worker will produce one on the next cadence tick.
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-neutral-200 dark:divide-neutral-800">
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
  );
}
