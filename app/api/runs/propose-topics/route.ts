import { NextResponse } from "next/server";
import { loadUserContext } from "@/db/context";
import { collectStage } from "@/pipeline/collect";
import { rankStage } from "@/pipeline/rank";
import { runStage } from "@/pipeline/stage";
import { logger } from "@/lib/logger";
import type { RankedArticle, RunContext } from "@/pipeline/types";

const DEMO_USER_ID = "demo-user";

export const dynamic = "force-dynamic";

// Run the cheap half of the pipeline (collect + rank, no enrich/script/TTS)
// and propose 3 thematically distinct stories the user can pick from. Picking
// one drives a Generate with focusTopic = chosen topic / article title.
//
// Latency: ~10-15s. No TTS, no LLM script. Embeddings cost is trivial.
export async function POST() {
  const { config, interests } = await loadUserContext(DEMO_USER_ID);
  if (interests.length === 0) {
    return NextResponse.json(
      { error: "no interests configured — finish onboarding first" },
      { status: 400 },
    );
  }

  const ctx: RunContext = {
    runId: "propose-" + Math.random().toString(36).slice(2, 8),
    userId: DEMO_USER_ID,
    interests,
    config,
    now: new Date(),
    focusTopic: null,
  };

  const log = logger.child({ scope: "propose-topics", runId: ctx.runId });

  try {
    const articles = await runStage(collectStage, undefined, ctx);
    const ranked = await runStage(rankStage, articles, ctx);
    const proposals = buildProposals(ranked);
    log.info({ proposals: proposals.length }, "topics proposed");
    return NextResponse.json({ proposals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "propose-topics failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type Proposal = {
  topic: string; // user's interest topic this story maps to
  headline: string; // representative article title
  summary: string; // short blurb (snippet of top article)
  articleCount: number;
  source: string;
};

function buildProposals(ranked: RankedArticle[]): Proposal[] {
  // Group by topic (already assigned by rank). Pick top article per topic as
  // the representative. Cap at 3 to keep the UI focused.
  const byTopic = new Map<string, RankedArticle[]>();
  for (const a of ranked) {
    const list = byTopic.get(a.topic) ?? [];
    list.push(a);
    byTopic.set(a.topic, list);
  }
  const proposals: Proposal[] = [...byTopic.entries()]
    .map(([topic, items]) => {
      items.sort((a, b) => b.score - a.score);
      const top = items[0];
      return {
        topic,
        headline: top.title,
        summary: top.snippet.slice(0, 200),
        articleCount: items.length,
        source: top.source,
      };
    })
    .sort((a, b) => b.articleCount - a.articleCount)
    .slice(0, 3);
  return proposals;
}
