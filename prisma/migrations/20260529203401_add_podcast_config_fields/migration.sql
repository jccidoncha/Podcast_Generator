-- CreateEnum
CREATE TYPE "Style" AS ENUM ('NEWS_ROUNDUP', 'DEEP_DIVE', 'MAGAZINE');

-- CreateEnum
CREATE TYPE "Density" AS ENUM ('HEADLINE', 'DETAILED');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('EN', 'ES');

-- AlterTable
ALTER TABLE "PodcastConfig" ADD COLUMN     "density" "Density" NOT NULL DEFAULT 'DETAILED',
ADD COLUMN     "language" "Language" NOT NULL DEFAULT 'EN',
ADD COLUMN     "style" "Style" NOT NULL DEFAULT 'NEWS_ROUNDUP';
