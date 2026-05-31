import { openaiProvider } from "@/providers";
import { logger } from "@/lib/logger";
import type { Stage } from "./stage";
import type { RankedArticle, Script } from "./types";

export const scriptStage: Stage<RankedArticle[], Script> = {
  name: "script",

  async run(articles, ctx) {
    const log = logger.child({ runId: ctx.runId });
    log.info(
      {
        articles: articles.length,
        targetMin: ctx.config.targetLengthMin,
        style: ctx.config.style,
        density: ctx.config.density,
        language: ctx.config.language,
      },
      "generating script",
    );

    const script = await openaiProvider.generateScript({
      articles,
      tone: ctx.config.tone,
      style: ctx.config.style,
      density: ctx.config.density,
      language: ctx.config.language,
      format: ctx.config.format,
      targetLengthMin: ctx.config.targetLengthMin,
      focusTopic: ctx.focusTopic ?? null,
      primaryVoiceId: ctx.config.voice,
      secondaryVoiceId: ctx.config.secondaryVoice,
      interests: ctx.interests,
    });

    log.info(
      { segments: script.segments.length, estDurationMs: script.estimatedDurationMs },
      "script ready",
    );
    return script;
  },

  validate(script) {
    if (script.segments.length === 0) throw new Error("script: no segments");
    if (!script.intro.trim()) throw new Error("script: empty intro");
    if (!script.outro.trim()) throw new Error("script: empty outro");
  },
};
