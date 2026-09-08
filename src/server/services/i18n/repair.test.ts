import { describe, expect, it } from "vitest";
import { isReQaOnly, repairProblems } from "./repair";

/**
 * The two decisions auto-repair makes before it spends anything (spec-19).
 *
 * Both are pure, and both are the difference between repair being safe and repair being a way to
 * burn a language's whole quality budget on a provider outage.
 */
describe("repair triage", () => {
  it("a unit whose only flags are infrastructure or advisory is re-QA'd, not re-translated", () => {
    expect(isReQaOnly(["QA_UNAVAILABLE"])).toBe(true);
    expect(isReQaOnly(["QA_UNAVAILABLE", "LENGTH_OUTLIER"])).toBe(true);
    expect(isReQaOnly(["NUMBER_DRIFT"])).toBe(false);
    expect(isReQaOnly(["QA_UNAVAILABLE", "NUMBER_DRIFT"])).toBe(false);
    // Vacuous truth is not an answer: no flags means nothing is known about the unit, and
    // "re-QA it and charge nothing" would loop it for free rather than repair it.
    expect(isReQaOnly([])).toBe(false);
  });

  it("turns a stored qaReport into prompt-ready problems", () => {
    const problems = repairProblems({
      qaFlags: ["NUMBER_DRIFT", "ANSWER_PERMUTED"],
      qaReport: {
        issues: [{ code: "NUMBER_DRIFT", blocking: true, detail: "80 to 50" }],
        modelIssue: "unsure about 'forkjørsvei'",
        semantic: {
          optionPairings: [
            { key: "a", nearest: "b" },
            { key: "b", nearest: "a" },
          ],
        },
      },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        { code: "NUMBER_DRIFT", detail: "80 to 50" },
        {
          code: "ANSWER_PERMUTED",
          detail: "option a reads like b, b reads like a",
        },
        { code: "MODEL_FLAGGED", detail: "unsure about 'forkjørsvei'" },
      ]),
    );
  });

  it("still names a flag the report carries no detail for", () => {
    expect(
      repairProblems({ qaFlags: ["SEMANTIC_DRIFT"], qaReport: null }),
    ).toEqual([{ code: "SEMANTIC_DRIFT" }]);
  });
});
