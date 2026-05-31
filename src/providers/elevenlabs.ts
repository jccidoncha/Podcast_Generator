import { config } from "@/lib/config";
import { isDryRun } from "@/lib/dry-run";
import { logger } from "@/lib/logger";

export type SynthesizeSpeechParams = {
  text: string;
  voice: string;
};

export type SynthesizeSpeechResult = {
  audio: Buffer;
  durationMs: number;
  costCents: number;
};

export type SynthesizeChunkResult =
  | (SynthesizeSpeechResult & { failed: false })
  | { failed: true; error: string };

export type TtsChunk = { text: string; voice: string };

export type ElevenLabsProvider = {
  synthesizeSpeech(params: SynthesizeSpeechParams): Promise<SynthesizeSpeechResult>;
  synthesizeMany(chunks: TtsChunk[]): Promise<SynthesizeChunkResult[]>;
};

const log = logger.child({ provider: "elevenlabs" });

const VOICE_IDS: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  adam: "pNInz6obpgDQGcFmaJgB",
  aria: "9BWtsMINqrJLrRacOk9x",
};
const DEFAULT_VOICE_ID = VOICE_IDS.rachel;

const MODEL_ID = "eleven_multilingual_v2";
// CBR mp3 frames at the same codec/bitrate/sample-rate are byte-concatable.
// Asking for the same output format on every chunk is what makes the stitcher
// in audio-stitch.ts safe to use without re-encoding.
const OUTPUT_FORMAT = "mp3_44100_128";

const COST_PER_1K_CHARS_CENTS = 30;
const CHARS_PER_SECOND = 14;

export const elevenlabsProvider: ElevenLabsProvider = {
  async synthesizeSpeech({ text, voice }) {
    if (isDryRun() || !config.ELEVENLABS_API_KEY) {
      log.debug({ chars: text.length, voice }, "dry-run: returning canned audio");
      return cannedSynthesis(text);
    }
    return realSynthesis(text, voice);
  },

  async synthesizeMany(chunks) {
    const voiceCounts: Record<string, number> = {};
    for (const c of chunks) voiceCounts[c.voice] = (voiceCounts[c.voice] ?? 0) + 1;
    log.info({ chunks: chunks.length, byVoice: voiceCounts }, "synthesizing chunks");

    if (isDryRun() || !config.ELEVENLABS_API_KEY) {
      return chunks.map((c) => ({ ...cannedSynthesis(c.text), failed: false as const }));
    }

    // Concurrency cap: per-line chunks can mean 60+ TTS calls. ElevenLabs
    // free tier allows 2 concurrent, Creator 5, Pro 10. We use 3 by default —
    // safe for Creator-and-above without throttling, conservative enough to
    // dodge most 429 bursts. Per-chunk retry (in realSynthesis) handles the
    // remaining transient failures.
    const CONCURRENCY = 3;
    const results = new Array<SynthesizeChunkResult>(chunks.length);
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const batch = chunks.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map((c, j) => {
          const globalIdx = i + j;
          return realSynthesis(
            c.text,
            c.voice,
            chunks[globalIdx - 1]?.text,
            chunks[globalIdx + 1]?.text,
          );
        }),
      );
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        const globalIdx = i + j;
        if (r.status === "fulfilled") {
          results[globalIdx] = { ...r.value, failed: false };
        } else {
          const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
          log.warn(
            { chunkIndex: globalIdx, voice: chunks[globalIdx].voice, error },
            "chunk synthesis failed",
          );
          results[globalIdx] = { failed: true, error };
        }
      }
    }
    return results;
  },
};

// Per-call timeout: a hung TTS call shouldn't block the worker forever.
const TTS_TIMEOUT_MS = 60_000;
// Transient HTTP statuses worth retrying. 429 = rate limit, 5xx = server-side
// hiccup, 408 = explicit timeout.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES_PER_CHUNK = 3;

async function realSynthesis(
  text: string,
  voice: string,
  previousText?: string,
  nextText?: string,
): Promise<SynthesizeSpeechResult> {
  const voiceId = VOICE_IDS[voice] ?? DEFAULT_VOICE_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`;

  // Cap context length — ElevenLabs accepts up to ~1000 chars; we send less to
  // keep payload small.
  const PREV_NEXT_MAX = 600;
  const body = JSON.stringify({
    text,
    model_id: MODEL_ID,
    // Tuned for podcast dialogue. See voice_settings notes in CLAUDE.md.
    voice_settings: {
      stability: 0.4,
      similarity_boost: 0.85,
      style: 0.4,
      use_speaker_boost: true,
    },
    ...(previousText ? { previous_text: previousText.slice(-PREV_NEXT_MAX) } : {}),
    ...(nextText ? { next_text: nextText.slice(0, PREV_NEXT_MAX) } : {}),
  });

  let lastErr: Error = new Error("elevenlabs: no attempts made");
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_CHUNK; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": config.ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
          accept: "audio/mpeg",
        },
        body,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const errMsg = `elevenlabs: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`;
        if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES_PER_CHUNK) {
          // Backoff with jitter so concurrent retries don't all hit at once.
          const wait = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
          log.warn({ status: res.status, attempt, wait }, "tts retrying");
          await new Promise((r) => setTimeout(r, wait));
          lastErr = new Error(errMsg);
          continue;
        }
        throw new Error(errMsg);
      }

      const audio = Buffer.from(await res.arrayBuffer());
      const durationMs = Math.round((text.length / CHARS_PER_SECOND) * 1000);
      const costCents = Math.round((text.length / 1000) * COST_PER_1K_CHARS_CENTS);
      return { audio, durationMs, costCents };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES_PER_CHUNK && lastErr.name === "AbortError") {
        log.warn({ attempt }, "tts call timed out — retrying");
        continue;
      }
      if (attempt >= MAX_RETRIES_PER_CHUNK) break;
      // Non-HTTP error (network reset, etc.): same backoff treatment.
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function cannedSynthesis(text: string): SynthesizeSpeechResult {
  const durationMs = Math.round((text.length / CHARS_PER_SECOND) * 1000);
  const costCents = Math.round((text.length / 1000) * COST_PER_1K_CHARS_CENTS);
  const audio = Buffer.from("RIFF....WAVEfmt stub", "utf8");
  return { audio, durationMs, costCents };
}
