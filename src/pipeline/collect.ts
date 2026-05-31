import { googleNewsProvider, newsProvider, rssProvider } from "@/providers";
import { logger } from "@/lib/logger";
import type { Stage } from "./stage";
import type { Article, RunContext } from "./types";

const MIN_ARTICLES = 5;
// Cap Google News per-interest yield so a single interest doesn't drown out
// the others. 12 × N interests + RSS gives plenty of variety.
const GOOGLE_NEWS_PER_INTEREST = 12;

export const collectStage: Stage<void, Article[]> = {
  name: "collect",

  async run(_input, ctx) {
    const log = logger.child({ runId: ctx.runId });
    const since = cadenceWindowStart(ctx);

    // Three parallel sources:
    //  - rss: broad coverage by category (tech, science, world, sports, etc.)
    //  - googleNews: keyword search per user interest — this is what makes
    //    free-text interests like "indie rock" actually surface relevant news.
    //  - newsapi: same idea but uses the NewsAPI key when present.
    // All run via Promise.allSettled so any source failing degrades gracefully.
    const [rssResult, ...perInterestResults] = await Promise.allSettled([
      rssProvider.fetchAll(since),
      ...ctx.interests.flatMap((i) => [
        googleNewsProvider.searchByTopic(i.topic, since, GOOGLE_NEWS_PER_INTEREST),
        newsProvider.search({ topic: i.topic, since, pageSize: 10 }),
      ]),
    ]);

    const rss = rssResult.status === "fulfilled" ? rssResult.value : [];
    let googleCount = 0;
    let newsapiCount = 0;
    const perInterest: Article[] = [];
    for (let i = 0; i < perInterestResults.length; i++) {
      const r = perInterestResults[i];
      if (r.status !== "fulfilled") continue;
      // Even-index = google news, odd-index = newsapi (matches the flatMap order).
      if (i % 2 === 0) googleCount += r.value.length;
      else newsapiCount += r.value.length;
      perInterest.push(...r.value);
    }

    const combined = dedupeByUrl([...rss, ...perInterest]);

    log.info(
      {
        rss: rss.length,
        googleNews: googleCount,
        newsapi: newsapiCount,
        deduped: combined.length,
        interests: ctx.interests.length,
      },
      "collected candidates",
    );
    return combined;
  },

  validate(articles) {
    if (articles.length < MIN_ARTICLES) {
      throw new Error(`collect: only ${articles.length} candidates (min ${MIN_ARTICLES})`);
    }
  },
};

function dedupeByUrl(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const a of articles) {
    const key = canonicalize(a.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

function cadenceWindowStart(ctx: RunContext): Date {
  // CLAUDE.md §8: cadence window keeps episodes from repeating yesterday's
  // stories. Stub uses 24h; a real impl parses ctx.config.cadenceCron.
  const since = new Date(ctx.now);
  since.setHours(since.getHours() - 24);
  return since;
}
