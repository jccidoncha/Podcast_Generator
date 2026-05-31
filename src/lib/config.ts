// Load .env before reading process.env. Next.js does this on its own for the
// web app; this import covers the worker and any tsx-launched scripts
// (eval harness, etc.). dotenv is idempotent — it never overwrites vars that
// are already set, so it's safe to import everywhere.
import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // External services — all optional so the project builds and runs in dry-run
  // without any keys. Real impl must check `isDryRun()` before using these.
  OPENAI_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  NEWS_API_KEY: z.string().optional(),

  // DB
  DATABASE_URL: z.string().optional(),

  // Worker. Default ticks every minute — the tick only does a per-user
  // schedule check (one DB query for users with scheduleEnabled), so the
  // cost is negligible and it makes scheduled runs fire within ~60s of the
  // user's chosen time instead of up to 15 min late.
  WORKER_CRON: z.string().default("* * * * *"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === "true"),

  // Storage (prod)
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function load(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const config: AppConfig = load();
