import { describe, expect, it } from "vitest";
import { evaluateGuarantee, QUALIFYING_CRITERIA } from "./pass-guarantee";

/**
 * A guarantee is only worth as much as the rule behind it, so the rule is pinned here rather than
 * left to whatever the UI happens to check.
 */
describe("pass guarantee eligibility", () => {
  it("counts a full-length test across every category", () => {
    expect(
      evaluateGuarantee({
        questionCount: 45,
        selectedTopicCount: 7,
        totalTopicCount: 7,
      }),
    ).toEqual({ counts: true, reasons: [] });
  });

  it("does not count a test missing a category", () => {
    const result = evaluateGuarantee({
      questionCount: 45,
      selectedTopicCount: 6,
      totalTopicCount: 7,
    });
    expect(result.counts).toBe(false);
    expect(result.reasons).toContain("quiz.setup.guaranteeNeedsAllCategories");
  });

  it("does not count a test shorter than the real one", () => {
    const result = evaluateGuarantee({
      questionCount: 44,
      selectedTopicCount: 7,
      totalTopicCount: 7,
    });
    expect(result.counts).toBe(false);
    expect(result.reasons).toContain("quiz.setup.guaranteeNeedsQuestionCount");
  });

  it("reports both reasons when both are wrong", () => {
    const result = evaluateGuarantee({
      questionCount: 10,
      selectedTopicCount: 2,
      totalTopicCount: 7,
    });
    expect(result.counts).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it("counts a longer-than-required test", () => {
    expect(
      evaluateGuarantee({
        questionCount: 60,
        selectedTopicCount: 7,
        totalTopicCount: 7,
      }).counts,
    ).toBe(true);
  });

  it("mirrors the official test length", () => {
    expect(QUALIFYING_CRITERIA.minQuestions).toBe(45);
    expect(QUALIFYING_CRITERIA.allCategoriesRequired).toBe(true);
  });
});
