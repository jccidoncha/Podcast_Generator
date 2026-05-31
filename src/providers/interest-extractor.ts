import OpenAI from "openai";
import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";

// Natural-language interest extraction. The user writes how they describe
// their interests in their own words — "Me va el indie rock, sobre todo
// Vetusta Morla, y sigo la F1 con cariño a Alonso" — and we ask gpt-4o (with
// web_search for proper nouns it might not know) to pull out distinct,
// concrete interests with weights and context strings. Each result is what
// the rank + script stages have always wanted: a topic name + a sentence
// describing what it IS.
//
// This replaces the comma-separated input, which forced users to think in
// SEO-keyword form and produced bare strings the pipeline couldn't really
// frame correctly.

const log = logger.child({ provider: "interest-extractor" });
const MODEL = "gpt-4o";

export type ExtractedInterest = {
  topic: string; // canonical, short label (the rank stage uses this verbatim)
  weight: number; // 0.1–1.0 inferred from emphasis in the description
  context: string; // one sentence describing what the topic IS
};

export type InterestExtractor = {
  extract(description: string): Promise<ExtractedInterest[]>;
};

export const interestExtractor: InterestExtractor = {
  async extract(description) {
    const trimmed = description.trim();
    if (!trimmed) return [];

    if (isDryRun() || !config.OPENAI_API_KEY) {
      // Crude fallback for tests: split commas, no context, weight 1.
      return trimmed
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10)
        .map((t) => ({ topic: t, weight: 1, context: `Topic: ${t}.` }));
    }

    try {
      // OpenAI SDK accepts an AbortSignal so a hung Responses-API call
      // (web_search can occasionally take 30+ s) doesn't keep the Next.js
      // route open forever — the browser eventually drops the connection and
      // the user sees "Failed to fetch" with no useful info.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45_000);

      const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

      // Responses API + web_search_preview so the model can verify niche
      // names (artists, athletes, products) it doesn't already know. Returns
      // free-form JSON; we parse defensively.
      const response = await client.responses
        .create(
          {
            model: MODEL,
            tools: [{ type: "web_search_preview" }],
            input: `A listener wrote this description of what they want to hear about in their personal news podcast:

"""
${trimmed}
"""

Your job: extract DISTINCT interests they care about and return them as JSON.

For each interest:
- "topic": short canonical label (3 words max). Use the proper name for people/brands ("Shaboozey", "Vetusta Morla"), the common name for sports/leagues ("F1", "La Liga"), the natural phrase for concepts ("climate adaptation policy").
- "weight": 0.1–1.0 inferred from emphasis in the text. The first thing they mention or describe enthusiastically gets ~1.0; passing mentions ~0.4.
- "context": ONE sentence (≤30 words) describing exactly what this is. Use web search for any name you're not 100% sure about. Be specific: "American country/hip-hop singer-songwriter" not "an artist".

Rules:
- Each interest is its own entry. If they mention "indie rock and especially Vetusta Morla", that's TWO entries: "indie rock" (the genre) and "Vetusta Morla" (the band).
- Don't invent interests they didn't mention.
- Don't merge unrelated things. "F1" and "Alonso" can be separate (the league + the specific driver).
- 10 entries max.

Return ONLY a JSON object: { "interests": [{ "topic": "...", "weight": 0.8, "context": "..." }, ...] }. No prose around it.`,
          },
          { signal: ctrl.signal },
        )
        .finally(() => clearTimeout(timer));

      const text = (response.output_text ?? "").trim();
      const parsed = safeParseJson(text);
      if (!parsed || !Array.isArray(parsed.interests)) {
        log.warn({ rawHead: text.slice(0, 200) }, "extractor returned non-conforming JSON");
        return [];
      }

      const out: ExtractedInterest[] = [];
      for (const item of parsed.interests) {
        if (!isExtracted(item)) continue;
        out.push({
          topic: item.topic.trim(),
          weight: clamp(item.weight, 0.1, 1.0),
          context: item.context.trim(),
        });
      }

      log.info({ count: out.length }, "extracted interests");
      return out;
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200) }, "extract failed");
      return [];
    }
  },
};

function isExtracted(x: unknown): x is ExtractedInterest {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.topic === "string" &&
    typeof o.weight === "number" &&
    typeof o.context === "string"
  );
}

function safeParseJson(text: string): { interests?: unknown[] } | null {
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
