import OpenAI from "openai";
import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";

const log = logger.child({ provider: "embeddings" });
const MODEL = "text-embedding-3-small";
const DIM = 1536;

export type EmbeddingsProvider = {
  embedMany(texts: string[]): Promise<number[][]>;
};

export const embeddingsProvider: EmbeddingsProvider = {
  async embedMany(texts) {
    if (texts.length === 0) return [];
    if (isDryRun() || !config.OPENAI_API_KEY) {
      // Random unit vectors for dry-run. Cosine sims will scatter near zero,
      // which is enough for the MMR + ranking code paths to exercise without
      // spending API credits.
      log.debug({ count: texts.length }, "dry-run: random embeddings");
      return texts.map(() => randomUnitVector(DIM));
    }

    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    const res = await client.embeddings.create({ model: MODEL, input: texts });
    log.info({ count: texts.length, model: MODEL }, "embedded");
    return res.data.map((d) => d.embedding);
  },
};

function randomUnitVector(dim: number): number[] {
  const v = Array.from({ length: dim }, () => Math.random() - 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
