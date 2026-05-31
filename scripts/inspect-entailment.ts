import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { enricher } from "@/providers";
import { config } from "@/lib/config";
import type { ScriptWithTimings } from "@/pipeline/types";

// Diagnostic version of the entailment check: prints each line's verdict +
// rationale so we can manually spot-check whether the judge is too strict
// or the script really invents stuff.

const MODEL = "gpt-4o-mini";
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idx", "verdict", "rationale"],
        properties: {
          idx: { type: "integer" },
          verdict: {
            type: "string",
            enum: ["no_claim", "supported", "paraphrase", "general_knowledge", "hallucinated"],
          },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;

async function main() {
  if (!config.OPENAI_API_KEY) throw new Error("need OPENAI_API_KEY");

  const prisma = new PrismaClient();
  const episodeId = process.argv[2];
  const ep = episodeId
    ? await prisma.episode.findUnique({ where: { id: episodeId }, include: { sources: true } })
    : await prisma.episode.findFirst({ orderBy: { createdAt: "desc" }, include: { sources: true } });

  if (!ep?.scriptJson) {
    console.log("no episode / no scriptJson");
    await prisma.$disconnect();
    return;
  }

  const timed = ep.scriptJson as unknown as ScriptWithTimings;
  console.log(`Episode ${ep.id}, fetching ${ep.sources.length} bodies via Jina…`);

  const bodies = new Map<string, { title: string; body: string }>();
  await Promise.all(
    ep.sources.map(async (s) => {
      const body = await enricher.fetchFullText(s.url).catch(() => "");
      bodies.set(s.url, {
        title: s.title,
        body: body && body.trim().length > 100 ? body : (s.snippet ?? ""),
      });
    }),
  );

  // Flatten lines by source.
  type LineRow = {
    globalIdx: number;
    segmentTopic: string;
    speaker: string;
    speakerName: string;
    text: string;
    sourceUrl: string;
  };
  const all: LineRow[] = [];
  let cursor = 0;
  for (const seg of timed.segments) {
    for (const l of seg.lines) {
      all.push({
        globalIdx: cursor++,
        segmentTopic: seg.topic,
        speaker: l.speaker,
        speakerName: l.speakerName,
        text: l.text,
        sourceUrl: l.sourceUrl,
      });
    }
  }

  const byUrl = new Map<string, LineRow[]>();
  for (const r of all) {
    const list = byUrl.get(r.sourceUrl) ?? [];
    list.push(r);
    byUrl.set(r.sourceUrl, list);
  }

  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const verdicts = new Map<number, { verdict: string; rationale: string }>();

  await Promise.all(
    [...byUrl.entries()].map(async ([url, lines]) => {
      const article = bodies.get(url);
      if (!article || !article.body.trim()) {
        for (const l of lines) verdicts.set(l.globalIdx, { verdict: "no_body", rationale: "no body to compare" });
        return;
      }
      const numbered = lines.map((l, i) => `[${i}] ${l.text}`).join("\n");
      const completion = await client.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_schema", json_schema: { name: "EB", strict: true, schema: SCHEMA } },
        messages: [
          {
            role: "system",
            content: `Verify podcast lines against article. Verdicts:
- no_claim: glue/reactive ("Right.", "Wait—", transitions, opinions).
- supported: claim literally in article.
- paraphrase: claim true to article, reworded.
- general_knowledge: claim NOT in article but plausibly true background (e.g. "Verstappen, Red Bull driver").
- hallucinated: contradicts OR invents specific facts (numbers/dates/quotes/people) not plausibly known.
Give a SHORT rationale (≤15 words).`,
          },
          {
            role: "user",
            content: `ARTICLE TITLE: ${article.title}\n\nARTICLE BODY:\n"""\n${article.body.slice(0, 8000)}\n"""\n\nLINES:\n${numbered}\n\nReturn JSON.`,
          },
        ],
      });
      const raw = completion.choices[0]?.message.content;
      if (!raw) return;
      const parsed = JSON.parse(raw) as { results: Array<{ idx: number; verdict: string; rationale: string }> };
      for (const r of parsed.results) {
        const line = lines[r.idx];
        if (line) verdicts.set(line.globalIdx, { verdict: r.verdict, rationale: r.rationale });
      }
    }),
  );

  // Output by verdict.
  const buckets = new Map<string, LineRow[]>();
  for (const r of all) {
    const v = verdicts.get(r.globalIdx)?.verdict ?? "unknown";
    const list = buckets.get(v) ?? [];
    list.push(r);
    buckets.set(v, list);
  }

  console.log();
  console.log("Counts:");
  for (const [v, list] of buckets) {
    console.log(`  ${v.padEnd(20)} ${list.length}`);
  }

  // Print all HALLUCINATED lines with rationale so we can judge whether
  // the judge is right or being too strict.
  console.log();
  console.log("============================================");
  console.log("HALLUCINATED LINES (judge's view):");
  console.log("============================================");
  const hall = buckets.get("hallucinated") ?? [];
  for (const r of hall) {
    const v = verdicts.get(r.globalIdx)!;
    console.log(`\n[${r.speakerName}] ${r.text}`);
    console.log(`  → ${v.rationale}`);
    console.log(`  source: ${r.sourceUrl.slice(0, 70)}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
