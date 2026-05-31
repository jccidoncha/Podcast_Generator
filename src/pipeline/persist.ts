import { prisma } from "@/db/client";
import { logger } from "@/lib/logger";
import { runEvals } from "@/evals/run-evals";
import type { Stage } from "./stage";
import type { EpisodeMeta, RankedArticle, Script } from "./types";
import type { SynthesisResult } from "./synthesize";

export type PersistInput = {
  articles: RankedArticle[];
  script: Script;
  synthesis: SynthesisResult;
};

export const persistStage: Stage<PersistInput, EpisodeMeta> = {
  name: "persist",

  async run({ articles, script, synthesis }, ctx) {
    const log = logger.child({ runId: ctx.runId });

    // Idempotency: if a previous attempt persisted this run's Episode, return
    // it instead of failing on the @unique runId constraint.
    const existing = await prisma.episode.findUnique({
      where: { runId: ctx.runId },
      include: { sources: true },
    });
    if (existing) {
      log.warn({ episodeId: existing.id }, "episode already persisted — returning existing");
      return {
        episodeId: existing.id,
        runId: existing.runId,
        audioUrl: existing.audioUrl,
        durationMs: existing.durationMs,
        costCents: existing.costCents,
        sources: existing.sources.map((s) => ({ url: s.url, title: s.title })),
      };
    }

    // Evals (Layers A + B + C). Layer A is in-process; B and C call gpt-4o-mini
    // in parallel, adding ~5-10s to the pipeline. Failures never block persist.
    let evalScoreJson: object | null = null;
    try {
      const report = await runEvals({
        script,
        articles,
        config: ctx.config,
        focusTopic: ctx.focusTopic ?? null,
        realDurationMs: synthesis.durationMs, // measured from the final mp3
      });
      evalScoreJson = report as unknown as object;
    } catch (evalErr) {
      log.warn({ evalErr }, "evals failed to run; persisting without scores");
    }

    // Atomic: Episode + Sources + Run.status=SUCCEEDED in one transaction so
    // an observer never sees a half-written episode.
    const episode = await prisma.$transaction(async (tx) => {
      const ep = await tx.episode.create({
        data: {
          runId: ctx.runId,
          audioUrl: synthesis.audioUrl,
          durationMs: synthesis.durationMs,
          costCents: synthesis.costCents,
          evalScoreJson: evalScoreJson ?? undefined,
          // Transcript with per-line timestamps — powers the Spotify-style
          // click-to-seek + highlight player on the episode detail page.
          scriptJson: synthesis.scriptWithTimings as unknown as object,
          sources: {
            create: articles.map((a) => ({
              url: a.url,
              title: a.title,
              publishedAt: a.publishedAt,
              snippet: a.snippet,
            })),
          },
        },
        include: { sources: true },
      });

      await tx.run.update({
        where: { id: ctx.runId },
        data: { status: "SUCCEEDED", finishedAt: new Date() },
      });

      return ep;
    });

    log.info(
      { episodeId: episode.id, sources: episode.sources.length },
      "episode persisted",
    );

    return {
      episodeId: episode.id,
      runId: episode.runId,
      audioUrl: episode.audioUrl,
      durationMs: episode.durationMs,
      costCents: episode.costCents,
      sources: episode.sources.map((s) => ({ url: s.url, title: s.title })),
    };
  },

  validate(meta) {
    if (!meta.episodeId) throw new Error("persist: empty episodeId");
  },
};
