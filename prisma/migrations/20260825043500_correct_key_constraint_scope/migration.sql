-- Spec-04 fix: DRAFT and RETIRED are both non-serving states, so neither needs an answer key.
-- The original predicate made an incomplete draft impossible to abandon (retire) — it could only
-- be deleted. The constraint's purpose is narrower: nothing reviewable or servable may lack an
-- answer.
ALTER TABLE "MasterItem" DROP CONSTRAINT "MasterItem_correct_key_required";

ALTER TABLE "MasterItem"
  ADD CONSTRAINT "MasterItem_correct_key_required"
  CHECK ("status" IN ('DRAFT', 'RETIRED') OR "correctOptionKey" IS NOT NULL);
