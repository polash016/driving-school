-- spec-19: background translation runs.
--
-- Additive only. `enqueuedAt` is the worker gate: a plan without it is the cost-free preview the
-- admin screen has always had, and the worker never touches it. `pauseRequested`/`cancelRequested`
-- are cooperative — the runner reads them between batches rather than being killed mid-write.
-- `heartbeatAt` is liveness, kept separate from the lease, which is a lock. `rateUnitsPerMin` is an
-- EWMA of per-batch throughput so the ETA cannot flicker to "unknown" on one slow batch.
-- `repairAttempts` sits on Translation, not TranslationJob: a job is per run, and the ceiling has
-- to survive across repair runs or each new run would hand the unit a fresh budget.
--
-- HAND-EDITED (DECISIONS 2026-08-26): Prisma re-proposes, on EVERY migration, drops of the two
-- pgvector HNSW indexes and of the generated-column defaults on MasterItem.searchText and
-- KbChunk.textSearch. Those statements are removed below and must be removed again next time.

-- AlterEnum
ALTER TYPE "TranslationRunKind" ADD VALUE 'REPAIR';
ALTER TYPE "TranslationRunKind" ADD VALUE 'SAMPLE';

-- AlterTable
ALTER TABLE "TranslationRun"
  ADD COLUMN "enqueuedAt" TIMESTAMP(3),
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rateUnitsPerMin" DOUBLE PRECISION,
  ADD COLUMN "modelBatches" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TranslationJob" ADD COLUMN "claimedBy" TEXT;

-- AlterTable
ALTER TABLE "Translation" ADD COLUMN "repairAttempts" INTEGER NOT NULL DEFAULT 0;
