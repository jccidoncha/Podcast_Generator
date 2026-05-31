import { prisma } from "@/db/client";
import { logger } from "@/lib/logger";

// Per-user schedule dispatch. Called on every worker cron tick.
// For each user with scheduleEnabled=true, computes whether today's slot is
// due in their local timezone. If due AND we haven't already fired for today
// AND no run is already in-flight for them, creates a PENDING run — the
// existing process-pending poller picks it up from there.
//
// This decouples "when does a user want an episode" from "is the worker
// ready to process it now". Coarse cron granularity (every 15min) is fine —
// the schedule will fire up to ~15min late, which is invisible to the user.

const log = logger.child({ worker: "process-scheduled" });

export async function processScheduledUsers(): Promise<void> {
  const candidates = await prisma.podcastConfig.findMany({
    where: { scheduleEnabled: true },
  });

  if (candidates.length === 0) return;

  const now = new Date();
  let fired = 0;
  let skipped = 0;

  for (const cfg of candidates) {
    try {
      if (!shouldFireNow(cfg, now)) {
        skipped += 1;
        continue;
      }

      // Skip if user already has an in-flight run — covers the case where a
      // manual generate started ~now or the previous tick's run is still
      // processing. Avoids the user getting two episodes at 6pm.
      const inflight = await prisma.run.findFirst({
        where: { userId: cfg.userId, status: { in: ["PENDING", "RUNNING"] } },
      });
      if (inflight) {
        log.info(
          { userId: cfg.userId, inflightRunId: inflight.id },
          "schedule due but run already in flight — skipping",
        );
        // Still mark today as handled so we don't keep checking every tick.
        await prisma.podcastConfig.update({
          where: { userId: cfg.userId },
          data: { lastScheduledRunAt: now },
        });
        continue;
      }

      // Use a small transaction so we never create a Run without also
      // stamping lastScheduledRunAt — otherwise a crash between the two
      // would fire again on the next tick.
      await prisma.$transaction(async (tx) => {
        await tx.run.create({
          data: { userId: cfg.userId, status: "PENDING" },
        });
        await tx.podcastConfig.update({
          where: { userId: cfg.userId },
          data: { lastScheduledRunAt: now },
        });
      });

      fired += 1;
      log.info(
        {
          userId: cfg.userId,
          scheduledAt: `${pad(cfg.scheduleHour)}:${pad(cfg.scheduleMinute)} ${cfg.scheduleTimezone}`,
        },
        "scheduled run queued",
      );
    } catch (err) {
      log.error({ userId: cfg.userId, err: String(err).slice(0, 200) }, "schedule check failed");
    }
  }

  if (fired > 0 || skipped > 0) {
    log.info({ checked: candidates.length, fired, skipped }, "schedule sweep complete");
  }
}

// Pure decision function — easy to unit-test. Returns true if `now` (UTC)
// translates to a moment inside the user's selected day-of-week and at-or-after
// their selected time, AND lastScheduledRunAt falls on a different LOCAL day
// (or is null). The "different local day" check is what gives us
// once-per-local-day semantics regardless of how often the cron ticks.
export function shouldFireNow(
  cfg: {
    scheduleHour: number;
    scheduleMinute: number;
    scheduleDays: number[];
    scheduleTimezone: string;
    lastScheduledRunAt: Date | null;
  },
  now: Date,
): boolean {
  const localNow = getLocalParts(now, cfg.scheduleTimezone);
  if (!cfg.scheduleDays.includes(localNow.dayOfWeek)) return false;

  const nowMinutes = localNow.hour * 60 + localNow.minute;
  const scheduledMinutes = cfg.scheduleHour * 60 + cfg.scheduleMinute;
  if (nowMinutes < scheduledMinutes) return false;

  if (cfg.lastScheduledRunAt) {
    const lastLocalDay = getLocalParts(cfg.lastScheduledRunAt, cfg.scheduleTimezone).ymd;
    if (lastLocalDay === localNow.ymd) return false;
  }

  return true;
}

// Decompose a UTC Date into the user's local-timezone calendar fields. Uses
// Intl.DateTimeFormat — native, accurate across DST transitions, no extra deps.
function getLocalParts(
  d: Date,
  tz: string,
): { hour: number; minute: number; dayOfWeek: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = get("weekday");

  // Intl gives Sun..Sat as "Sun".."Sat" — map to 0..6 to match scheduleDays.
  const dayOfWeek =
    { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 0;

  return { hour, minute, dayOfWeek, ymd: `${year}-${month}-${day}` };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
