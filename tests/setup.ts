// Force dry-run for all tests so providers never hit real APIs.
// CLAUDE.md §12: "Don't trigger real OpenAI/ElevenLabs calls in tests".
process.env.DRY_RUN = "true";
// vitest sets NODE_ENV=test already; LOG_LEVEL is ours to set.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
