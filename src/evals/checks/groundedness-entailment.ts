import OpenAI from "openai";
import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";
import type { Article, Script } from "@/pipeline/types";
import type { CheckResult } from "../types";

// Layer B: per-claim entailment with 5 verdicts.
//
// Earlier versions confused "not in article body" with "hallucinated". A
// podcast host can correctly say "Verstappen, the four-time world champion"
// even if THIS specific article doesn't say "four-time world champion" — it's
// background knowledge any listener already accepts. That's not invention.
//
// 5 buckets:
//   no_claim          → conversational/reaction line, no factual claim
//   supported         → claim literally or near-literally in the article
//   paraphrase        → claim true to article intent, light rewording
//   general_knowledge → claim plausibly true (background) but NOT in article
//   hallucinated      → claim CONTRADICTS the article OR invents specific
//                       facts (numbers/dates/quotes/events) not present and
//                       not plausibly known general knowledge
//
// Hallucination rate = hallucinated / (supported + paraphrase +
//   general_knowledge + hallucinated). PASS = ≥ 0.95 (i.e. ≤5% invented).
//
// general_knowledge is tracked separately so the dashboard can warn if a
// script over-relies on the model's training data instead of the actual
// sources — that's a quality concern but a different one than fabrication.

const log = logger.child({ scope: "evals", check: "groundedness-entailment" });
const MODEL = "gpt-4o-mini";
const PASS_THRESHOLD = 0.95;

type Verdict =
  | "no_claim"
  | "supported"
  | "paraphrase"
  | "general_knowledge"
  | "hallucinated";

const BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idx", "verdict"],
        properties: {
          idx: { type: "integer" },
          verdict: {
            type: "string",
            enum: [
              "no_claim",
              "supported",
              "paraphrase",
              "general_knowledge",
              "hallucinated",
            ],
          },
        },
      },
    },
  },
} as const;

type BatchResponse = {
  results: Array<{ idx: number; verdict: Verdict }>;
};

type Claim = { idx: number; text: string };

export async function checkGroundednessEntailment(
  script: Script,
  articles: Article[],
): Promise<CheckResult> {
  type LineRef = { globalIdx: number; text: string; sourceUrl: string };
  const allLines: LineRef[] = [];
  let cursor = 0;
  for (const seg of script.segments) {
    for (const line of seg.lines) {
      allLines.push({ globalIdx: cursor, text: line.text, sourceUrl: line.sourceUrl });
      cursor += 1;
    }
  }

  if (allLines.length === 0) {
    return { name: "groundedness-entailment", passed: false, detail: "no lines" };
  }

  if (isDryRun() || !config.OPENAI_API_KEY) {
    return {
      name: "groundedness-entailment",
      passed: true,
      detail: "skipped (dry-run or no api key)",
      measurements: { skipped: 1 },
    };
  }

  const articlesByUrl = new Map(articles.map((a) => [a.url, a]));
  const groups = new Map<string, LineRef[]>();
  for (const line of allLines) {
    const list = groups.get(line.sourceUrl) ?? [];
    list.push(line);
    groups.set(line.sourceUrl, list);
  }

  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const verdicts = new Map<number, Verdict>();

  await Promise.all(
    [...groups.entries()].map(async ([url, lines]) => {
      const article = articlesByUrl.get(url);
      if (!article) {
        // URL not in the article set at all → either the line cites something
        // it shouldn't, or it's a citation typo. Mark as hallucinated.
        for (const l of lines) verdicts.set(l.globalIdx, "hallucinated");
        return;
      }
      // Use body if it has real content; otherwise fall back to snippet. We
      // use `||` not `??` because Jina returns "" (not null) on a fetch
      // failure, and `??` wouldn't fall through.
      const usableBody = (article.body && article.body.trim().length > 100)
        ? article.body
        : article.snippet;
      const body = (usableBody || "").slice(0, 8000);
      if (!body.trim()) {
        // No body AND no snippet — can't verify; charitable paraphrase.
        for (const l of lines) verdicts.set(l.globalIdx, "paraphrase");
        return;
      }
      const claims: Claim[] = lines.map((l, i) => ({ idx: i, text: l.text }));
      try {
        const batch = await judgeBatch(client, article.title, body, claims);
        for (const { idx, verdict } of batch.results) {
          const lineRef = lines[idx];
          if (lineRef) verdicts.set(lineRef.globalIdx, verdict);
        }
      } catch (err) {
        log.warn(
          { url, err: String(err).slice(0, 200) },
          "entailment batch failed — marking paraphrase",
        );
        for (const l of lines) verdicts.set(l.globalIdx, "paraphrase");
      }
    }),
  );

  // Tally.
  let noClaim = 0;
  let supported = 0;
  let paraphrase = 0;
  let generalKnowledge = 0;
  let hallucinated = 0;
  for (const line of allLines) {
    const v = verdicts.get(line.globalIdx) ?? "paraphrase";
    if (v === "no_claim") noClaim += 1;
    else if (v === "supported") supported += 1;
    else if (v === "paraphrase") paraphrase += 1;
    else if (v === "general_knowledge") generalKnowledge += 1;
    else hallucinated += 1;
  }
  const factualLines = supported + paraphrase + generalKnowledge + hallucinated;
  const hallucinationRate = factualLines === 0 ? 0 : hallucinated / factualLines;
  const score = 1 - hallucinationRate;
  const passed = score >= PASS_THRESHOLD;

  log.info(
    {
      total: allLines.length,
      noClaim,
      supported,
      paraphrase,
      generalKnowledge,
      hallucinated,
      factualLines,
      hallucinationRate: hallucinationRate.toFixed(3),
      score: score.toFixed(3),
    },
    "entailment complete",
  );

  return {
    name: "groundedness-entailment",
    passed,
    detail: passed
      ? `${hallucinated}/${factualLines} factual claims invented (${(hallucinationRate * 100).toFixed(0)}%)`
      : `${hallucinated}/${factualLines} factual claims invented (${(hallucinationRate * 100).toFixed(0)}%) — score ${score.toFixed(2)} below ${PASS_THRESHOLD}`,
    score,
    measurements: {
      totalLines: allLines.length,
      noClaim,
      supported,
      paraphrase,
      generalKnowledge,
      hallucinated,
      factualLines,
      hallucinationRate,
    },
  };
}

