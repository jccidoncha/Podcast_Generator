import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";

const PostBody = z.object({
  focusTopic: z.string().min(1).max(120).optional(),
  // Per-episode overrides — take precedence over the user's saved
  // PodcastConfig for this run only.
  overrideTargetLengthMin: z.number().int().min(3).max(30).optional(),
  overrideFormat: z.enum(["SOLO", "CO_HOST", "DEBATE", "INTERVIEW"]).optional(),
  overrideStyle: z.enum(["NEWS_ROUNDUP", "DEEP_DIVE", "MAGAZINE"]).optional(),
});

const DEMO_USER_ID = "demo-user";

const ListQuery = z.object({
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid query", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { status, since, limit } = parsed.data;

  const runs = await prisma.run.findMany({
    where: {
      userId: DEMO_USER_ID,
      ...(status ? { status } : {}),
      ...(since ? { finishedAt: { gte: new Date(since) } } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: limit,
    include: { episode: { select: { id: true } } },
  });

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      errorMessage: r.errorMessage,
      episodeId: r.episode?.id ?? null,
    })),
  });
}

// POST creates a Run(PENDING) the worker polls for. The worker is what loads
// the actual context and runs the pipeline — this endpoint just queues the
// job. Returns the runId so the UI can poll /api/runs/:id for status.
// Optionally accepts { focusTopic } to bias rank + script toward a theme.
export async function POST(request: Request) {
  let focusTopic: string | undefined;
  let overrideTargetLengthMin: number | undefined;
  let overrideFormat: "SOLO" | "CO_HOST" | "DEBATE" | "INTERVIEW" | undefined;
  let overrideStyle: "NEWS_ROUNDUP" | "DEEP_DIVE" | "MAGAZINE" | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = PostBody.safeParse(body);
    if (parsed.success) {
      focusTopic = parsed.data.focusTopic;
      overrideTargetLengthMin = parsed.data.overrideTargetLengthMin;
      overrideFormat = parsed.data.overrideFormat;
      overrideStyle = parsed.data.overrideStyle;
    }
  } catch {
    // Empty body is fine — treat as no focus / no overrides.
  }

  const interestCount = await prisma.interest.count({ where: { userId: DEMO_USER_ID } });
  if (interestCount === 0) {
    return NextResponse.json(
      { error: "no interests configured — finish onboarding first" },
      { status: 400 },
    );
  }

  // Throttle: if there's an inflight PENDING/RUNNING < 3 min old, return it
  // (avoid stacking duplicates from double-clicks). Anything older is
  // considered abandoned and we mark it FAILED + create a fresh Run. The
  // worker also runs a janitor for this, but here we catch the case where
  // the worker is offline entirely.
  const FRESH_INFLIGHT_MS = 3 * 60_000;
  const inflight = await prisma.run.findFirst({
    where: { userId: DEMO_USER_ID, status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { startedAt: "desc" },
  });

  if (inflight) {
    const ageMs = Date.now() - inflight.startedAt.getTime();
    if (ageMs < FRESH_INFLIGHT_MS) {
      return NextResponse.json(
        { id: inflight.id, status: inflight.status, reused: true },
        { status: 200 },
      );
    }
    // Stale — sweep it.
    await prisma.run.update({
      where: { id: inflight.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: `stale ${inflight.status} swept on new POST (${Math.round(ageMs / 1000)}s old)`,
      },
    });
  }

  const run = await prisma.run.create({
    data: {
      userId: DEMO_USER_ID,
      status: "PENDING",
      focusTopic: focusTopic ?? null,
      overrideTargetLengthMin: overrideTargetLengthMin ?? null,
      overrideFormat: overrideFormat ?? null,
      overrideStyle: overrideStyle ?? null,
    },
  });

  return NextResponse.json(
    {
      id: run.id,
      status: run.status,
      focusTopic: run.focusTopic,
      overrides: {
        targetLengthMin: run.overrideTargetLengthMin,
        format: run.overrideFormat,
        style: run.overrideStyle,
      },
    },
    { status: 202 },
  );
}
