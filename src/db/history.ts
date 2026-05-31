import { prisma } from "./client";

// Source URLs used in the user's episodes in the recent past. The rank stage
// filters these out so the same story doesn't show up day after day.
export async function recentSourceUrls(
  userId: string,
  days: number,
): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const sources = await prisma.source.findMany({
    where: {
      episode: {
        createdAt: { gte: since },
        run: { userId },
      },
    },
    select: { url: true },
  });
  return new Set(sources.map((s) => s.url));
}
