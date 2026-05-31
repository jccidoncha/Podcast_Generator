-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "overrideFormat" "Format",
ADD COLUMN     "overrideStyle" "Style",
ADD COLUMN     "overrideTargetLengthMin" INTEGER;
