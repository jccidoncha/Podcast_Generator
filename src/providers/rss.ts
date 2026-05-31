import Parser from "rss-parser";
import { logger } from "@/lib/logger";
import type { Article } from "@/pipeline/types";

// Broad, reliable feeds across categories (tech, world, science, culture,
// sports, markets) so embeddings-based ranking has material for whichever
// interests the user defines. Ranking (MMR + embeddings) does the matching —
// we don't try to map feeds → topics up front.
const FEEDS = [
  // Tech
  "https://www.theverge.com/rss/index.xml",
  "https://feeds.arstechnica.com/arstechnica/index",
  "https://techcrunch.com/feed/",
  "https://hnrss.org/frontpage",
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  // World / politics
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.aljazeera.com/xml/rss/all.xml",
  // Science / space
  "https://www.nasa.gov/news-release/feed/",
  "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  // Culture / music / entertainment
  "https://pitchfork.com/rss/news/",
  "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
  // Sports
  "https://feeds.bbci.co.uk/sport/rss.xml",
  // Markets / business
  "https://feeds.bbci.co.uk/news/business/rss.xml",
];

const log = logger.child({ provider: "rss" });
const parser = new Parser({ timeout: 8000 });

export type RssProvider = {
  fetchAll(since: Date): Promise<Article[]>;
};

export const rssProvider: RssProvider = {
  async fetchAll(since) {
    const results = await Promise.allSettled(FEEDS.map((url) => fetchFeed(url, since)));
    const articles: Article[] = [];
    let failed = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        articles.push(...r.value);
      } else {
        failed += 1;
        log.warn({ feed: FEEDS[i], err: String(r.reason).slice(0, 200) }, "feed fetch failed");
      }
    }
    log.info(
      { feeds: FEEDS.length, failed, articles: articles.length },
      "rss collected",
    );
    return articles;
  },
};

async function fetchFeed(url: string, since: Date): Promise<Article[]> {
  const feed = await parser.parseURL(url);
  const source = feed.title ?? new URL(url).hostname;
  const out: Article[] = [];
  for (const item of feed.items) {
    if (!item.link || !item.title) continue;
    const publishedAt = item.isoDate ? new Date(item.isoDate) : new Date();
    if (publishedAt < since) continue;
    out.push({
      url: item.link,
      title: item.title,
      source,
      publishedAt,
      snippet: stripHtml(item.contentSnippet ?? item.content ?? "").slice(0, 500),
      topic: "", // assigned by the rank stage based on best matching interest
    });
  }
  return out;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
