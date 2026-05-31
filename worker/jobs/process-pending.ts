import { prisma } from "@/db/client";
import { loadUserContext } from "@/db/context";
import { runPipeline } from "@/pipeline";
import { logger } from "@/lib/logger";
import type { Format, RunContext, Style } from "@/pipeline/types";

// Worker poll-loop dispatch. Both manual generates (POST /api/runs from the
// UI) and per-user schedules (process-scheduled.ts) create Run(PENDING) rows;
// this picks them up in arrival order and runs the pipeline.

let isBusy = false;

const log = logger.child({ worker: "process-pending" });

const VOICE_FALLBACKS = ["rachel", "adam", "aria"] as const;

export async function processPendingRuns(): Promise<void> {
  if (isBusy) return;
  isBusy = true;
  try {
    // Take the oldest PENDING run if any.
    const pending = await prisma.run.findFirst({
      where: { status: "PENDING" },
      orderBy: { startedAt: "asc" },
    });
    if (!pending) return;

    log.info({ runId: pending.id, userId: pending.userId }, "picked up pending run");

    const { config: baseConfig, interests } = await loadUserContext(pending.userId);

    if (interests.length === 0) {
      log.warn({ runId: pending.id, userId: pending.userId }, "no interests — marking FAILED");
      await prisma.run.update({
        where: { id: pending.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorMessage: "no interests configured",
        },
      });
      return;
    }

    // Apply per-run overrides on top of the user's saved config. Each override
    // is opt-in — if the Run row doesn't have it, the saved value wins.
    const overrideFormat = pending.overrideFormat
      ? (pending.overrideFormat.toLowerCase() as Format)
      : null;
    const overrideStyle = pending.overrideStyle
      ? (pending.overrideStyle.toLowerCase() as Style)
      : null;

    // If the override flips us into a multi-speaker format AND the saved
    // config has no secondaryVoice, pick a sensible default different from
    // the primary so synthesis doesn't fall back to "primary for everything".
    let secondaryVoice = baseConfig.secondaryVoice;
    const effectiveFormat = overrideFormat ?? baseConfig.format;
    if (effectiveFormat !== "solo" && !secondaryVoice) {
      secondaryVoice =
        VOICE_FALLBACKS.find((v) => v !== baseConfig.voice) ?? "adam";
      log.info(
        { primary: baseConfig.voice, secondary: secondaryVoice },
        "auto-picked secondaryVoice for multi-speaker override",
      );
    }

    const ctx: RunContext = {
      runId: pending.id,
      userId: pending.userId,
      interests,
      config: {
        ...baseConfig,
        secondaryVoice,
        targetLengthMin: pending.overrideTargetLengthMin ?? baseConfig.targetLengthMin,
        format: effectiveFormat,
        style: overrideStyle ?? baseConfig.style,
      },
      now: new Date(),
      focusTopic: pending.focusTopic ?? null,
    };

    if (pending.overrideTargetLengthMin || overrideFormat || overrideStyle) {
      log.info(
        {
          runId: pending.id,
          overrides: {
            targetLengthMin: pending.overrideTargetLengthMin,
            format: overrideFormat,
            style: overrideStyle,
          },
          effectiveConfig: {
            targetLengthMin: ctx.config.targetLengthMin,
            format: ctx.config.format,
            style: ctx.config.style,
          },
        },
        "applied per-run overrides",
      );
    }

    try {
      const episode = await runPipeline(ctx);
      log.info({ episodeId: episode.episodeId, runId: pending.id }, "pending run complete");
    } catch (err) {
      log.error({ err, runId: pending.id }, "pending run failed");
    }
  } finally {
    isBusy = false;
  }
}
