import { config } from "./config";

// CLAUDE.md §11 / §12: tests, evals, and CI MUST NOT call real OpenAI /
// ElevenLabs. Providers check this before any paid request.
export function isDryRun(): boolean {
  return config.DRY_RUN || config.NODE_ENV === "test";
}
