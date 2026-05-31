import pino from "pino";
import { config } from "./config";

// pino-pretty spawns a worker thread that Next.js cannot bundle into its
// server build → "Cannot find module '.next/server/vendor-chunks/lib/worker.js'"
// crashes the route. We only enable the pretty transport when we're NOT
// inside the Next.js runtime (i.e. the standalone worker + scripts via tsx).
// Inside Next.js we fall back to plain JSON logs — still readable in the
// terminal, no crashes.
const inNextRuntime = !!process.env.NEXT_RUNTIME;

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "*.OPENAI_API_KEY",
      "*.ELEVENLABS_API_KEY",
      "*.NEWS_API_KEY",
      "*.DATABASE_URL",
      "*.S3_ACCESS_KEY_ID",
      "*.S3_SECRET_ACCESS_KEY",
      'headers["authorization"]',
    ],
    censor: "[redacted]",
  },
  ...(config.NODE_ENV === "development" && !inNextRuntime
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});
