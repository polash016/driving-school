-- CreateEnum
CREATE TYPE "RejectionSource" AS ENUM ('GATE', 'DUPLICATE', 'REVIEWER');

-- CreateTable
CREATE TABLE "GenerationRejection" (
    "id" TEXT NOT NULL,
    "source" "RejectionSource" NOT NULL,
    "masterItemId" TEXT,
    "batchId" TEXT,
    "topicId" TEXT,
    "stemEn" TEXT NOT NULL,
    "stemNb" TEXT,
    "reasonCodes" TEXT[],
    "note" TEXT,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationRejection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationRejection_topicId_createdAt_idx" ON "GenerationRejection"("topicId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GenerationRejection_batchId_idx" ON "GenerationRejection"("batchId");

-- AddForeignKey
ALTER TABLE "GenerationRejection" ADD CONSTRAINT "GenerationRejection_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GenerationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRejection" ADD CONSTRAINT "GenerationRejection_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRejection" ADD CONSTRAINT "GenerationRejection_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "MasterItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
