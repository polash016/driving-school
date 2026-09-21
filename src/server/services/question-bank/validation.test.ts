import { describe, expect, it } from "vitest";
import { brevityBlockers, checkItemQuality, stemFingerprint } from "./validation";

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
      en: {
        stem: "Who has right of way?",
        options,
        explanation: "The right-hand rule applies.",
      },
      nb: {
        stem: "Hvem har forkjørsrett?",
        options: options.map((option) => ({
          ...option,
          text: `${option.text} (nb)`,
        })),
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
    expect(report.errors.map((error) => error.code)).toContain(
      "CITATION_MISSING",
    );
  });

  it("blocks a missing or unmarked answer", () => {
    expect(
      checkItemQuality(item({ correctOptionKey: null })).errors.map(
        (e) => e.code,
      ),
    ).toContain("ANSWER_MISSING");
    expect(
      checkItemQuality(item({ correctOptionKey: "z" })).errors.map(
        (e) => e.code,
      ),
    ).toContain("ANSWER_UNKNOWN");
  });

  it("blocks options that cannot be graded unambiguously", () => {
    const withAllOfTheAbove = item();
    withAllOfTheAbove.content.en.options.push({
      key: "d",
      text: "All of the above",
    });
    withAllOfTheAbove.content.nb.options.push({ key: "d", text: "Alle over" });

    const report = checkItemQuality(withAllOfTheAbove);
    expect(report.passed).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("BANNED_OPTION");
  });

  it("blocks duplicate options, empty options and too few options", () => {
    const duplicate = item();
    duplicate.content.en.options[1].text = duplicate.content.en.options[0].text;
    expect(checkItemQuality(duplicate).errors.map((e) => e.code)).toContain(
      "DUPLICATE_OPTIONS",
    );

    const empty = item();
    empty.content.en.options[1].text = "  ";
    expect(checkItemQuality(empty).errors.map((e) => e.code)).toContain(
      "EMPTY_OPTION",
    );

    const thin = item();
    thin.content.en.options = thin.content.en.options.slice(0, 2);
    thin.content.nb.options = thin.content.nb.options.slice(0, 2);
    expect(checkItemQuality(thin).errors.map((e) => e.code)).toContain(
      "TOO_FEW_OPTIONS",
    );
  });

  it("blocks option letters that differ between languages", () => {
    const mismatched = item();
    mismatched.content.nb.options[2].key = "x";
    expect(checkItemQuality(mismatched).errors.map((e) => e.code)).toContain(
      "KEY_MISMATCH",
    );
  });

  it("blocks a missing explanation and an unfilled placeholder", () => {
    const noExplanation = item();
    noExplanation.content.nb.explanation = "";
    expect(checkItemQuality(noExplanation).errors.map((e) => e.code)).toContain(
      "EXPLANATION_MISSING",
    );

    const placeholder = item();
    placeholder.content.en.stem = "What is the limit in {{area}}?";
    expect(checkItemQuality(placeholder).errors.map((e) => e.code)).toContain(
      "PLACEHOLDER_LEFT",
    );
  });

  it("warns when the correct answer is conspicuously longer than the distractors", () => {
    const tell = item();
    tell.content.en.options[0].text =
      "Yield to traffic approaching from the right, because the right-hand rule applies whenever no sign or marking says otherwise";
    const report = checkItemQuality(tell);

    expect(report.passed).toBe(true); // a warning, not a block
    expect(report.warnings.map((warning) => warning.code)).toContain(
      "LENGTH_TELL",
    );
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

/**
 * Brevity (spec-22).
 *
 * The single most important assertion in this block is that `passed` stays true. `transitionItem`
 * turns any error into a ValidationError with no override in the UI, so brevity-as-error would
 * make every already-approved long question permanently unapprovable.
 */
describe("brevity", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  const item = (over: Partial<{ stem: string; option: string; explanation: string }>, type?: "TEXT" | "SIGN") => ({
    type,
    content: {
      en: {
        stem: over.stem ?? "Who has priority at this junction?",
        options: [
          { key: "a", text: over.option ?? "You do" },
          { key: "b", text: "Traffic from the right" },
          { key: "c", text: "Traffic from the left" },
        ],
        explanation: over.explanation ?? "Give way to the right.",
      },
      nb: {
        stem: "Hvem har forkjørsrett her?",
        options: [
          { key: "a", text: "Du" },
          { key: "b", text: "Trafikk fra høyre" },
          { key: "c", text: "Trafikk fra venstre" },
        ],
        explanation: "Vikeplikt for trafikk fra høyre.",
      },
    },
    correctOptionKey: "b",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
  });

  it("says nothing at the boundary", () => {
    const report = checkItemQuality(item({ stem: `${words(14)}?` }));
    expect(report.warnings.map((w) => w.code)).not.toContain("STEM_LONG");
  });

  it("warns one word past the limit — and still PASSES", () => {
    const report = checkItemQuality(item({ stem: `${words(16)}?` }));
    const stemLong = report.warnings.find((w) => w.code === "STEM_LONG");
    expect(stemLong).toBeDefined();
    expect(stemLong?.locale).toBe("en");
    expect(stemLong?.values).toMatchObject({ max: 15 });
    // THE assertion: a reviewer can still approve it.
    expect(report.passed).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  it("warns on a long option and a long explanation, still passing", () => {
    const report = checkItemQuality(
      item({ option: words(12), explanation: words(40) }),
    );
    const codes = report.warnings.map((w) => w.code);
    expect(codes).toContain("OPTION_LONG");
    expect(codes).toContain("EXPLANATION_LONG");
    expect(report.passed).toBe(true);
  });

  it("gives a SIGN option the larger sign budget", () => {
    const eleven = words(11);
    expect(
      checkItemQuality(item({ option: eleven }, "SIGN")).warnings.map((w) => w.code),
    ).not.toContain("OPTION_LONG");
    // …but 14 is past even the sign budget of 12.
    expect(
      checkItemQuality(item({ option: words(14) }, "SIGN")).warnings.map((w) => w.code),
    ).toContain("OPTION_LONG");
  });

  it("does not punish a Norwegian compound for being short and correct", () => {
    // A character budget would flag this; a word budget does not.
    const nbItem = item({});
    (nbItem.content.nb as { stem: string }).stem =
      "Hva betyr vikepliktsskiltet ved denne vegkrysningen?";
    const nb = checkItemQuality(nbItem).warnings.filter(
      (w) => w.locale === "nb" && w.code === "STEM_LONG",
    );
    expect(nb).toHaveLength(0);
  });

  it("flags an explanation of too many sentences, advisory only", () => {
    const report = checkItemQuality(
      item({ explanation: "One. Two. Three. Four." }),
    );
    expect(report.warnings.map((w) => w.code)).toContain("EXPLANATION_SENTENCES");
    expect(report.passed).toBe(true);
  });
});

describe("brevityBlockers", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  const content = (stem: string) => ({
    en: {
      stem,
      options: [
        { key: "a", text: "Yes" },
        { key: "b", text: "No" },
        { key: "c", text: "Maybe" },
      ],
      explanation: "Because the rule says so.",
    },
    nb: {
      stem: "Kort?",
      options: [
        { key: "a", text: "Ja" },
        { key: "b", text: "Nei" },
        { key: "c", text: "Kanskje" },
      ],
      explanation: "Fordi regelen sier det.",
    },
  });

  it("is silent between the target and the ceiling", () => {
    // 16 words is over the 15 target (a warning) but under the 21 ceiling (not a refusal).
    expect(brevityBlockers(content(words(16)))).toEqual([]);
  });

  it("refuses past the ceiling", () => {
    expect(brevityBlockers(content(words(22)))).toContain("STEM_TOO_LONG");
  });

  it("returns each code once, however many fields break it", () => {
    const many = content(words(22));
    many.en.options = many.en.options.map((o) => ({ ...o, text: words(15) }));
    const codes = brevityBlockers(many);
    expect(codes.filter((c) => c === "OPTION_TOO_LONG")).toHaveLength(1);
  });
});
