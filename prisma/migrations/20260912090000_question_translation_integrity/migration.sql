-- spec-20: questions first, and a language that keeps itself translated.
--
-- `TranslationJob.priority` is the claim order inside a run (ENTITY_PRIORITY in units.ts). The
-- claim used to order by the TranslatableEntity enum, whose first value is UI_MESSAGE, so every
-- run that stalled on a quota had translated the chrome and none of the exam. The index that
-- serves the claim gains the column; every other query on the job table filters on the prefix
-- (runId, state) and is served by it unchanged.
-- `Language.autoTranslate` makes a language translate on add and re-sync after content changes
-- without an admin's click; `syncRequestedAt` is the stamp a translatable-content write leaves for
-- the idle worker, compared against the latest sync run's plan time.
--
-- Down: DROP INDEX "TranslationJob_runId_state_priority_entity_idx";
--       CREATE INDEX "TranslationJob_runId_state_entity_idx" ON "TranslationJob"("runId", "state", "entity");
--       ALTER TABLE "TranslationJob" DROP COLUMN "priority";
--       ALTER TABLE "Language" DROP COLUMN "autoTranslate", DROP COLUMN "syncRequestedAt";
--
-- HAND-EDITED (DECISIONS 2026-08-26, 2026-09-03): Prisma re-proposes, on EVERY migration, drops of
-- the two pgvector HNSW indexes, of the generated-column defaults on MasterItem.searchText and
-- KbChunk.textSearch, and of the partial unique index TaskSet_published_number_key. Those
-- statements were removed here and must be removed again next time.

-- DropIndex
DROP INDEX "TranslationJob_runId_state_entity_idx";

-- AlterTable
ALTER TABLE "Language" ADD COLUMN     "autoTranslate" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "syncRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TranslationJob" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "TranslationJob_runId_state_priority_entity_idx" ON "TranslationJob"("runId", "state", "priority", "entity");
