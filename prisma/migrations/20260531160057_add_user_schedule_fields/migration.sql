-- AlterTable
ALTER TABLE "PodcastConfig" ADD COLUMN     "lastScheduledRunAt" TIMESTAMP(3),
ADD COLUMN     "scheduleDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
ADD COLUMN     "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduleHour" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "scheduleMinute" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleTimezone" TEXT NOT NULL DEFAULT 'UTC';
