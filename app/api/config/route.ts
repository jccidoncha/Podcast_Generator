import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";

const DEMO_USER_ID = "demo-user";

// Match Prisma enum values directly (uppercase). The settings page submits
// these strings as-is from the <select> options.
const ConfigPayload = z
  .object({
    voice: z.string().min(1).max(40),
    secondaryVoice: z.string().min(1).max(40).nullable().optional(),
    targetLengthMin: z.number().int().min(3).max(30),
    tone: z.enum(["CONVERSATIONAL", "FORMAL", "ENERGETIC"]),
    cadenceCron: z.string().min(1).max(80).optional(), // deprecated; kept for back-compat
    style: z.enum(["NEWS_ROUNDUP", "DEEP_DIVE", "MAGAZINE"]),
    density: z.enum(["HEADLINE", "DETAILED"]),
    language: z.enum(["EN", "ES"]),
    format: z.enum(["SOLO", "CO_HOST", "DEBATE", "INTERVIEW"]),
    // Schedule (all optional — the UI may submit them or not; defaults from
    // schema apply when fields aren't sent).
    scheduleEnabled: z.boolean().optional(),
    scheduleHour: z.number().int().min(0).max(23).optional(),
    scheduleMinute: z.number().int().min(0).max(59).optional(),
    scheduleDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    scheduleTimezone: z.string().min(1).max(64).optional(),
  })
  .refine((d) => d.format === "SOLO" || (d.secondaryVoice && d.secondaryVoice !== d.voice), {
    message: "non-solo formats require a secondaryVoice that differs from voice",
    path: ["secondaryVoice"],
  })
  .refine(
    (d) => !d.scheduleEnabled || (d.scheduleDays && d.scheduleDays.length > 0),
    { message: "scheduleEnabled requires at least one day selected", path: ["scheduleDays"] },
  );

export async function GET() {
  const config = await prisma.podcastConfig.findUnique({
    where: { userId: DEMO_USER_ID },
  });
  if (!config) {
    return NextResponse.json({ error: "config not found" }, { status: 404 });
  }
  return NextResponse.json(config);
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ConfigPayload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // For SOLO format we clear secondaryVoice so it's never stale.
  // Strip undefineds so Prisma uses defaults / leaves untouched fields alone.
  const { cadenceCron: _cadence, ...patch } = parsed.data;

  // If any schedule-related field changed, reset lastScheduledRunAt so the
  // new schedule has a fresh chance to fire today. Without this, changing
  // the time mid-day (e.g. 18:25 → 18:53 after the 18:25 slot already
  // fired) would be silently blocked by the "once per local day" guard.
  const current = await prisma.podcastConfig.findUnique({
    where: { userId: DEMO_USER_ID },
    select: {
      scheduleEnabled: true,
      scheduleHour: true,
      scheduleMinute: true,
      scheduleDays: true,
      scheduleTimezone: true,
    },
  });
  const scheduleChanged =
    !!current &&
    (
      (patch.scheduleEnabled !== undefined && patch.scheduleEnabled !== current.scheduleEnabled) ||
      (patch.scheduleHour !== undefined && patch.scheduleHour !== current.scheduleHour) ||
      (patch.scheduleMinute !== undefined && patch.scheduleMinute !== current.scheduleMinute) ||
      (patch.scheduleTimezone !== undefined && patch.scheduleTimezone !== current.scheduleTimezone) ||
      (patch.scheduleDays !== undefined && !arraysEqualUnordered(patch.scheduleDays, current.scheduleDays))
    );

  const updated = await prisma.podcastConfig.update({
    where: { userId: DEMO_USER_ID },
    data: {
      ...patch,
      secondaryVoice: patch.format === "SOLO" ? null : patch.secondaryVoice ?? null,
      ...(scheduleChanged ? { lastScheduledRunAt: null } : {}),
    },
  });

  return NextResponse.json(updated);
}

function arraysEqualUnordered(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
