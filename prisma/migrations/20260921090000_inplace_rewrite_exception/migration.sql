-- spec-22: a keyed exception to the approved-item freeze, for the simplification campaign.
--
-- The freeze (20260825051917_assessment_integrity) refuses ANY change to an APPROVED MasterItem's
-- content, answer key, citations, topic, difficulty, type or version. That is right for every
-- ordinary path and is deliberately enforced in the database rather than only in `upsertItem`.
--
-- The campaign needs to rewrite ~722 approved questions shorter WITHOUT retiring them: the
-- alternative, `replaceItem`, retires the original immediately, which would drain the approved pool
-- and break every TaskSetMember row that references it.
--
-- So the exception is opened by a transaction-local GUC that ONLY
-- `src/server/services/question-bank/rewrite.ts` sets, immediately before its UPDATE:
--
--     SET LOCAL teoripro.inplace_rewrite = 'on'
--
-- `SET LOCAL` is scoped to the transaction and reverts on COMMIT and on ROLLBACK, so it cannot
-- leak to another statement or another connection. This is deliberately NOT `ALTER TABLE ...
-- DISABLE TRIGGER` (which takes an ACCESS EXCLUSIVE lock and would block live exam reads) and NOT
-- `session_replication_role = 'replica'` (which also disables foreign-key enforcement).
--
-- Note what the exception does NOT open: even under the GUC, the answer key, the citations, the
-- topic, the difficulty and the type still cannot move. So during the campaign the one thing that
-- must never change is protected by Postgres itself, not merely by application code.
--
-- REVERSAL (Prisma has no down migrations; run this to restore the original behaviour):
--   CREATE OR REPLACE FUNCTION "tp_approved_item_frozen"() RETURNS trigger AS $$
--   BEGIN
--     IF OLD."status" = 'APPROVED' AND (
--          NEW."content" IS DISTINCT FROM OLD."content"
--       OR NEW."correctOptionKey" IS DISTINCT FROM OLD."correctOptionKey"
--       OR NEW."legalCitations" IS DISTINCT FROM OLD."legalCitations"
--       OR NEW."topicId" IS DISTINCT FROM OLD."topicId"
--       OR NEW."difficulty" IS DISTINCT FROM OLD."difficulty"
--       OR NEW."type" IS DISTINCT FROM OLD."type"
--       OR NEW."version" IS DISTINCT FROM OLD."version"
--     ) THEN
--       RAISE EXCEPTION 'MasterItem % is approved and frozen: retire it and approve a replacement', OLD."id"
--         USING ERRCODE = 'restrict_violation';
--     END IF;
--     RETURN NEW;
--   END;
--   $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "tp_approved_item_frozen"() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('teoripro.inplace_rewrite', true), 'off') = 'on' THEN
    -- Absolute even under the exception: text and version only.
    IF NEW."correctOptionKey" IS DISTINCT FROM OLD."correctOptionKey"
       OR NEW."legalCitations" IS DISTINCT FROM OLD."legalCitations"
       OR NEW."topicId"        IS DISTINCT FROM OLD."topicId"
       OR NEW."difficulty"     IS DISTINCT FROM OLD."difficulty"
       OR NEW."type"           IS DISTINCT FROM OLD."type" THEN
      RAISE EXCEPTION 'MasterItem %: an in-place rewrite may change text and version only', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

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
