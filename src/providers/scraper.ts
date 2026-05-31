import { logger } from "@/lib/logger";

// CLAUDE.md §2.4 + §8: scraping is a FALLBACK, not the default. Always prefer
// the news API. When you do scrape: respect robots.txt, set a real User-Agent,
// rate-limit, and never crash the pipeline if a site changes.

export type ScrapeResult = {
  url: string;
  title: string;
  body: string;
};

export type Scraper = {
  fetchArticle(url: string): Promise<ScrapeResult>;
};

const log = logger.child({ provider: "scraper" });

export const scraper: Scraper = {
  async fetchArticle(url) {
    log.warn({ url }, "scraper not implemented — falling back to empty body");
    return { url, title: "", body: "" };
  },
};
