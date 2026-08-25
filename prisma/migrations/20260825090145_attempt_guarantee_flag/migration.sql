-- Spec: pass-guarantee eligibility recorded per attempt, and frozen with the result.
-- NOTE: generated-column / HNSW drop statements removed on purpose (migrations.test.ts).

-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "countsTowardGuarantee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "setupSnapshot" JSONB;


-- The eligibility flag is part of the sealed result: a submitted attempt cannot later be declared
-- to have counted (or not) after the student saw the outcome.
CREATE OR REPLACE FUNCTION "tp_attempt_result_final"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."submittedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Attempt % is submitted and cannot be deleted', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."submittedAt" IS NOT NULL THEN
    IF NEW."correctCount" IS DISTINCT FROM OLD."correctCount"
      OR NEW."passed" IS DISTINCT FROM OLD."passed"
      OR NEW."topicBreakdown" IS DISTINCT FROM OLD."topicBreakdown"
      OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
      OR NEW."passMarkSnapshot" IS DISTINCT FROM OLD."passMarkSnapshot"
      OR NEW."seed" IS DISTINCT FROM OLD."seed"
      OR NEW."countsTowardGuarantee" IS DISTINCT FROM OLD."countsTowardGuarantee"
      OR NEW."setupSnapshot" IS DISTINCT FROM OLD."setupSnapshot" THEN
      RAISE EXCEPTION 'Attempt % is submitted: its result is final', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."resultHash" IS NOT NULL
       AND (NEW."resultHash" IS DISTINCT FROM OLD."resultHash"
            OR NEW."attestedAt" IS DISTINCT FROM OLD."attestedAt") THEN
      RAISE EXCEPTION 'Attempt % is already sealed: the attestation cannot be rewritten', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
