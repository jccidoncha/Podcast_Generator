import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { enricher } from "@/providers";
import { checkGroundednessEntailment } from "@/evals/checks/groundedness-entailment";
import { config } from "@/lib/config";
import type { Article, Script, ScriptWithTimings } from "@/pipeline/types";

// Standalone re-evaluation: take an existing episode's scriptJson + sources,
// re-fetch the article bodies via Jina (we don't persist bodies), and run
// the new 4-verdict entailment check. Reports hallucination rate on the
// factual claims (ignoring conversational glue).
//
// Usage:
//   pnpm exec tsx scripts/reeval-entailment.ts <episodeId?>
//   (omit episodeId to use the latest episode)

async function main() {
  const prisma = new PrismaClient();
  const episodeId = process.argv[2];

  const ep = episodeId
    ? await prisma.episode.findUnique({
        where: { id: episodeId },
        include: { sources: true },
      })
    : await prisma.episode.findFirst({
        orderBy: { createdAt: "desc" },
        include: { sources: true },
      });

  if (!ep) {
    console.log("episode not found");
    await prisma.$disconnect();
    return;
  }

  if (!ep.scriptJson) {
    console.log(`episode ${ep.id} has no scriptJson — can't re-evaluate`);
    await prisma.$disconnect();
    return;
  }

  console.log(`Re-evaluating episode ${ep.id} (${ep.sources.length} sources)`);
  console.log(`Fetching ${ep.sources.length} article bodies via Jina…`);

  const articles: Article[] = await Promise.all(
    ep.sources.map(async (s) => {
      const body = await enricher.fetchFullText(s.url).catch(() => "");
      return {
        url: s.url,
        title: s.title,
        source: "",
        publishedAt: s.publishedAt ?? new Date(),
        snippet: s.snippet ?? "",
        body,
        topic: "",
      };
    }),
  );
  const withBody = articles.filter((a) => (a.body ?? "").length > 200).length;
  console.log(`  ${withBody}/${articles.length} articles enriched (>200 chars)`);

  // Reconstruct a plain Script shape from the timed scriptJson.
  const timed = ep.scriptJson as unknown as ScriptWithTimings;
  const script: Script = {
    intro: timed.intro.text,
    segments: timed.segments.map((s) => ({
      topic: s.topic,
      lines: s.lines.map((l) => ({
        text: l.text,
        sourceUrl: l.sourceUrl,
        speaker: l.speaker,
      })),
    })),
    outro: timed.outro.text,
    estimatedDurationMs: timed.totalDurationMs,
  };

  console.log(`\nRunning entailment on ${countLines(script)} lines…`);
  const t0 = Date.now();
  const result = await checkGroundednessEntailment(script, articles);
  const ms = Date.now() - t0;

  console.log(`\nDone in ${(ms / 1000).toFixed(1)}s`);
  console.log("============================================");
  console.log("ENTAILMENT BREAKDOWN");
  console.log("============================================");
  const m = result.measurements as Record<string, number> | undefined;
  if (m) {
    console.log(`  Total lines:           ${m.totalLines}`);
    console.log(`  No claim (glue):       ${m.noClaim}   (${pct(m.noClaim, m.totalLines)})`);
    console.log(`  Factual lines:         ${m.factualLines}`);
    console.log(`    ↳ supported:         ${m.supported}   (${pct(m.supported, m.factualLines)}) in article body literally`);
    console.log(`    ↳ paraphrase:        ${m.paraphrase}   (${pct(m.paraphrase, m.factualLines)}) in article body, reworded`);
    console.log(`    ↳ general_knowledge: ${m.generalKnowledge ?? 0}   (${pct(m.generalKnowledge ?? 0, m.factualLines)}) plausibly true, not in source`);
    console.log(`    ↳ hallucinated:      ${m.hallucinated}   (${pct(m.hallucinated, m.factualLines)}) INVENTED or contradicts ← the one that matters`);
    console.log();
    console.log(`  Hallucination rate:    ${(m.hallucinationRate * 100).toFixed(1)}%`);
    console.log(`  Score (1 - rate):      ${result.score?.toFixed(3)}`);
    console.log(`  Pass (≥0.95):          ${result.passed ? "✓" : "✗"}`);
  }

  await prisma.$disconnect();
}

function countLines(s: Script): number {
  return s.segments.reduce((n, seg) => n + seg.lines.length, 0);
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${((num / denom) * 100).toFixed(0)}%`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
