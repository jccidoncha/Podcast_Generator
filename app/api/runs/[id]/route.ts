import { NextResponse } from "next/server";
import { prisma } from "@/db/client";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;

  const run = await prisma.run.findUnique({
    where: { id },
    include: { episode: { select: { id: true } } },
  });

  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    errorMessage: run.errorMessage,
    episodeId: run.episode?.id ?? null,
  });
}
