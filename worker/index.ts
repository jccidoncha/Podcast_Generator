import cron from "node-cron";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { processPendingRuns } from "./jobs/process-pending";
import { processScheduledUsers } from "./jobs/process-scheduled";
import { sweepStaleRuns } from "./jobs/sweep-stale-runs";

const PENDING_POLL_MS = 5_000;
const JANITOR_INTERVAL_MS = 60_000;

async function main() {
  if (!cron.validate(config.WORKER_CRON)) {
    throw new Error(`Invalid WORKER_CRON expression: ${config.WORKER_CRON}`);
  }

  logger.info(
    { cron: config.WORKER_CRON, dryRun: config.DRY_RUN, pollMs: PENDING_POLL_MS },
    "worker starting",
  );

  // Boot-time recovery: any PENDING/RUNNING left over from a crashed run (or
  // queued while the worker was offline) gets marked FAILED so it stops
  // blocking the API's inflight dedupe.
  await sweepStaleRuns();

  // Also check schedules at boot — covers the case where the worker was down
  // through a user's scheduled slot.
  void processScheduledUsers();

  // 1) Per-user schedule check (the cron interval drives polling cadence;
  //    each user's actual generation time is per-user in PodcastConfig).
  //    Log each tick at debug level so `LOG_LEVEL=debug pnpm worker` makes
  //    cadence problems immediately obvious without spamming info logs.
  cron.schedule(config.WORKER_CRON, () => {
    logger.debug({ cron: config.WORKER_CRON }, "cron tick — checking schedules");
    void processScheduledUsers();
  });

  // 2) On-demand: UI POSTs /api/runs which queues PENDING; we pick them up.
  //    process-scheduled also drops PENDING rows here when a user's slot fires.
  setInterval(() => {
    void processPendingRuns();
  }, PENDING_POLL_MS);

  // 3) Periodic janitor in case worker stays up but a run gets wedged.
  setInterval(() => {
    void sweepStaleRuns();
  }, JANITOR_INTERVAL_MS);

  if (config.NODE_ENV !== "production") {
    void processPendingRuns();
  }
}

main().catch((err) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});
