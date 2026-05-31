import { describe, expect, it } from "vitest";
import { stitchMp3 } from "@/providers/audio-stitch";

// stitchMp3 tries ffmpeg first (loudnorm + silenceremove + concat) and falls
// back to byte-concat when ffmpeg can't parse the input. The test stubs use
// non-mp3 buffers, so the fallback is what we actually exercise here.
describe("stitchMp3 (ffmpeg fallback path)", () => {
  it("concatenates non-empty buffers in order", async () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.from([4, 5, 6]);
    const result = await stitchMp3([a, b]);
    expect(result.buffer).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips empty buffers (failed chunks) without breaking order", async () => {
    const a = Buffer.from([1, 2, 3]);
    const empty = Buffer.alloc(0);
    const c = Buffer.from([4, 5, 6]);
    const result = await stitchMp3([a, empty, c]);
    expect(result.buffer).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("returns an empty buffer when all chunks failed", async () => {
    const result = await stitchMp3([Buffer.alloc(0), Buffer.alloc(0)]);
    expect(result.buffer).toEqual(Buffer.alloc(0));
    expect(result.durationMs).toBe(0);
  });
});
