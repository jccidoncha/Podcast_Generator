import { NextResponse } from "next/server";
import { prisma } from "@/db/client";

const DEMO_USER_ID = "demo-user";

export async function GET() {
  const episodes = await prisma.episode.findMany({
    where: { run: { userId: DEMO_USER_ID } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { sources: { select: { url: true, title: true } } },
  });

  return NextResponse.json({
    episodes: episodes.map((ep) => ({
      id: ep.id,
      runId: ep.runId,
      audioUrl: ep.audioUrl,
      durationMs: ep.durationMs,
      costCents: ep.costCents,
      generatedAt: ep.createdAt.toISOString(),
      sources: ep.sources,
    })),
  });
}

export async function POST() {
  return NextResponse.json(
    { error: "Episode creation is triggered by the worker, not the API." },
    { status: 501 },
  );
}
