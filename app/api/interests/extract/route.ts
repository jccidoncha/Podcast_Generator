import { NextResponse } from "next/server";
import { z } from "zod";
import { interestExtractor } from "@/providers/interest-extractor";

// Stateless preview endpoint: turn the user's free-text description into a
// structured interest list. Does NOT save — the settings UI shows the
// extracted list and lets the user edit + confirm before persisting via
// PUT /api/interests.

const Payload = z.object({
  description: z.string().min(1).max(2000),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = Payload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const interests = await interestExtractor.extract(parsed.data.description);
  return NextResponse.json({ interests });
}
