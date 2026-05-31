import { PrismaClient } from "@prisma/client";
import { interestEnricher } from "@/providers/interest-enricher";

// Fills `Interest.context` for any row that was created before the column
// existed. Idempotent — only touches rows where context IS NULL. Re-run
// safely whenever new interests appear without context (e.g. after a manual
// DB insert).
async function main() {
  const prisma = new PrismaClient();
  const missing = await prisma.interest.findMany({
    where: { context: null },
    select: { id: true, topic: true },
  });

  if (missing.length === 0) {
    console.log("no interests missing context — nothing to do");
    await prisma.$disconnect();
    return;
  }

  console.log(`backfilling ${missing.length} interest(s)...`);
  for (const i of missing) {
    const ctx = await interestEnricher.describe(i.topic);
    if (!ctx) {
      console.log(`  ${i.topic.padEnd(30)} → (enrichment returned null)`);
      continue;
    }
    await prisma.interest.update({ where: { id: i.id }, data: { context: ctx } });
    console.log(`  ${i.topic.padEnd(30)} → ${ctx.slice(0, 80)}`);
  }
  console.log("done");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
