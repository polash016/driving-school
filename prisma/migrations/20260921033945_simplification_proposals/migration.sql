-- spec-22: where a proposed shortening waits until every language is ready to swap with it.
--
-- NOTE: Prisma's generated SQL also proposed dropping the two HNSW vector indexes and the defaults
-- on the generated tsvector columns, because it cannot model either. Those statements were removed
-- by hand, as `prisma/migrations.test.ts` requires — dropping them would silently destroy hybrid
-- search and the admin question search.

-- CreateEnum
CREATE TYPE "SimplificationStatus" AS ENUM ('PROPOSED', 'READY', 'APPLIED', 'REFUSED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "SimplificationProposal" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "masterItemId" TEXT,
    "signId" TEXT,
    "proposed" JSONB NOT NULL,
    "previous" JSONB NOT NULL,
    "expectedVersion" INTEGER,
    "expectedFingerprint" TEXT NOT NULL,
    "translations" JSONB,
    "translatedLocales" TEXT[],
    "status" "SimplificationStatus" NOT NULL DEFAULT 'PROPOSED',
    "findings" TEXT[],
    "checks" JSONB,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "verifierModel" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimplificationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimplificationProposal_runId_status_idx" ON "SimplificationProposal"("runId", "status");

-- CreateIndex
CREATE INDEX "SimplificationProposal_masterItemId_status_idx" ON "SimplificationProposal"("masterItemId", "status");

-- CreateIndex
CREATE INDEX "SimplificationProposal_signId_status_idx" ON "SimplificationProposal"("signId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SimplificationProposal_runId_masterItemId_key" ON "SimplificationProposal"("runId", "masterItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SimplificationProposal_runId_signId_key" ON "SimplificationProposal"("runId", "signId");

-- AddForeignKey
ALTER TABLE "SimplificationProposal" ADD CONSTRAINT "SimplificationProposal_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "MasterItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimplificationProposal" ADD CONSTRAINT "SimplificationProposal_signId_fkey" FOREIGN KEY ("signId") REFERENCES "Sign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
