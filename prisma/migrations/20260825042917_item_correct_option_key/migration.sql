-- Spec-04: a master item carries its own answer key.
-- Backfills from the published variant, then constrains: only a DRAFT may lack an answer.
-- NOTE: statements dropping generated columns / the KbChunk HNSW index were removed from the
-- generated diff on purpose (prisma/migrations.test.ts enforces this).

-- AlterTable
ALTER TABLE "MasterItem" ADD COLUMN "correctOptionKey" TEXT;

-- Existing rows predate the column: take the answer from the variant that was published from them.
UPDATE "MasterItem" m
   SET "correctOptionKey" = v."correctOptionKey"
  FROM (
    SELECT DISTINCT ON ("masterItemId") "masterItemId", "correctOptionKey"
      FROM "ItemVariant"
     ORDER BY "masterItemId", "createdAt"
  ) v
 WHERE v."masterItemId" = m.id
   AND m."correctOptionKey" IS NULL;

-- A question without an answer is meaningless anywhere past DRAFT. Fails loudly rather than
-- letting an unanswerable item reach review, publication or a student.
ALTER TABLE "MasterItem"
  ADD CONSTRAINT "MasterItem_correct_key_required"
  CHECK ("status" = 'DRAFT' OR "correctOptionKey" IS NOT NULL);
