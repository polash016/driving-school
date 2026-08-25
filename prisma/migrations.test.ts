import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard for the hand-written pgvector/tsvector objects in 20260824054002_kb_hybrid_search.
 *
 * Prisma cannot express an HNSW index or a GENERATED tsvector column, so `prisma migrate dev`
 * proposes dropping both in EVERY new migration. They must be deleted from the generated SQL —
 * this test fails the build if such a statement is ever committed (it would silently destroy
 * knowledge-base search).
 */
const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");
const HYBRID_SEARCH = "20260824054002_kb_hybrid_search";
/** Spec-04 added a second generated column plus a CHECK constraint Prisma cannot model. */
const ITEM_SEARCH = "20260825042727_question_bank_sets";
const CORRECT_KEY = "20260825042917_item_correct_option_key";
const KEY_CONSTRAINT_SCOPE = "20260825043500_correct_key_constraint_scope";
const STEM_EMBEDDING = "20260825091716_question_similarity";
/** The write-once answer rule lives in a trigger function, not in the Prisma schema. */
const ANSWER_WRITE_ONCE = "20260825100500_answer_write_once";

function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS_DIR, entry.name, "migration.sql"), "utf8"),
    }));
}

describe("migrations", () => {
  it("still creates the hybrid-search index and generated column", () => {
    const hybrid = migrations().find((m) => m.name === HYBRID_SEARCH);
    expect(hybrid).toBeDefined();
    expect(hybrid!.sql).toContain("USING hnsw");
    expect(hybrid!.sql).toContain("GENERATED ALWAYS AS (to_tsvector('norwegian'");
    expect(hybrid!.sql).toContain('USING GIN ("textSearch")');
  });

  it("never drops the HNSW index or the generated tsvector column", () => {
    const offenders = migrations()
      .filter((m) => m.name !== HYBRID_SEARCH)
      .filter(
        (m) =>
          /DROP\s+INDEX\s+"KbChunk_embedding_hnsw_idx"/i.test(m.sql) ||
          /ALTER\s+TABLE\s+"KbChunk"[\s\S]*?DROP\s+(COLUMN\s+"textSearch"|DEFAULT)/i.test(m.sql),
      )
      .map((m) => m.name);

    expect(offenders).toEqual([]);
  });

  it("still creates the admin-search column and its GIN index", () => {
    const migration = migrations().find((m) => m.name === ITEM_SEARCH);
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("GENERATED ALWAYS AS");
    expect(migration!.sql).toContain("to_tsvector(");
    expect(migration!.sql).toContain('USING GIN ("searchText")');
  });

  it("still constrains every non-DRAFT item to carry an answer key", () => {
    const migration = migrations().find((m) => m.name === CORRECT_KEY);
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("MasterItem_correct_key_required");
  });

  it("never drops MasterItem's generated search column, its index or the answer-key constraint", () => {
    const offenders = migrations()
      .filter(
        (m) =>
          m.name !== ITEM_SEARCH &&
          m.name !== CORRECT_KEY &&
          m.name !== KEY_CONSTRAINT_SCOPE,
      )
      .filter(
        (m) =>
          /DROP\s+INDEX\s+"MasterItem_searchText_idx"/i.test(m.sql) ||
          /ALTER\s+TABLE\s+"MasterItem"[\s\S]*?DROP\s+(COLUMN\s+"searchText"|DEFAULT)/i.test(m.sql) ||
          /DROP\s+CONSTRAINT\s+"MasterItem_correct_key_required"/i.test(m.sql),
      )
      .map((m) => m.name);

    expect(offenders).toEqual([]);
  });

  it("never drops the question-stem ANN index", () => {
    // Prisma cannot model an hnsw index, so it proposes dropping this one too.
    const offenders = migrations()
      .filter((m) => m.name !== STEM_EMBEDDING)
      .filter((m) => /DROP\s+INDEX\s+"MasterItem_stemEmbedding_hnsw_idx"/i.test(m.sql))
      .map((m) => m.name);
    expect(offenders).toEqual([]);
  });

  it("still refuses to let a recorded answer change", () => {
    const migration = migrations().find((m) => m.name === ANSWER_WRITE_ONCE);
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("tp_attempt_question_immutable");
    expect(migration!.sql).toContain('OLD."answeredOptionKey" IS NOT NULL');
    // A later migration must not redefine the function without this rule.
    const redefinitions = migrations()
      .filter((m) => m.name > ANSWER_WRITE_ONCE)
      .filter((m) => /FUNCTION\s+"tp_attempt_question_immutable"/i.test(m.sql))
      .filter((m) => !/OLD\."answeredOptionKey" IS NOT NULL/.test(m.sql))
      .map((m) => m.name);
    expect(redefinitions).toEqual([]);
  });

  it("has one migration directory per applied migration, each with SQL", () => {
    for (const migration of migrations()) {
      expect(migration.sql.trim().length, migration.name).toBeGreaterThan(0);
    }
  });
});
