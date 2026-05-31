import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";
import type { Article } from "@/pipeline/types";

// NewsAPI keyword search. Per CLAUDE.md §2.4 it is the cheap shortlister
// alongside RSS. Returns [] silently when no key is present so the pipeline
// degrades to RSS-only rather than failing.

export type NewsSearchParams = {
  topic: string;
  since: Date;
  pageSize?: number;
};

export type NewsProvider = {
  search(params: NewsSearchParams): Promise<Article[]>;
};

const log = logger.child({ provider: "news" });

type NewsApiArticle = {
  url?: string;
  title?: string | null;
  description?: string | null;
  publishedAt?: string;
  source?: { name?: string };
};

export const newsProvider: NewsProvider = {
  async search({ topic, since, pageSize = 10 }) {
    if (isDryRun() || !config.NEWS_API_KEY) {
      log.debug({ topic }, "no key or dry-run: skipping NewsAPI");
      return [];
    }

    const params = new URLSearchParams({
      q: topic,
      from: since.toISOString(),
      sortBy: "publishedAt",
      pageSize: String(pageSize),
      language: "en",
    });

    const res = await fetch(`https://newsapi.org/v2/everything?${params}`, {
      headers: { "X-Api-Key": config.NEWS_API_KEY },
    });
    if (!res.ok) {
      log.warn({ status: res.status, topic }, "newsapi failed");
      return [];
    }

    const json = (await res.json()) as { articles?: NewsApiArticle[] };
    const articles: Article[] = (json.articles ?? [])
      .filter((a): a is NewsApiArticle & { url: string; title: string } =>
        Boolean(a.url && a.title),
      )
      .map((a) => ({
        url: a.url,
        title: a.title,
        source: a.source?.name ?? "NewsAPI",
        publishedAt: a.publishedAt ? new Date(a.publishedAt) : new Date(),
        snippet: a.description ?? "",
        topic,
      }));

    log.info({ topic, articles: articles.length }, "newsapi search");
    return articles;
  },
};
