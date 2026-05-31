import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

// One-off: episodes whose audio file is missing on disk (LocalStorage in dev)
// get deleted. Cascades into Source rows. Idempotent — safe to re-run.
//
// Trigger: during early smoke tests we ran `rm -rf public/audio` between runs,
// leaving DB rows pointing to deleted mp3s. This sweeps them.

const PUBLIC_DIR = join(process.cwd(), "public");

async function main() {
  const prisma = new PrismaClient();
  const episodes = await prisma.episode.findMany({
    select: { id: true, audioUrl: true, runId: true },
  });

  const orphans: string[] = [];
  for (const ep of episodes) {
    // audioUrl is web-rooted, e.g. "/audio/episodes/<runId>.mp3".
    const local = join(PUBLIC_DIR, ep.audioUrl.replace(/^\//, ""));
    if (!existsSync(local)) {
      orphans.push(ep.id);
      console.log(`  orphan: ${ep.id}  ${ep.audioUrl}`);
    }
  }

  if (orphans.length === 0) {
    console.log("no orphans found");
  } else {
    const result = await prisma.episode.deleteMany({ where: { id: { in: orphans } } });
    console.log(`deleted ${result.count} orphan episode rows`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
