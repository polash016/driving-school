import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The freeze exception must have exactly one door (spec-22).
 *
 * `teoripro.inplace_rewrite` turns off the database's protection against editing an approved
 * question. That is defensible while exactly one reviewed file can set it and that file re-checks
 * the version and fingerprint first. It stops being defensible the moment a second call site
 * appears, because then "who can edit a frozen question?" has no answer you can read.
 *
 * A grep is a blunt instrument, and it is the right one here: the property being protected is
 * "this string appears in one place", which is exactly what a grep can prove.
 */
describe("the in-place rewrite GUC", () => {
  it("is set in rewrite.ts and nowhere else", () => {
    const hits = execSync(
      `grep -rl "teoripro.inplace_rewrite" src scripts prisma/migrations || true`,
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      // The migration defines the trigger that READS it; the tests assert on it.
      .filter((file) => !file.startsWith("prisma/migrations/"))
      .filter((file) => !file.endsWith(".test.ts"));

    expect(hits).toEqual(["src/server/services/question-bank/rewrite.ts"]);
  });
});
