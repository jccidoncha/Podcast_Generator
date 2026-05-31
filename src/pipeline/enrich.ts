import { enricher } from "@/providers";
import { logger } from "@/lib/logger";
import type { Stage } from "./stage";
import type { RankedArticle } from "./types";

const PARALLELISM = 4;
const MIN_USEFUL_BODY = 200;

export const enrichStage: Stage<RankedArticle[], RankedArticle[]> = {
  name: "enrich",

  async run(articles, ctx) {
    const log = logger.child({ runId: ctx.runId });

    // Bounded parallelism so we don't hammer Jina.
    const out: RankedArticle[] = new Array(articles.length);
    for (let i = 0; i < articles.length; i += PARALLELISM) {
      const slice = articles.slice(i, i + PARALLELISM);
      const enriched = await Promise.all(
        slice.map(async (a) => {
          try {
            const body = await enricher.fetchFullText(a.url);
            return { ...a, body };
          } catch (err) {
            log.warn({ url: a.url, err: String(err).slice(0, 200) }, "enrich failed");
            return a;
          }
        }),
      );
      for (let j = 0; j < enriched.length; j++) {
        out[i + j] = enriched[j];
      }
    }

    const withBody = out.filter((a) => (a.body ?? "").length >= MIN_USEFUL_BODY).length;
    log.info(
      { total: out.length, withBody, parallelism: PARALLELISM },
      "enriched",
    );
    return out;
  },

  validate(articles) {
    if (articles.length === 0) throw new Error("enrich: empty");
  },
};
