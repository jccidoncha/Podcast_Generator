-- CreateEnum
CREATE TYPE "Format" AS ENUM ('SOLO', 'CO_HOST', 'DEBATE', 'INTERVIEW');

-- AlterTable
ALTER TABLE "PodcastConfig" ADD COLUMN     "format" "Format" NOT NULL DEFAULT 'SOLO',
ADD COLUMN     "secondaryVoice" TEXT;
