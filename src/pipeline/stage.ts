import { logger } from "@/lib/logger";
import type { RunContext } from "./types";

// A pipeline Stage is a small object: a name, a `run` function, and an
// optional `validate` that catches malformed outputs before they propagate.
// Using objects (not bare functions) gives us:
//   1. a single place to write the stage name → consistent logging,
//   2. typed validation invocable by the orchestrator,
//   3. a stable shape to add cross-cutting concerns later (metrics, evals).
export interface Stage<I, O> {
  name: string;
  run(input: I, ctx: RunContext): Promise<O>;
  // Throw to mark the output invalid. The orchestrator will retry the stage.
  validate?(output: O): void;
}

// Throw this to tell `runStage` not to retry — the failure is permanent
// (quota exhausted, missing credentials, etc.) and retrying just burns more
// API calls or time without any chance of success.
export class NonRetriableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NonRetriableError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runStage<I, O>(
  stage: Stage<I, O>,
  input: I,
  ctx: RunContext,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<O> {
  const log = logger.child({ stage: stage.name, runId: ctx.runId });
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await stage.run(input, ctx);
      if (stage.validate) stage.validate(output);
      return output;
    } catch (err) {
      lastErr = err;
      // Non-retriable: surface the error immediately. Quota / auth / config
      // problems don't get better on retry — just waste more time and money.
      if (err instanceof NonRetriableError) {
        log.error({ message: err.message }, "stage failed permanently (non-retriable)");
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ attempt, message }, "stage failed, will retry");
      if (attempt < maxAttempts) await sleep(2 ** attempt * 250);
    }
  }

  throw new Error(
    `stage "${stage.name}" failed after ${maxAttempts} attempts: ${String(lastErr)}`,
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
