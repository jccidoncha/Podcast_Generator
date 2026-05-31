import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { elevenlabsProvider } from "@/providers";

// One-off: generates a ~10s sample mp3 for each available voice and writes
// them to public/audio/voice-samples/. The onboarding wizard plays these so
// the user can pick a voice without spending TTS credits on demo runs.
//
// Re-run only when adding a new voice or changing the sample script.
// Coste estimado: ~$0.30 total (3 voces × ~250 chars).

const SAMPLE_TEXT =
  "Hi, this is a quick preview of how your podcast will sound. " +
  "I'll walk you through the news that matter to you, with a clear voice and steady pace. " +
  "If this voice feels right, pick it and we'll start your first episode.";

const VOICES = ["rachel", "adam", "aria"] as const;

const OUTPUT_DIR = join(process.cwd(), "public/voice-samples");

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const voice of VOICES) {
    console.log(`> ${voice}...`);
    const { audio, durationMs, costCents } = await elevenlabsProvider.synthesizeSpeech({
      text: SAMPLE_TEXT,
      voice,
    });
    const file = join(OUTPUT_DIR, `${voice}.mp3`);
    await writeFile(file, audio);
    console.log(
      `  wrote ${file}  (${(audio.length / 1024).toFixed(1)} KB, ~${Math.round(durationMs / 1000)}s, ~$${(costCents / 100).toFixed(2)})`,
    );
  }

  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
