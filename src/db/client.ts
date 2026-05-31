import { PrismaClient } from "@prisma/client";

// Next.js dev mode hot-reloads modules, which without this cache would
// create a new PrismaClient (and connection pool) per reload until you run
// out of connections. This is the canonical pattern.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Transient connection errors. Supabase's pooler (pgbouncer in transaction
// mode) closes idle backend connections; the first query after a long pause
// fails with P1017. Subsequent queries open a new connection and succeed.
// Rather than letting that single failure bubble up as a 500, we retry the
// query a couple of times with backoff — the second attempt almost always
// succeeds because Prisma opens a fresh connection.
//
// Other codes covered:
//   P1001 — can't reach DB (transient network)
//   P1002 — DB reached but connection timed out
//   P1008 — operation timed out
//   P1017 — server has closed the connection
const TRANSIENT_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);
const MAX_ATTEMPTS = 3;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !TRANSIENT_PRISMA_CODES.has(code)) throw err;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        // Backoff 80ms, 240ms — short enough to be invisible to the user but
        // long enough that the second attempt sees a new connection.
        await new Promise((r) => setTimeout(r, 80 * 3 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

function makePrismaClient(): PrismaClient {
  const base = new PrismaClient();
  // Prisma 6 dropped $use; $extends with the `query` block is the modern way
  // to wrap all operations. We cast back to PrismaClient because our app
  // doesn't use any extension-specific types — runtime shape is identical.
  return base.$extends({
    query: {
      $allOperations({ args, query }) {
        return withRetry(() => query(args));
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? makePrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
