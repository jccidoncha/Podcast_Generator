import OpenAI from "openai";
import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";

// When the user types a bare term like "shaboozey" or "F1 racing" or
// "indie rock", the script-writer has no clue what kind of thing it is — a
// person, a sport, a music genre — and ends up using generic framings
// ("a topic called shaboozey"). This provider classifies each interest in
// one short sentence so we can thread that context into the prompts. Result:
// "Shaboozey: American country/hip-hop artist whose track 'A Bar Song' ..."
//
// Uses the Responses API with web_search_preview so it can correctly
// classify recent / niche terms (artists, products, athletes) that the base
// model doesn't know about. gpt-4o-mini alone returns useless answers for
// anything post-training-cutoff or under-the-radar.

const log = logger.child({ provider: "interest-enricher" });
const MODEL = "gpt-4o";

export type InterestEnricher = {
  describe(topic: string): Promise<string | null>;
};

export const interestEnricher: InterestEnricher = {
  async describe(topic) {
    const trimmed = topic.trim();
    if (!trimmed) return null;

    if (isDryRun() || !config.OPENAI_API_KEY) {
      return `Topic: ${trimmed}.`;
    }

    try {
      const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: MODEL,
        tools: [{ type: "web_search_preview" }],
        input: `In ONE short sentence (≤30 words), describe what "${trimmed}" refers to in current news and pop culture. Use web search if you're not 100% sure.

Be SPECIFIC about the category:
- For a person: "American country rap artist (real name Collins Obinna Chibueze)", not just "a person".
- For a sport / league: "Formula 1 motor racing championship", not just "a sport".
- For a company / product: "AI coding assistant by Anthropic", not just "a company".
- For a place: "Capital of Spain", not just "a city".
- For a topic / movement: "movement to adapt to rising temperatures", not just "a topic".

Pick the most likely current-events meaning and commit to it. Reply with ONLY the sentence, no quotes or preamble.`,
      });
      const text = (response.output_text ?? "").trim();
      if (!text) return null;
      log.debug({ topic: trimmed, context: text.slice(0, 80) }, "enriched interest");
      return text;
    } catch (err) {
      log.warn({ topic: trimmed, err: String(err).slice(0, 200) }, "enrich failed");
      return null;
    }
  },
};
