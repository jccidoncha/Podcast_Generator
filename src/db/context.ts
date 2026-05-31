import { prisma } from "./client";
import type {
  Density,
  Format,
  Interest,
  Language,
  PodcastConfig,
  Style,
  Tone,
} from "@/pipeline/types";

// Boundary mapper: Prisma stores enums UPPERCASE (Postgres convention), app
// code uses lowercase string-literal types (idiomatic TS). This helper is the
// only place the conversion happens — everything downstream is app-typed.
export async function loadUserContext(userId: string): Promise<{
  config: PodcastConfig;
  interests: Interest[];
}> {
  const [configRow, interestRows] = await Promise.all([
    prisma.podcastConfig.findUniqueOrThrow({ where: { userId } }),
    prisma.interest.findMany({ where: { userId }, orderBy: { weight: "desc" } }),
  ]);

  return {
    config: {
      userId: configRow.userId,
      voice: configRow.voice,
      secondaryVoice: configRow.secondaryVoice,
      targetLengthMin: configRow.targetLengthMin,
      tone: configRow.tone.toLowerCase() as Tone,
      cadenceCron: configRow.cadenceCron,
      style: configRow.style.toLowerCase() as Style,
      density: configRow.density.toLowerCase() as Density,
      language: configRow.language.toLowerCase() as Language,
      format: configRow.format.toLowerCase() as Format,
    },
    interests: interestRows.map((i) => ({
      id: i.id,
      topic: i.topic,
      weight: i.weight,
      context: i.context,
    })),
  };
}
