import OpenAI from "openai";
import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";
import type { Article, Interest } from "@/pipeline/types";

export type ResearchParams = {
  interests: Interest[];
  since: Date;
  perInterest: number;
};

export type Researcher = {
  research(params: ResearchParams): Promise<Article[]>;
};

const log = logger.child({ provider: "researcher" });

// gpt-4o + web_search_preview is the agent-with-search loop. The Responses
// API lets the model issue multiple search calls and synthesize, returning
// final text + citations. We force the final text to be JSON we can parse
// into Article[]. CLAUDE.md §2.4 records the decision and its tradeoffs.
const MODEL = "gpt-4o";

export const researcher: Researcher = {
  async research({ interests, since, perInterest }) {
    if (isDryRun() || !config.OPENAI_API_KEY) {
      log.debug({ interests: interests.length }, "dry-run: returning canned articles");
      return cannedArticles(interests, since, perInterest);
    }

    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    const sinceISO = since.toISOString();
    const topicList = interests
      .map((i) => `- ${i.topic} (weight ${i.weight})`)
      .join("\n");

    const prompt = `You are a research agent for a personal news podcast.

Find the most relevant, fresh news articles for these user interests:
${topicList}

Hard rules:
- Only articles published AFTER ${sinceISO}.
- Target ${perInterest} articles per topic; give higher-weight topics proportionally more.
- Every article MUST have a real, working URL you actually found via web_search. NEVER invent URLs.
- Prefer primary sources and reputable outlets. Drop paywalls, sponsored content, and listicles.
- Each article's "topic" field MUST match one of the user's interest topics verbatim.

Return ONLY a JSON object with this exact shape, no prose, no markdown fences:
{
  "articles": [
    {
      "url": "https://...",
      "title": "...",
      "source": "Outlet name",
      "publishedAt": "ISO-8601 datetime",
      "snippet": "1-3 sentence summary grounded in the article",
      "topic": "one of the user's interest topics, verbatim"
    }
  ]
}`;

    log.info({ model: MODEL, interests: interests.length }, "running research agent");

    const response = await client.responses.create({
      model: MODEL,
      tools: [{ type: "web_search_preview" }],
      input: prompt,
    });

    const text = response.output_text ?? "";
    const parsed = safeParseJson(text);
    if (!parsed || !Array.isArray(parsed.articles)) {
      throw new Error(
        `researcher: model returned non-conforming JSON: ${text.slice(0, 200)}`,
      );
    }

    const articles: Article[] = [];
    for (const item of parsed.articles) {
      if (!isCandidate(item)) continue;
      articles.push({
        url: item.url,
        title: item.title,
        source: item.source ?? "Unknown",
        publishedAt: new Date(item.publishedAt),
        snippet: item.snippet ?? "",
        topic: item.topic,
      });
    }

    log.info({ count: articles.length, dropped: parsed.articles.length - articles.length }, "research complete");
    return articles;
  },
};

type Candidate = {
  url: string;
  title: string;
  source?: string;
  publishedAt: string;
  snippet?: string;
  topic: string;
};

function isCandidate(a: unknown): a is Candidate {
  if (!a || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.url === "string" &&
    typeof o.title === "string" &&
    typeof o.publishedAt === "string" &&
    typeof o.topic === "string"
  );
}

function safeParseJson(text: string): { articles?: unknown[] } | null {
  // Be defensive about markdown fences even though the prompt forbids them.
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function cannedArticles(
  interests: Interest[],
  since: Date,
  perInterest: number,
): Article[] {
  const now = new Date();
  const out: Article[] = [];
  for (const interest of interests) {
    for (let i = 0; i < perInterest; i++) {
      out.push({
        url: `https://example.com/${slug(interest.topic)}-${i + 1}`,
        title: `${capitalize(interest.topic)}: development #${i + 1} this week`,
        source: "Example News",
        publishedAt: new Date(
          Math.max(since.getTime(), now.getTime() - (i + 1) * 3600_000),
        ),
        snippet: `Recent developments in ${interest.topic}. The agent would synthesize from web_search results here.`,
        topic: interest.topic,
      });
    }
  }
  return out;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
