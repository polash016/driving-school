import type { PromptTemplate } from "./index";

/**
 * Translation prompts (spec-15).
 *
 * Kept in their own module because they are the only prompts whose output can change what a mark
 * means. A generated question that is poor gets rejected in review; a translated question that is
 * subtly wrong looks fine to everyone who does not read the language.
 */

/**
 * Translate whole units — a question with its stem, every option and its explanation together.
 *
 * The unit is deliberate. A distractor is only wrong *in relation to its stem*: "Right" alone is a
 * coin toss between a direction and a correctness, and getting it wrong turns a wrong option into
 * a second right one. Both source languages are supplied because the Norwegian is the legal
 * original and the English is the fluent pivot — where they differ in nuance, the Norwegian wins.
 */
export const translateUnitsPrompt: PromptTemplate<{
  targetLanguage: string;
  targetCode: string;
  styleNote: string;
  glossaryBlock: string;
  rejectedBlock: string;
  unitsJson: string;
}> = {
  id: "translation.units",
  version: "1.0.0",
  render: ({
    targetLanguage,
    targetCode,
    styleNote,
    glossaryBlock,
    rejectedBlock,
    unitsJson,
  }) =>
    [
      `You are translating a Norwegian driving-theory examination into ${targetLanguage} (${targetCode}).`,
      "A student's result decides whether they may sit the official test, so a translation that shifts the meaning of a question is a legal problem, not a style problem.",
      "",
      "HARD RULES — breaking any of these makes the translation worthless:",
      "1. Return STRICT JSON: the same array, the same length, the same order, and the same `id` on every item.",
      "2. Option `key` values are identifiers, not text. Copy them byte for byte. Never add, drop, merge or reorder options.",
      "3. Never change a number or a unit. 50 km/h stays 50 km/h. 0,2 stays 0,2. A changed number is a wrong answer that looks right.",
      "4. Never translate a legal reference: `§ 7`, `§ 13 nr. 3` and source codes like `trafikkreglene` are addresses, and are copied unchanged.",
      "5. Preserve every {placeholder} and {{slot}} token exactly as written, including its spelling.",
      "6. Do not translate Norwegian institution names (Statens vegvesen). Transliterate where the script differs and put the original in brackets on first use.",
      "7. The option named as correct must remain the ONLY defensible answer, and every other option must stay clearly wrong.",
      "8. Write for a learner driver: second person, plain, the same reading level as the source. Do not explain more than the source explains.",
      "",
      'IF YOU CANNOT TRANSLATE FAITHFULLY, SAY SO. If a faithful translation would make two options mean the same thing, or would make a wrong option arguably correct, do NOT paraphrase your way around it — return that item with `"issue"` set to a short explanation and leave its text as best you can. A flagged item goes to a human; a quietly fudged one goes to a student.',
      "",
      styleNote,
      glossaryBlock,
      rejectedBlock,
      "",
      "Each input item has `en` (the pivot) and, where present, `nb` (the legal original). Translate the MEANING, using `nb` to settle anything ambiguous in `en`.",
      "",
      "Return exactly this shape:",
      JSON.stringify(
        {
          units: [
            {
              id: "the id given in the input",
              value: {
                stem: "the translated question",
                options: [{ key: "a", text: "translated option a" }],
                explanation: "the translated explanation",
              },
              issue: "omit unless something could not be translated faithfully",
            },
          ],
        },
        null,
        2,
      ),
      "",
      "For non-question items the `value` object carries the same keys the input `en` object had (for example `name`, `meaning`, `description`, `text`) — translate each and return the same keys.",
      "",
      "ITEMS:",
      unitsJson,
    ]
      .filter(Boolean)
      .join("\n"),
};

/**
 * Literal back-translation, for the QA pass.
 *
 * Routed at the `validation` task so it can run on a *different* model from the one that produced
 * the translation — a model checking its own work is a much weaker check, and the route table
 * makes "a different model" a configuration choice rather than a code change.
 */
export const backTranslatePrompt: PromptTemplate<{
  sourceLanguage: string;
  unitsJson: string;
}> = {
  id: "translation.back",
  version: "1.0.0",
  render: ({ sourceLanguage, unitsJson }) =>
    [
      `Translate the following ${sourceLanguage} text back into English, LITERALLY.`,
      "Do not improve it, smooth it, correct it or make it idiomatic. If the input says something odd, say the same odd thing in English — the point is to reveal what the text actually says, not what it meant to say.",
      "Preserve every key, including option keys, exactly.",
      "",
      "Return exactly this shape:",
      JSON.stringify(
        {
          units: [
            {
              id: "…",
              value: {
                stem: "…",
                options: [{ key: "a", text: "…" }],
                explanation: "…",
              },
            },
          ],
        },
        null,
        2,
      ),
      "",
      "ITEMS:",
      unitsJson,
    ].join("\n"),
};

/** Renders the termbase into a prompt block. Empty when a language has no glossary yet. */
export function glossaryBlock(
  glossary: Record<string, string> | null | undefined,
): string {
  const entries = Object.entries(glossary ?? {}).filter(
    ([source, value]) =>
      source.trim() && typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) return "";
  return [
    "",
    "GLOSSARY — use these renderings every time, so the same term does not appear three ways across the exam:",
    ...entries.slice(0, 120).map(([source, value]) => `- ${source} → ${value}`),
  ].join("\n");
}

/**
 * Past rejections as worked examples.
 *
 * The same idea that already works for question generation: a reviewer's own words about why a
 * translation was refused teach far more than another rule would.
 */
export function rejectedBlock(
  rejections: Array<{ excerpt: string; note: string | null }>,
): string {
  if (rejections.length === 0) return "";
  return [
    "",
    "PREVIOUSLY REJECTED — a reviewer who speaks this language refused these. Do not repeat the mistake:",
    ...rejections
      .slice(0, 10)
      .map(
        (rejection, index) =>
          `${index + 1}. "${rejection.excerpt.slice(0, 160)}"${
            rejection.note
              ? ` — reviewer: "${rejection.note.slice(0, 200)}"`
              : ""
          }`,
      ),
  ].join("\n");
}
