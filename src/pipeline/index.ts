import { prisma } from "@/db/client";
import { logger } from "@/lib/logger";
import { collectStage } from "./collect";
import { rankStage } from "./rank";
import { enrichStage } from "./enrich";
import { scriptStage } from "./script";
import { synthesizeStage } from "./synthesize";
import { persistStage } from "./persist";
import { runStage } from "./stage";
import type { EpisodeMeta, RunContext } from "./types";

// Orchestrator. Each step is `runStage(stageObj, input, ctx)` so retry +
// validation policy live in one place (`stage.ts`).
//
// Flow (CLAUDE.md plan, paso 3):
//   collect → rank (MMR) → enrich (full text) → script → synthesize → persist
//
// The Run row was created PENDING by the worker; here we flip it to RUNNING
// and `persist` flips it to SUCCEEDED inside its own transaction.
export async function runPipeline(ctx: RunContext): Promise<EpisodeMeta> {
  const log = logger.child({ runId: ctx.runId, userId: ctx.userId });
  log.info("pipeline start");

  await prisma.run.update({
    where: { id: ctx.runId },
    data: { status: "RUNNING" },
  });

  try {
    const collected = await runStage(collectStage, undefined, ctx);
    const ranked = await runStage(rankStage, collected, ctx);
    const enriched = await runStage(enrichStage, ranked, ctx);
    const script = await runStage(scriptStage, enriched, ctx);
    const synthesis = await runStage(synthesizeStage, script, ctx);
    const meta = await runStage(
      persistStage,
      { articles: enriched, script, synthesis },
      ctx,
    );

    log.info({ episodeId: meta.episodeId }, "pipeline complete");
    return meta;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.run
      .update({
        where: { id: ctx.runId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorMessage: message.slice(0, 1000),
        },
      })
      .catch((updateErr) => log.error({ updateErr }, "failed to mark run FAILED"));
    throw err;
  }
}

export type { RunContext, EpisodeMeta };
