-- An answer is written once (developer decision 2026-08-25).
--
-- Answers were already saved the moment a student chose an option, but they could be overwritten.
-- In practice mode the correct answer is revealed as soon as a question is answered, so being able
-- to navigate back and change it turned every practice test into a guaranteed full score. For a
-- result the school uses as its gate before the official teoriprøve, a changeable answer is not a
-- result at all.
--
-- Extends the spec-04b guarantee "answers cannot change after submission" to "an answer cannot
-- change once it is given". `isCorrect` deliberately stays writable while the attempt is
-- IN_PROGRESS — grading writes it inside the submit transaction.

CREATE OR REPLACE FUNCTION "tp_attempt_question_immutable"() RETURNS trigger AS $$
DECLARE
  attempt_status "AttemptStatus";
BEGIN
  SELECT "status" INTO attempt_status FROM "ExamAttempt" WHERE "id" = OLD."attemptId";
  IF attempt_status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Attempt % is closed: answers cannot be changed after submission', OLD."attemptId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."answeredOptionKey" IS NOT NULL
     AND NEW."answeredOptionKey" IS DISTINCT FROM OLD."answeredOptionKey" THEN
    RAISE EXCEPTION 'Question % of attempt % is already answered: an answer cannot be changed',
      OLD."position", OLD."attemptId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