async function judgeBatch(
  client: OpenAI,
  articleTitle: string,
  articleBody: string,
  claims: Claim[],
): Promise<BatchResponse> {
  const numbered = claims.map((c) => `[${c.idx}] ${c.text}`).join("\n");

  const completion = await client.chat.completions.create({
    model: MODEL,
    response_format: {
      type: "json_schema",
      json_schema: { name: "EntailmentBatch", strict: true, schema: BATCH_SCHEMA },
    },
    messages: [
      {
        role: "system",
        content: `You verify podcast script lines against a source news article. You judge whether each line is invented, not whether it's literally a copy of the article.

Return ONE verdict per line:

- "no_claim": conversational/reactive line with no factual claim ("Right.", "Yeah, exactly.", "Wait — hold on.", "So what does that mean for...", transitional phrases, host banter, generic opinions/feelings).

- "supported": factual claim that's literally or near-literally in the article body.

- "paraphrase": factual claim true to article intent, just reworded for natural speech.

- "general_knowledge": factual claim that ISN'T in the article body BUT is plausibly true and commonly known background context (e.g. "Verstappen, the four-time world champion" / "Madrid, capital of Spain" / "the EU, a 27-country bloc"). The model is using prior knowledge to add accurate context. Not invention.

- "hallucinated": claim CONTRADICTS the article OR invents specific facts (numbers, dates, quotes, named events, named people) that are not in the article AND not plausibly commonly known. Reserve this for actual fabrication.

Decision flow:
  1. Is this conversational glue? → no_claim
  2. Is this claim in the article? → supported / paraphrase
  3. Is this claim NOT in the article but you (a reasonable reader) would accept it as true background? → general_knowledge
  4. Otherwise → hallucinated

Be liberal with no_claim and general_knowledge. Be strict with hallucinated.`,
      },
      {
        role: "user",
        content: `ARTICLE TITLE: ${articleTitle}

ARTICLE BODY:
"""
${articleBody}
"""

LINES TO CLASSIFY (one per line, [idx] prefix):
${numbered}

For each line, return its idx and verdict.`,
      },
    ],
  });
  const raw = completion.choices[0]?.message.content;
  if (!raw) throw new Error("empty batch response");
  return JSON.parse(raw) as BatchResponse;
}
