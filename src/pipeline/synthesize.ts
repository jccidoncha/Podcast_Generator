import { elevenlabsProvider, stitchMp3, storageProvider } from "@/providers";
import type { TtsChunk } from "@/providers/elevenlabs";
import { personaFor } from "@/providers/voice-personas";
import { logger } from "@/lib/logger";
import { NonRetriableError, type Stage } from "./stage";
import type {
  PodcastConfig,
  Script,
  ScriptWithTimings,
  Speaker,
  TimedLine,
  TimedSegment,
} from "./types";

export type SynthesisResult = {
  audioUrl: string;
  durationMs: number;
  costCents: number;
  scriptWithTimings: ScriptWithTimings;
};

// Each chunk = ONE LINE (or intro/outro). The 1:1 mapping with the script
// lets us build per-line timestamps so the transcript UI can highlight the
// active line and let the user click to seek.
type LineChunk = TtsChunk & {
  role: "intro" | "segment" | "outro";
  segmentIdx: number; // 0..N for segment lines; -1 for intro/outro
  lineIdx: number; // index within the segment; 0 for intro/outro
  speaker: Speaker;
  speakerName: string;
  sourceUrl: string;
};

export const synthesizeStage: Stage<Script, SynthesisResult> = {
  name: "synthesize",

  async run(script, ctx) {
    const log = logger.child({ runId: ctx.runId });

    const chunks = buildLineChunks(script, ctx.config);
    const results = await elevenlabsProvider.synthesizeMany(chunks);

    const succeeded = results.filter((r) => !r.failed);
    const failedIdx = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.failed)
      .map(({ i }) => i);

    if (succeeded.length === 0) {
      // Surface the first underlying ElevenLabs error so the caller knows
      // WHY everything failed (429, 401, network) instead of an opaque
      // "all chunks failed".
      const firstFailed = results.find((r): r is { failed: true; error: string } => r.failed);
      const reason = firstFailed?.error ?? "no chunk error captured";

      // Auth / quota errors are PERMANENT for this run — don't let the stage
      // orchestrator retry 3× and waste more attempts (or burn into a fresh
      // quota when it resets mid-flight).
      if (
        reason.includes("quota_exceeded") ||
        reason.includes("401 ") ||
        reason.includes("invalid_api_key")
      ) {
        throw new NonRetriableError(
          `ElevenLabs quota/auth blocked synthesis: ${reason.slice(0, 300)}`,
        );
      }

      throw new Error(`synthesize: all ${chunks.length} chunks failed — first error: ${reason}`);
    }
    if (failedIdx.length > 0) {
      log.warn({ failedIdx, succeeded: succeeded.length }, "some chunks failed");
    }

    const { buffer, durationMs, chunkDurationsMs } = await stitchMp3(
      results.map((r) => (r.failed ? Buffer.alloc(0) : r.audio)),
    );

    const estimatedDurationMs = succeeded.reduce(
      (sum, r) => sum + (r.failed ? 0 : r.durationMs),
      0,
    );
    const costCents = succeeded.reduce(
      (sum, r) => sum + (r.failed ? 0 : r.costCents),
      0,
    );

    const audioUrl = await storageProvider.put(
      `episodes/${ctx.runId}.mp3`,
      buffer,
      "audio/mpeg",
    );

    const scriptWithTimings = buildScriptWithTimings(script, chunks, chunkDurationsMs);

    log.info(
      {
        audioUrl,
        chunks: chunks.length,
        failed: failedIdx.length,
        durationMs,
        estimatedDurationMs,
        durationDriftSec: Math.round((estimatedDurationMs - durationMs) / 1000),
        costCents,
        bytes: buffer.length,
      },
      "synthesized and stored",
    );

    return { audioUrl, durationMs, costCents, scriptWithTimings };
  },

  validate(result) {
    if (!result.audioUrl) throw new Error("synthesize: empty audioUrl");
    if (result.durationMs <= 0) throw new Error("synthesize: non-positive duration");
  },
};

// Build chunks at LINE granularity (no merging). Each chunk maps 1:1 to a
// script line so we can compute per-line timestamps after stitching.
//
// Intro and outro are always primary voice (per the prompt contract).
function buildLineChunks(script: Script, config: PodcastConfig): LineChunk[] {
  const primary = personaFor(config.voice);
  const secondary = config.secondaryVoice ? personaFor(config.secondaryVoice) : null;
  const voiceFor = (s: Speaker) =>
    s === "primary" ? config.voice : config.secondaryVoice ?? config.voice;
  const nameFor = (s: Speaker) =>
    s === "primary" ? primary.name : (secondary?.name ?? primary.name);

  const chunks: LineChunk[] = [];

  chunks.push({
    text: script.intro,
    voice: config.voice,
    role: "intro",
    segmentIdx: -1,
    lineIdx: 0,
    speaker: "primary",
    speakerName: primary.name,
    sourceUrl: "",
  });

  for (let si = 0; si < script.segments.length; si++) {
    const seg = script.segments[si];
    for (let li = 0; li < seg.lines.length; li++) {
      const line = seg.lines[li];
      chunks.push({
        text: line.text,
        voice: voiceFor(line.speaker),
        role: "segment",
        segmentIdx: si,
        lineIdx: li,
        speaker: line.speaker,
        speakerName: nameFor(line.speaker),
        sourceUrl: line.sourceUrl,
      });
    }
  }

  chunks.push({
    text: script.outro,
    voice: config.voice,
    role: "outro",
    segmentIdx: -1,
    lineIdx: 0,
    speaker: "primary",
    speakerName: primary.name,
    sourceUrl: "",
  });

  return chunks;
}

// Assemble per-line timings from per-chunk durations. Chunks are 1:1 with
// script lines (built by buildLineChunks above), so we walk both in order.
function buildScriptWithTimings(
  script: Script,
  chunks: LineChunk[],
  chunkDurationsMs: number[],
): ScriptWithTimings {
  let cursorMs = 0;
  const advance = (idx: number): [number, number] => {
    const start = cursorMs;
    const dur = chunkDurationsMs[idx] ?? 0;
    cursorMs += dur;
    return [start, cursorMs];
  };

  // The chunks are ordered: intro (0), then segments lines in order, then outro.
  // We mirror that order to walk durations.
  let chunkPos = 0;

  const [introStart, introEnd] = advance(chunkPos);
  const introChunk = chunks[chunkPos];
  const introTimed: TimedLine = {
    text: script.intro,
    sourceUrl: "",
    speaker: "primary",
    speakerName: introChunk.speakerName,
    startMs: introStart,
    endMs: introEnd,
  };
  chunkPos += 1;

  const segments: TimedSegment[] = script.segments.map((seg) => ({
    topic: seg.topic,
    lines: seg.lines.map((line) => {
      const [s, e] = advance(chunkPos);
      const ch = chunks[chunkPos];
      chunkPos += 1;
      return {
        text: line.text,
        sourceUrl: line.sourceUrl,
        speaker: line.speaker,
        speakerName: ch.speakerName,
        startMs: s,
        endMs: e,
      };
    }),
  }));

  const [outroStart, outroEnd] = advance(chunkPos);
  const outroChunk = chunks[chunkPos];
  const outroTimed: TimedLine = {
    text: script.outro,
    sourceUrl: "",
    speaker: "primary",
    speakerName: outroChunk.speakerName,
    startMs: outroStart,
    endMs: outroEnd,
  };

  return {
    version: "v1",
    intro: introTimed,
    segments,
    outro: outroTimed,
    totalDurationMs: cursorMs,
  };
}
