import Parser from "rss-parser";
import { logger } from "@/lib/logger";
import { resolveGoogleNewsUrl } from "./google-news-decoder";
import type { Article } from "@/pipeline/types";

// Google News exposes a hidden RSS endpoint for any search query. Free, no
// API key, broad coverage. Perfect for honouring the user's free-text
// interests — when they type "indie rock" or "F1" or "climate adaptation",
// the broad RSS feed list often won't have matching stories, but Google News
// search will pull them in from across the web.

const log = logger.child({ provider: "google-news" });
const parser = new Parser({ timeout: 8000 });

export type GoogleNewsProvider = {
  searchByTopic(topic: string, since: Date, limit?: number): Promise<Article[]>;
};

export const googleNewsProvider: GoogleNewsProvider = {
  async searchByTopic(topic, since, limit = 15) {
    const params = new URLSearchParams({
      q: topic,
      hl: "en-US",
      gl: "US",
      ceid: "US:en",
    });
    const url = `https://news.google.com/rss/search?${params}`;

    try {
      const feed = await parser.parseURL(url);
      // First filter + collect candidates synchronously, then resolve URLs in
      // parallel (one HTTP call to Google's batchexecute per item — bounded
      // by the per-interest `limit`).
      const candidates = feed.items
        .filter(
          (item): item is typeof item & { link: string; title: string } =>
            !!item.link && !!item.title,
        )
        .map((item) => {
          const publishedAt = item.isoDate ? new Date(item.isoDate) : new Date();
          return {
            wrapperUrl: item.link,
            title: item.title,
            publishedAt,
            snippet: stripHtml(item.contentSnippet ?? item.content ?? "").slice(0, 500),
          };
        })
        .filter((c) => c.publishedAt >= since)
        .slice(0, limit);

      const resolved = await Promise.all(
        candidates.map(async (c) => {
          const realUrl = await resolveGoogleNewsUrl(c.wrapperUrl);
          return { ...c, realUrl };
        }),
      );

      let resolvedCount = 0;
      const out: Article[] = resolved.map((c) => {
        const finalUrl = c.realUrl ?? c.wrapperUrl;
        if (c.realUrl) resolvedCount += 1;
        const hostSource = (() => {
          try {
            return new URL(finalUrl).hostname.replace(/^www\./, "");
          } catch {
            return "Google News";
          }
        })();
        return {
          url: finalUrl,
          title: c.title,
          source: extractSource(c.title) ?? hostSource,
          publishedAt: c.publishedAt,
          snippet: c.snippet,
          topic,
        };
      });

      log.info(
        { topic, count: out.length, resolved: resolvedCount, unresolved: out.length - resolvedCount },
        "google news searched",
      );
      return out;
    } catch (err) {
      log.warn({ topic, err: String(err).slice(0, 200) }, "google news search failed");
      return [];
    }
  },
};

// Google News titles are often suffixed with " - <Outlet Name>"; pull that
// out so we get a readable source instead of the literal "Google News".
function extractSource(title: string): string | null {
  const m = title.match(/ - ([^-]+)$/);
  return m ? m[1].trim() : null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
