import { NextResponse } from "next/server";
import { getEvalStats } from "@/db/eval-stats";

const DEMO_USER_ID = "demo-user";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") ?? "30");
  const windowDays = Number.isFinite(days) && days > 0 && days <= 365 ? days : 30;

  const stats = await getEvalStats(DEMO_USER_ID, windowDays);
  return NextResponse.json(stats);
}
