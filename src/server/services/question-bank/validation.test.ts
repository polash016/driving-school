import { describe, expect, it } from "vitest";
import { checkItemQuality, stemFingerprint } from "./validation";

/**
 * Spec-04b: a wrong or ambiguous question must not reach a student, because a pass here decides
 * whether they go on to the official test. These are the checks that run before approval.
 */
function item(overrides: Record<string, unknown> = {}) {
  const options = [
    { key: "a", text: "Yield to traffic from the right" },
    { key: "b", text: "Continue without stopping" },
    { key: "c", text: "Reverse out of the junction" },
  ];
  return {
    content: {
      en: { stem: "Who has right of way?", options, explanation: "The right-hand rule applies." },
      nb: {
        stem: "Hvem har forkjørsrett?",
        options: options.map((option) => ({ ...option, text: `${option.text} (nb)` })),
        explanation: "Høyreregelen gjelder.",
      },
    },
    correctOptionKey: "a",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
    ...overrides,
  };
}

describe("question quality gate", () => {
  it("passes a well-formed bilingual question", () => {
    const report = checkItemQuality(item());
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("blocks a question with no legal reference", () => {
    const report = checkItemQuality(item({ legalCitations: [] }));
    expect(report.passed).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("CITATION_MISSING");
  });

  it("blocks a missing or unmarked answer", () => {
    expect(checkItemQuality(item({ correctOptionKey: null })).errors.map((e) => e.code)).toContain(
      "ANSWER_MISSING",
    );
    expect(checkItemQuality(item({ correctOptionKey: "z" })).errors.map((e) => e.code)).toContain(
      "ANSWER_UNKNOWN",
    );
  });

  it("blocks options that cannot be graded unambiguously", () => {
    const withAllOfTheAbove = item();
    withAllOfTheAbove.content.en.options.push({ key: "d", text: "All of the above" });
    withAllOfTheAbove.content.nb.options.push({ key: "d", text: "Alle over" });

    const report = checkItemQuality(withAllOfTheAbove);
    expect(report.passed).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("BANNED_OPTION");
  });

  it("blocks duplicate options, empty options and too few options", () => {
    const duplicate = item();
    duplicate.content.en.options[1].text = duplicate.content.en.options[0].text;
    expect(checkItemQuality(duplicate).errors.map((e) => e.code)).toContain("DUPLICATE_OPTIONS");

    const empty = item();
    empty.content.en.options[1].text = "  ";
    expect(checkItemQuality(empty).errors.map((e) => e.code)).toContain("EMPTY_OPTION");

    const thin = item();
    thin.content.en.options = thin.content.en.options.slice(0, 2);
    thin.content.nb.options = thin.content.nb.options.slice(0, 2);
    expect(checkItemQuality(thin).errors.map((e) => e.code)).toContain("TOO_FEW_OPTIONS");
  });

  it("blocks option letters that differ between languages", () => {
    const mismatched = item();
    mismatched.content.nb.options[2].key = "x";
    expect(checkItemQuality(mismatched).errors.map((e) => e.code)).toContain("KEY_MISMATCH");
  });

  it("blocks a missing explanation and an unfilled placeholder", () => {
    const noExplanation = item();
    noExplanation.content.nb.explanation = "";
    expect(checkItemQuality(noExplanation).errors.map((e) => e.code)).toContain(
      "EXPLANATION_MISSING",
    );

    const placeholder = item();
    placeholder.content.en.stem = "What is the limit in {{area}}?";
    expect(checkItemQuality(placeholder).errors.map((e) => e.code)).toContain("PLACEHOLDER_LEFT");
  });

  it("warns when the correct answer is conspicuously longer than the distractors", () => {
    const tell = item();
    tell.content.en.options[0].text =
      "Yield to traffic approaching from the right, because the right-hand rule applies whenever no sign or marking says otherwise";
    const report = checkItemQuality(tell);

    expect(report.passed).toBe(true); // a warning, not a block
    expect(report.warnings.map((warning) => warning.code)).toContain("LENGTH_TELL");
  });

  it("fingerprints stems so a reworded-but-identical question is caught", () => {
    const a = stemFingerprint(item().content);
    const b = stemFingerprint(
      item({
        content: {
          ...item().content,
          en: { ...item().content.en, stem: "  WHO has   right of way?? " },
        },
      }).content,
    );
    expect(a).toBe(b);
  });
});
