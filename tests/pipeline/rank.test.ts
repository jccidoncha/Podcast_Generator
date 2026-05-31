import { describe, expect, it } from "vitest";
import { cosine, mmr } from "@/pipeline/rank";

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
});

describe("mmr", () => {
  // 3 vectors: a and b near-identical, c orthogonal. With λ=0.5 we expect MMR
  // to pick (a, c) — the best one plus the most diverse — not (a, b).
  const a = [1, 0, 0];
  const b = [0.99, 0.01, 0]; // near-identical to a
  const c = [0, 1, 0]; // orthogonal
  const vecs = [a, b, c];
  const baseScore = [0.9, 0.85, 0.6];

  it("with lambda=1.0 picks pure top-relevance order", () => {
    const out = mmr(baseScore, vecs, 1.0, 3);
    expect(out).toEqual([0, 1, 2]);
  });

  it("with lambda=0.5 picks the diverse pair over the near-duplicate", () => {
    const out = mmr(baseScore, vecs, 0.5, 2);
    expect(out[0]).toBe(0); // best relevance first
    expect(out[1]).toBe(2); // c is diverse from a, b is too similar
  });

  it("respects topN cap", () => {
    const out = mmr(baseScore, vecs, 0.7, 1);
    expect(out).toHaveLength(1);
  });
});
