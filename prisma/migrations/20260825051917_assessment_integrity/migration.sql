-- Spec-04b assessment integrity: approvals, replacement lineage, result attestation, and the
-- database-level immutability guarantees behind them.
--
-- These triggers exist because "the service never does that" is not a guarantee. A pass mark that
-- gates a student's progress toward a licence has to be defensible even if application code is
-- wrong, a migration is careless, or someone reaches the database directly.
--
-- NOTE: generated-column / HNSW drop statements removed on purpose (prisma/migrations.test.ts).

-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "attestedAt" TIMESTAMP(3),
ADD COLUMN     "resultHash" TEXT;

-- AlterTable
ALTER TABLE "MasterItem" ADD COLUMN "replacesId" TEXT;

-- CreateTable
CREATE TABLE "ItemApproval" (
    "id" TEXT NOT NULL,
    "masterItemId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "itemVersion" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemApproval_masterItemId_idx" ON "ItemApproval"("masterItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemApproval_masterItemId_approverId_itemVersion_key" ON "ItemApproval"("masterItemId", "approverId", "itemVersion");

-- CreateIndex
CREATE INDEX "MasterItem_replacesId_idx" ON "MasterItem"("replacesId");

-- AddForeignKey
ALTER TABLE "MasterItem" ADD CONSTRAINT "MasterItem_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "MasterItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemApproval" ADD CONSTRAINT "ItemApproval_masterItemId_fkey" FOREIGN KEY ("masterItemId") REFERENCES "MasterItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemApproval" ADD CONSTRAINT "ItemApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────── Immutability guarantees ──

-- 1. A published question's text and answer can never change. `isActive` may still be toggled
--    (retiring stops it being served); everything a student was shown is frozen.
CREATE OR REPLACE FUNCTION "tp_item_variant_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."correctOptionKey" IS DISTINCT FROM OLD."correctOptionKey"
     OR NEW."explanation" IS DISTINCT FROM OLD."explanation"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."masterItemId" IS DISTINCT FROM OLD."masterItemId" THEN
    RAISE EXCEPTION 'ItemVariant % is immutable: content, answer and explanation cannot be edited after publication', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "item_variant_immutable"
  BEFORE UPDATE ON "ItemVariant"
  FOR EACH ROW EXECUTE FUNCTION "tp_item_variant_immutable"();

-- 2. Once an attempt is closed, its answers are history. Grading writes `isCorrect` while the
--    attempt is still IN_PROGRESS (same transaction, questions first), so this never blocks it.
CREATE OR REPLACE FUNCTION "tp_attempt_question_immutable"() RETURNS trigger AS $$
DECLARE
  attempt_status "AttemptStatus";
BEGIN
  SELECT "status" INTO attempt_status FROM "ExamAttempt" WHERE "id" = OLD."attemptId";
  IF attempt_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Attempt % is closed: answers cannot be changed after submission', OLD."attemptId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attempt_question_immutable"
  BEFORE UPDATE OR DELETE ON "ExamAttemptQuestion"
  FOR EACH ROW EXECUTE FUNCTION "tp_attempt_question_immutable"();

-- 3. A submitted result is final: score, pass flag and attestation cannot be rewritten, and the
--    attempt cannot be deleted. Re-grading a submitted attempt is not a thing that may happen
--    quietly — a dispute is resolved by re-computing and comparing, never by overwriting.
CREATE OR REPLACE FUNCTION "tp_attempt_result_final"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."submittedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Attempt % is submitted and cannot be deleted', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."submittedAt" IS NOT NULL AND (
       NEW."correctCount" IS DISTINCT FROM OLD."correctCount"
    OR NEW."passed" IS DISTINCT FROM OLD."passed"
    OR NEW."topicBreakdown" IS DISTINCT FROM OLD."topicBreakdown"
    OR NEW."resultHash" IS DISTINCT FROM OLD."resultHash"
    OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
    OR NEW."passMarkSnapshot" IS DISTINCT FROM OLD."passMarkSnapshot"
    OR NEW."seed" IS DISTINCT FROM OLD."seed"
  ) THEN
    RAISE EXCEPTION 'Attempt % is submitted: its result is final', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attempt_result_final"
  BEFORE UPDATE OR DELETE ON "ExamAttempt"
  FOR EACH ROW EXECUTE FUNCTION "tp_attempt_result_final"();

-- 4. An APPROVED question is frozen (developer decision 2026-08-25): corrections happen by
--    retiring it and approving a replacement. Only the lifecycle columns may move.
CREATE OR REPLACE FUNCTION "tp_approved_item_frozen"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'APPROVED' AND (
       NEW."content" IS DISTINCT FROM OLD."content"
    OR NEW."correctOptionKey" IS DISTINCT FROM OLD."correctOptionKey"
    OR NEW."legalCitations" IS DISTINCT FROM OLD."legalCitations"
    OR NEW."topicId" IS DISTINCT FROM OLD."topicId"
    OR NEW."difficulty" IS DISTINCT FROM OLD."difficulty"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."version" IS DISTINCT FROM OLD."version"
  ) THEN
    RAISE EXCEPTION 'MasterItem % is approved and frozen: retire it and approve a replacement', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "approved_item_frozen"
  BEFORE UPDATE ON "MasterItem"
  FOR EACH ROW EXECUTE FUNCTION "tp_approved_item_frozen"();
