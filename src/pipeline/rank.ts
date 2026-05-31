import { embeddingsProvider } from "@/providers";
import { recentSourceUrls } from "@/db/history";
import { logger } from "@/lib/logger";
import type { Stage } from "./stage";
import type { Article, Interest, RankedArticle } from "./types";

// MMR balances relevance to user interests and diversity within the selection.
// λ ∈ [0, 1]: 1 = pure relevance (greedy top-k), 0 = pure diversity.
// 0.7 is the standard starting point — biases toward relevance with enough
// diversity to avoid 5 articles about the same news event.
const LAMBDA = 0.7;
const TOP_N = 6;
// Weighting between semantic relevance and freshness. Both already ∈ [0,1].
const RELEVANCE_WEIGHT = 0.8;
const RECENCY_WEIGHT = 0.2;
// Drop articles that already appeared in any of this user's episodes in the
// last N days. Prevents the same news cycling forever. If the filter would
// leave us with fewer than TOP_N, we relax it (better to repeat a story than
// produce no podcast).
const HISTORY_WINDOW_DAYS = 7;
// Hard filter thresholds. When focusTopic is set, articles whose cosine to
// the focus is below FOCUS_MIN_SIM are dropped entirely (not just demoted).
// Without a focus, we still require a minimum match to ANY user interest so
// completely off-topic articles can't sneak into the top-N just because the
// pool is small.
const FOCUS_MIN_SIM = 0.3;
const INTEREST_MIN_SIM = 0.1;
// When a user picks a focus topic ("Shaboozey episode"), coherence beats
// length: better a tight 3-segment episode entirely about the focus than a
// 6-segment episode where half is unrelated AI/F1/whatever. We accept down to
// MIN_FOCUS_SEGMENTS articles above-threshold and only fall back to the wider
// pool if we'd otherwise have nothing to talk about.
const MIN_FOCUS_SEGMENTS = 2;
// Loosened threshold used only when above-FOCUS_MIN_SIM yields < MIN_FOCUS_SEGMENTS.
// Still tight enough to keep clearly off-topic stories out.
const FOCUS_RELAX_SIM = 0.18;

