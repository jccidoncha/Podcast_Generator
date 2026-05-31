import { prisma } from "@/db/client";
import { logger } from "@/lib/logger";

const STALE_AFTER_MS = 5 * 60_000; // 5 min

// Recovery janitor: any PENDING or RUNNING row older than STALE_AFTER_MS is
// considered abandoned (worker crashed mid-flight, or the run was queued while
// the worker was offline). Mark them FAILED so they stop blocking the inflight
// dedupe in POST /api/runs.
//
// Runs on worker boot and on every cron tick. Cheap query — indexed on status.
export async function sweepStaleRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const stale = await prisma.run.findMany({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      startedAt: { lt: cutoff },
    },
    select: { id: true, status: true, startedAt: true },
  });

  if (stale.length === 0) return;

  await prisma.run.updateMany({
    where: { id: { in: stale.map((r) => r.id) } },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errorMessage: "stale run swept by janitor (worker crash or queued while offline)",
    },
  });

  logger.warn(
    { count: stale.length, ids: stale.map((r) => r.id) },
    "swept stale runs to FAILED",
  );
}
