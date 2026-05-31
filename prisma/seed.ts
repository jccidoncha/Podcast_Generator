import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Idempotent seed: creates the demo user with default interests + config if not
// present. Safe to re-run. The worker and the listener UI both assume this
// user exists.
const DEMO_USER_ID = "demo-user";
const DEMO_EMAIL = "demo@example.com";

async function main() {
  const user = await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    create: { id: DEMO_USER_ID, email: DEMO_EMAIL },
    update: {},
  });

  await prisma.podcastConfig.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      voice: "rachel",
      targetLengthMin: 8,
      tone: "CONVERSATIONAL",
      cadenceCron: "0 8 * * *",
      style: "NEWS_ROUNDUP",
      density: "DETAILED",
      language: "EN",
    },
    update: {},
  });

  // Don't wipe interests on re-seed — the user may have edited them.
  const existing = await prisma.interest.count({ where: { userId: user.id } });
  if (existing === 0) {
    await prisma.interest.createMany({
      data: [
        { userId: user.id, topic: "AI policy", weight: 1.0 },
        { userId: user.id, topic: "space exploration", weight: 0.7 },
      ],
    });
  }

  console.log(`seed: demo user ${user.id} ready (${existing} existing interests preserved)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
