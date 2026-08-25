-- Spec-04 question bank: generation sets, structured rejection reasons, admin search.
-- NOTE: statements dropping KbChunk's HNSW index / generated tsvector were removed from the
-- generated diff on purpose (prisma/migrations.test.ts enforces this).

-- CreateEnum
CREATE TYPE "BatchKind" AS ENUM ('IMAGE', 'THEORY', 'MANUAL');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('WRONG_ANSWER', 'AMBIGUOUS_DISTRACTOR', 'CITATION_MISMATCH', 'DUPLICATE', 'LANGUAGE_QUALITY', 'IMAGE_MISMATCH', 'OUT_OF_SCOPE', 'OTHER');

-- AlterTable
ALTER TABLE "MasterItem" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "reviewReason" "RejectionReason";

-- Admin search (spec-04): generated tsvector over both locales' stems. 'simple' — no stemming,
-- because one column carries English and Norwegian text and admin search wants literal matching.
-- Raw SQL: Prisma has no generated-column syntax (see prisma/schema.prisma MasterItem.searchText).
ALTER TABLE "MasterItem"
  ADD COLUMN "searchText" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce("content"->'en'->>'stem', '') || ' ' || coalesce("content"->'nb'->>'stem', '')
    )
  ) STORED;

-- CreateTable
CREATE TABLE "GenerationBatch" (
    "id" TEXT NOT NULL,
    "kind" "BatchKind" NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "sourceImageId" TEXT,
    "topicId" TEXT,
    "licenseClassId" TEXT,
    "requestedCount" INTEGER NOT NULL DEFAULT 5,
    "providerId" TEXT,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationBatch_status_createdAt_idx" ON "GenerationBatch"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GenerationBatch_sourceImageId_idx" ON "GenerationBatch"("sourceImageId");

-- CreateIndex
CREATE INDEX "MasterItem_batchId_status_idx" ON "MasterItem"("batchId", "status");

-- CreateIndex
CREATE INDEX "MasterItem_createdBy_status_reviewedAt_idx" ON "MasterItem"("createdBy", "status", "reviewedAt");

-- CreateIndex
CREATE INDEX "MasterItem_searchText_idx" ON "MasterItem" USING GIN ("searchText");

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GenerationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationBatch" ADD CONSTRAINT "GenerationBatch_sourceImageId_fkey" FOREIGN KEY ("sourceImageId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationBatch" ADD CONSTRAINT "GenerationBatch_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationBatch" ADD CONSTRAINT "GenerationBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
