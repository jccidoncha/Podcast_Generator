import { describe, expect, it, vi } from "vitest";
import { runStage, type Stage } from "@/pipeline/stage";
import type { RunContext } from "@/pipeline/types";

const ctx: RunContext = {
  runId: "test-run",
  userId: "u1",
  interests: [],
  config: {
    userId: "u1",
    voice: "rachel",
    secondaryVoice: null,
    targetLengthMin: 8,
    tone: "conversational",
    cadenceCron: "0 8 * * *",
    style: "news_roundup",
    density: "detailed",
    language: "en",
    format: "solo",
  },
  now: new Date("2026-05-29T00:00:00Z"),
};

describe("runStage", () => {
  it("returns the output of run on success", async () => {
    const stage: Stage<number, number> = {
      name: "double",
      async run(n) {
        return n * 2;
      },
    };
    expect(await runStage(stage, 5, ctx)).toBe(10);
  });

  it("invokes validate and retries when it throws", async () => {
    const run = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(7);
    const stage: Stage<void, number> = {
      name: "must-be-positive",
      run: run as unknown as Stage<void, number>["run"],
      validate(out) {
        if (out <= 0) throw new Error("non-positive");
      },
    };
    const out = await runStage(stage, undefined, ctx, 3);
    expect(out).toBe(7);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows", async () => {
    const stage: Stage<void, number> = {
      name: "always-fails",
      async run() {
        throw new Error("boom");
      },
    };
    await expect(runStage(stage, undefined, ctx, 2)).rejects.toThrow(/always-fails.*boom/);
  });
});
