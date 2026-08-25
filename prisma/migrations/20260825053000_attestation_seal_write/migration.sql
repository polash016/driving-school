-- Spec-04b fix: the seal must be writable exactly once.
--
-- The original trigger froze everything on a submitted attempt, including `resultHash` — which
-- made it impossible to write the seal, since grading sets `submittedAt` in the same transaction
-- just before attesting. The rule it should express is narrower: a submitted result never
-- changes, and the seal may be applied once and then never altered.
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
      OR NEW."seed" IS DISTINCT FROM OLD."seed" THEN
      RAISE EXCEPTION 'Attempt % is submitted: its result is final', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- The seal: write-once. Applying it is allowed; changing or removing it is not.
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
