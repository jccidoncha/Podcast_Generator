import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { logger } from "@/lib/logger";

const log = logger.child({ provider: "audio-stitch" });

const FFMPEG_PATH: string = (ffmpegStatic as unknown as string) || "ffmpeg";

// ElevenLabs returns CBR mp3 chunks (we always request `mp3_44100_128`), each
// padded with ~200-400ms of silence at start/end and at the voice's own
// loudness target. Naïve byte-concat preserves both the gaps and the
// loudness mismatches → the listener hears "cuts" between speakers and the
// quieter voice sounds weaker.
//
// Pipeline:
//   1. Per-chunk: trim leading+trailing silence, then loudnorm to a shared
//      target (-16 LUFS, podcast loudness). Measure the resulting duration.
//   2. Concat with `-c copy` so we never re-encode (preserves CBR codec).
//
// Returns per-chunk durations (in input order, 0 for failed/empty chunks) so
// the caller can build a transcript-with-timings for the UI.

export type StitchResult = {
  buffer: Buffer;
  durationMs: number; // measured from the stitched mp3
  chunkDurationsMs: number[]; // per input chunk, in input order
};

// CBR 128 kbps mp3 = 128_000 bits/sec = 16_000 bytes/sec.
const BYTES_PER_SECOND_AT_128K = 16_000;

function measureMs(buffer: Buffer): number {
  return Math.round((buffer.length / BYTES_PER_SECOND_AT_128K) * 1000);
}

export async function stitchMp3(buffers: Buffer[]): Promise<StitchResult> {
  const chunkDurationsMs = new Array(buffers.length).fill(0);
  const usable: Array<{ idx: number; buf: Buffer }> = buffers
    .map((buf, idx) => ({ idx, buf }))
    .filter(({ buf }) => buf.length > 0);

  if (usable.length === 0) {
    return { buffer: Buffer.alloc(0), durationMs: 0, chunkDurationsMs };
  }

  if (usable.length === 1) {
    try {
      const processed = await processChunk(usable[0].buf);
      const ms = measureMs(processed);
      chunkDurationsMs[usable[0].idx] = ms;
      return { buffer: processed, durationMs: ms, chunkDurationsMs };
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200) }, "loudnorm failed, returning raw");
      const ms = measureMs(usable[0].buf);
      chunkDurationsMs[usable[0].idx] = ms;
      return { buffer: usable[0].buf, durationMs: ms, chunkDurationsMs };
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), "podcast-stitch-"));
  try {
    // Pass 1: normalize each chunk in parallel; record each output's duration.
    const normalizedPaths: string[] = new Array(usable.length);
    await Promise.all(
      usable.map(async ({ idx, buf }, position) => {
        const outPath = join(workDir, `chunk_${position.toString().padStart(3, "0")}.mp3`);
        const processed = await processChunk(buf);
        await writeFile(outPath, processed);
        normalizedPaths[position] = outPath;
        chunkDurationsMs[idx] = measureMs(processed);
      }),
    );

    // Pass 2: concat demuxer, copy codec (no re-encode).
    const listPath = join(workDir, "concat.txt");
    await writeFile(
      listPath,
      normalizedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const outPath = join(workDir, "out.mp3");
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outPath,
    ]);
    const stitched = await readFile(outPath);
    const durationMs = measureMs(stitched);
    log.info(
      {
        chunks: buffers.length,
        kept: usable.length,
        totalBytes: stitched.length,
        durationMs,
      },
      "stitched mp3 (loudnorm + silenceremove + concat)",
    );
    return { buffer: stitched, durationMs, chunkDurationsMs };
  } catch (err) {
    log.warn(
      { err: String(err).slice(0, 200) },
      "ffmpeg pipeline failed, falling back to byte-concat",
    );
    // Fallback: byte-concat without processing. Per-chunk durations from raw.
    for (const { idx, buf } of usable) {
      chunkDurationsMs[idx] = measureMs(buf);
    }
    const buffer = Buffer.concat(usable.map(({ buf }) => buf));
    return { buffer, durationMs: measureMs(buffer), chunkDurationsMs };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Per-chunk: trim head/tail silence + loudnorm to -16 LUFS (podcast target).
// Output preserves the input codec/bitrate so the concat demuxer is happy.
async function processChunk(input: Buffer): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), "podcast-chunk-"));
  try {
    const inPath = join(workDir, "in.mp3");
    const outPath = join(workDir, "out.mp3");
    await writeFile(inPath, input);
    await runFfmpeg([
      "-y",
      "-i",
      inPath,
      "-af",
      "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:stop_periods=-1:stop_silence=0.1:stop_threshold=-50dB," +
        "loudnorm=I=-16:LRA=11:TP=-1.5",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "1",
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function _ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}
void _ensureDir;