export const rankStage: Stage<Article[], RankedArticle[]> = {
  name: "rank",

  async run(articles, ctx) {
    const log = logger.child({ runId: ctx.runId });
    if (articles.length === 0) return [];

    // Filter out articles whose URLs appeared in recent episodes for this user.
    // If the filter is too aggressive (would leave us with too few), fall back
    // to the full pool so the pipeline never produces zero results.
    const seen = await recentSourceUrls(ctx.userId, HISTORY_WINDOW_DAYS);
    const fresh = articles.filter((a) => !seen.has(a.url));
    const pool = fresh.length >= TOP_N ? fresh : articles;
    log.info(
      {
        all: articles.length,
        recentlyUsed: articles.length - fresh.length,
        pool: pool.length,
        usingFallback: pool === articles && fresh.length < TOP_N,
      },
      "history-aware filter",
    );

    // Embed every interest + every article in one batch. Interest vectors use
    // `topic + context` (not just topic) so the semantic match knows what the
    // term actually IS — e.g. "shaboozey: American country/hip-hop singer-
    // songwriter" matches articles about him much more sharply than the bare
    // word "shaboozey", which can drift into noise.
    const interestEmbeddingText = ctx.interests.map((i) =>
      i.context ? `${i.topic}. ${i.context}` : i.topic,
    );
    const articleTexts = pool.map((a) =>
      `${a.title}. ${a.snippet}`.slice(0, 1500),
    );
    const embeddings = await embeddingsProvider.embedMany([
      ...interestEmbeddingText,
      ...articleTexts,
    ]);
    const interestVecs = embeddings.slice(0, interestEmbeddingText.length);
    const articleVecs = embeddings.slice(interestEmbeddingText.length);

    // If a focus topic is set, we embed it too.
    const focusVec = ctx.focusTopic
      ? (await embeddingsProvider.embedMany([ctx.focusTopic]))[0]
      : null;

    // Per-article scoring: best-matching interest (weighted) + raw focus sim.
    const rawInterestSim: number[] = [];
    const focusSims: number[] = [];
    const matchedTopic: string[] = [];
    for (const av of articleVecs) {
      let bestSim = -Infinity;
      let bestIdx = 0;
      for (let i = 0; i < interestVecs.length; i++) {
        const sim = cosine(av, interestVecs[i]) * ctx.interests[i].weight;
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
      rawInterestSim.push(Math.max(0, bestSim));
      focusSims.push(focusVec ? Math.max(0, cosine(av, focusVec)) : 0);
      matchedTopic.push(ctx.interests[bestIdx]?.topic ?? "general");
    }

    // Hard filter: when focus is set, drop articles below FOCUS_MIN_SIM.
    // Without focus, drop articles below INTEREST_MIN_SIM. We track relax
    // events so the dashboard can surface them.
    const candidateIdx: number[] = [];
    let filterRelaxed = false;
    if (focusVec) {
      // Focus mode: coherence > length. Accept ABOVE-threshold matches even
      // if that means fewer than TOP_N segments — a tight 3-segment Shaboozey
      // episode beats a 6-segment one that drifts into AI/F1/etc.
      for (let i = 0; i < pool.length; i++) {
        if (focusSims[i] >= FOCUS_MIN_SIM) candidateIdx.push(i);
      }
      if (candidateIdx.length < MIN_FOCUS_SEGMENTS) {
        // Real scarcity — fall back to a SOFTER threshold (still tight) so
        // the episode has something to talk about, but never to "no
        // threshold". This guarantees we never pad a focus episode with
        // clearly off-topic noise.
        filterRelaxed = true;
        candidateIdx.length = 0;
        for (let i = 0; i < pool.length; i++) {
          if (focusSims[i] >= FOCUS_RELAX_SIM) candidateIdx.push(i);
        }
        // Truly empty after the soft threshold? Take the top-3-by-focus from
        // the full pool as a last-ditch (and log loudly via filterRelaxed).
        if (candidateIdx.length === 0) {
          const byFocus = pool
            .map((_, i) => i)
            .sort((a, b) => focusSims[b] - focusSims[a])
            .slice(0, MIN_FOCUS_SEGMENTS);
          for (const i of byFocus) candidateIdx.push(i);
        }
      }
    } else {
      for (let i = 0; i < pool.length; i++) {
        if (rawInterestSim[i] >= INTEREST_MIN_SIM) candidateIdx.push(i);
      }
      if (candidateIdx.length < TOP_N) {
        filterRelaxed = true;
        candidateIdx.length = 0;
        const byInterest = pool
          .map((_, i) => i)
          .sort((a, b) => rawInterestSim[b] - rawInterestSim[a]);
        for (const i of byInterest) candidateIdx.push(i);
      }
    }

    // Score over the candidate set.
    const candidateVecs = candidateIdx.map((i) => articleVecs[i]);
    const candidateRelevance = candidateIdx.map((i) => {
      let r = rawInterestSim[i];
      // Focus boost on top of the hard filter — focus-aligned candidates
      // still rank above marginally-aligned ones.
      if (focusVec) r = r * (0.3 + 0.7 * focusSims[i]);
      return r;
    });
    const candidateRecency = candidateIdx.map((i) =>
      freshness(pool[i].publishedAt, ctx.now, 24),
    );
    const baseScore = candidateRelevance.map(
      (r, i) => RELEVANCE_WEIGHT * r + RECENCY_WEIGHT * candidateRecency[i],
    );

    // MMR over the candidate set.
    const selectedLocal = mmr(baseScore, candidateVecs, LAMBDA, TOP_N);
    const selected = selectedLocal.map((j) => candidateIdx[j]);

    const ranked: RankedArticle[] = selected.map((idx, j) => ({
      ...pool[idx],
      topic: matchedTopic[idx],
      score: baseScore[selectedLocal[j]],
    }));

    const avgPairwiseSim = averagePairwiseSim(selectedLocal, candidateVecs);
    log.info(
      {
        in: pool.length,
        candidates: candidateIdx.length,
        kept: ranked.length,
        lambda: LAMBDA,
        avgPairwiseSim: avgPairwiseSim.toFixed(3),
        focusActive: !!focusVec,
        filterRelaxed,
        avgFocusSim: focusVec
          ? (selected.reduce((s, i) => s + focusSims[i], 0) / selected.length).toFixed(3)
          : null,
      },
      "ranked",
    );
    return ranked;
  },

  validate(ranked) {
    if (ranked.length === 0) throw new Error("rank: empty result");
  },
};

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

export function mmr(
  score: number[],
  vecs: number[][],
  lambda: number,
  topN: number,
): number[] {
  const selected: number[] = [];
  const remaining = new Set(score.map((_, i) => i));
  while (selected.length < topN && remaining.size > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const j of selected) {
        const sim = cosine(vecs[i], vecs[j]);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * score[i] - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }
  return selected;
}

function freshness(publishedAt: Date, now: Date, windowHours: number): number {
  const ageHours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  if (ageHours < 0) return 1;
  return Math.max(0, 1 - ageHours / windowHours);
}

function averagePairwiseSim(idx: number[], vecs: number[][]): number {
  if (idx.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < idx.length; i++) {
    for (let j = i + 1; j < idx.length; j++) {
      sum += cosine(vecs[idx[i]], vecs[idx[j]]);
      pairs += 1;
    }
  }
  return sum / pairs;
}

// Exported for potential tests / debugging visibility into matched interests.
export function bestMatchingInterest(
  articleVec: number[],
  interestVecs: number[][],
  interests: Interest[],
): { topic: string; sim: number } {
  let bestSim = -Infinity;
  let bestIdx = 0;
  for (let i = 0; i < interestVecs.length; i++) {
    const sim = cosine(articleVec, interestVecs[i]) * interests[i].weight;
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
    }
  }
  return { topic: interests[bestIdx]?.topic ?? "general", sim: bestSim };
}
