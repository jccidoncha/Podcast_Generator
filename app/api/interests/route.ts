import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { interestEnricher } from "@/providers/interest-enricher";

const DEMO_USER_ID = "demo-user";

const InterestsPayload = z.object({
  interests: z
    .array(
      z.object({
        topic: z.string().min(1).max(80),
        weight: z.number().min(0).max(1).default(1),
        // Optional user override of the LLM-generated context. When present,
        // we trust the user's words and skip re-enrichment for this topic.
        context: z.string().max(400).nullable().optional(),
      }),
    )
    .max(20),
});

export async function GET() {
  const interests = await prisma.interest.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: { weight: "desc" },
  });
  return NextResponse.json({ interests });
}

// PUT replaces the whole set — simplest UX for the settings page. A real app
// would do incremental add/remove with stable ids.
//
// Each new/changed topic gets enriched with an LLM-generated context string
// (one short sentence describing what the topic IS). The script prompt uses
// this so "shaboozey" reads as "American country/hip-hop artist" instead of
// being treated as a generic concept.
export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = InterestsPayload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Look up existing topics so we can REUSE their context when the user just
  // re-saves without changing anything (avoids paying for a redundant LLM call
  // on every settings save).
  const existing = await prisma.interest.findMany({
    where: { userId: DEMO_USER_ID },
    select: { topic: true, context: true },
  });
  const existingByTopic = new Map(existing.map((e) => [e.topic.toLowerCase(), e.context]));

  // Resolve context for each interest in this order:
  //   1. user-provided override → use as-is
  //   2. cached from previous save (same topic text, already enriched) → reuse
  //   3. fresh LLM enrichment (web-search-backed) → store
  const enriched = await Promise.all(
    parsed.data.interests.map(async (i) => {
      let context: string | null;
      if (i.context !== undefined && i.context !== null && i.context.trim()) {
        context = i.context.trim();
      } else {
        const cached = existingByTopic.get(i.topic.toLowerCase());
        context = cached ?? (await interestEnricher.describe(i.topic));
      }
      return { topic: i.topic, weight: i.weight, context };
    }),
  );

  const next = await prisma.$transaction(async (tx) => {
    await tx.interest.deleteMany({ where: { userId: DEMO_USER_ID } });
    if (enriched.length > 0) {
      await tx.interest.createMany({
        data: enriched.map((i) => ({
          userId: DEMO_USER_ID,
          topic: i.topic,
          weight: i.weight,
          context: i.context,
        })),
      });
    }
    return tx.interest.findMany({
      where: { userId: DEMO_USER_ID },
      orderBy: { weight: "desc" },
    });
  });

  return NextResponse.json({ interests: next });
}
