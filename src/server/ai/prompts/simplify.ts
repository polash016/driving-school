import type { PromptTemplate } from "./index";

/**
 * Shortening text that is ALREADY CORRECT and already approved (spec-22).
 *
 * Every other generation prompt asks for a new question, and a poor answer is discarded at review.
 * This one edits questions that students are sitting right now, so the failure mode is different in
 * kind: a rewrite that quietly moves the answer marks a learner correct for the wrong rule, and
 * nobody re-reads an already-approved question to notice.
 *
 * Hence the shape of the prompt. It is almost entirely a list of what must NOT change, the budget
 * is stated once, and refusing to shorten is offered as an explicitly correct answer — because a
 * question that stays long is a non-event, and a question that quietly changes is not.
 */
export const simplifyQuestionPrompt: PromptTemplate<{
  questionJson: string;
  correctOptionKey: string;
  citedText: string;
  maxStemWords: number;
  maxOptionWords: number;
  maxExplanationSentences: number;
}> = {
  id: "rewrite.simplify-question",
  version: "1.0.0",
  render: ({
    questionJson,
    correctOptionKey,
    citedText,
    maxStemWords,
    maxOptionWords,
    maxExplanationSentences,
  }) =>
    [
      "You are re-wording ONE existing question from the Norwegian driving theory test (class B) so that a learner reading at roughly CEFR A2-B1 understands it at a glance.",
      "",
      "You are NOT writing a new question. The question below is already approved and already correct. Your only job is to say the SAME thing in fewer, plainer words.",
      "",
      "WHAT MUST NOT CHANGE — a rewrite breaking any of these is thrown away:",
      `1. The correct answer stays the option with key "${correctOptionKey}". It must remain the only defensible answer.`,
      "2. Every option key is copied byte for byte, in the same order, in both languages. Never add, remove, merge or reorder options.",
      "3. Each option keeps the MEANING it has now. A wrong option must stay wrong for the same reason it is wrong today. Never make a wrong option closer to correct, and never make it absurd.",
      "4. Every number, unit, percentage and legal reference stays exactly as it is: 50 km/h stays 50 km/h, 0,2 stays 0,2, § 7 stays § 7. If you cannot keep a number, keep that sentence as it was.",
      "5. The point being tested stays the same. Do not shift to an easier rule, a different rule, or a more general one.",
      "6. Nothing is added. No advice, no penalties, no examples, no extra conditions, no 'usually' or 'normally' that the original does not have.",
      "",
      "THE BUDGET:",
      `- stem: at most ${maxStemWords} words, one sentence, one question mark.`,
      `- each option: at most ${maxOptionWords} words.`,
      `- explanation: at most ${maxExplanationSentences} short sentences — the rule, then briefly why the others are wrong.`,
      "",
      "HOW to shorten:",
      "- Cut words that carry no meaning. 'This sign indicates that you must stop' is 'You must stop'.",
      "- Drop scene-setting the question does not turn on. If the speed limit is irrelevant to the rule, it is padding.",
      "- Everyday words, active voice, second person, present tense, one idea per sentence. Write 'you must', never 'the driver is obliged to'.",
      "- Shorten EVERY option, not only the long ones: an option left long while the others shrink becomes the giveaway.",
      "- Keep established traffic terms exactly as they are ('vikeplikt', 'forkjorsvei', 'skiltforskriften'). Those are the words the official test uses, and simplifying them teaches the wrong vocabulary.",
      "",
      "NORWEGIAN (nb) is not a translation of your English — it is the other half of the same question, read by native speakers. Write idiomatic Bokmal at the same reading level, to the same budget.",
      "",
      "IF YOU CANNOT SHORTEN IT SAFELY — because every word is load-bearing, or because cutting would change what is asked — return the text unchanged and set `unchanged` to true. That is a correct and useful answer. A question still 22 words long is better than a question whose answer moved.",
      "",
      "THE RULE THIS QUESTION RESTS ON (for your understanding only — do not quote it, cite it, or copy its wording into the question):",
      citedText || "(not supplied)",
      "",
      "THE QUESTION TO RE-WORD:",
      questionJson,
      "",
      "Return STRICT JSON in exactly this shape and nothing else:",
      JSON.stringify(
        {
          en: {
            stem: "…",
            options: [
              { key: "a", text: "…" },
              { key: "b", text: "…" },
              { key: "c", text: "…" },
            ],
            explanation: "…",
          },
          nb: {
            stem: "…",
            options: [
              { key: "a", text: "…" },
              { key: "b", text: "…" },
              { key: "c", text: "…" },
            ],
            explanation: "…",
          },
          unchanged: false,
          changeNote: "one short phrase naming what you cut and why it was safe to cut",
        },
        null,
        2,
      ),
    ].join("\n"),
};

/**
 * Shortening one sign's registry meaning.
 *
 * Separate from the question prompt because the stakes are inverted: a sign question's stem is
 * boilerplate and its options are registry rows, so the meaning IS the answer. Getting it wrong
 * does not make a question long, it makes several questions ungradeable — the same sentence is a
 * distractor in every other question of that sign's class.
 *
 * Which is why rule 4 exists and why it beats brevity.
 */
export const simplifySignMeaningPrompt: PromptTemplate<{
  code: string;
  signClass: string;
  currentNameEn: string;
  currentNameNb: string;
  currentMeaningEn: string;
  currentMeaningNb: string;
  siblingMeanings: string;
  maxMeaningWords: number;
}> = {
  id: "rewrite.simplify-sign-meaning",
  version: "1.0.0",
  render: ({
    code,
    signClass,
    currentNameEn,
    currentNameNb,
    currentMeaningEn,
    currentMeaningNb,
    siblingMeanings,
    maxMeaningWords,
  }) =>
    [
      "You are shortening the registry entry for ONE official Norwegian road sign, for a driving-theory platform (Statens vegvesen class B). The sign graphic is attached.",
      "",
      "This text is used AS AN ANSWER OPTION in the question 'What does this sign mean?', beside three other signs' meanings, on a phone. So it must be short enough to scan and specific enough that it can only be true of THIS sign.",
      "",
      `Sign group: ${signClass}. Internal code: ${code}.`,
      `Current name (en): ${currentNameEn}`,
      `Current name (nb): ${currentNameNb}`,
      `Current meaning (en): ${currentMeaningEn}`,
      `Current meaning (nb): ${currentMeaningNb}`,
      "",
      "HARD RULES:",
      `1. meaningEn is ONE sentence of at most ${maxMeaningWords} words. meaningNb is the same sentence in Bokmal, also at most ${maxMeaningWords} words.`,
      "2. Say what the sign REQUIRES OR TELLS THE DRIVER, in plain words: 'You must give way.' 'Road narrows ahead.' 'No stopping.'",
      "3. Do not change what the sign means. If the current meaning says you must stop, the short one says you must stop. Check against the graphic: if graphic and text disagree, trust the GRAPHIC and say so in `note`.",
      "4. IT MUST NOT BE TRUE OF ANY OTHER SIGN IN ITS GROUP. The other meanings in this group are listed below, and this sentence will be used as a wrong answer beside them. If the only honest short sentence would also fit one of those, USE THE EXTRA WORDS YOU NEED. Being unambiguous beats being short, every time.",
      "5. Keep the names as they are unless a name is clearly wrong for the graphic. Do not 'simplify' a name.",
      "6. Never open with 'This sign indicates that…' or 'This sign means…', and never put the sign's own name in the meaning.",
      "7. No sign numbers, no legal sections, no penalties, no advice, no history, no 'please note', no 'be aware that'.",
      "8. Never invent. If neither the graphic nor the current meaning tells you, keep the current meaning and set `unchanged` to true.",
      "",
      siblingMeanings
        ? `OTHER MEANINGS IN THIS GROUP — yours must be distinguishable from every one of them:\n${siblingMeanings}`
        : "",
      "",
      "Return STRICT JSON and nothing else:",
      JSON.stringify(
        {
          nameEn: "…",
          nameNb: "…",
          meaningEn: "…",
          meaningNb: "…",
          unchanged: false,
          note: "",
        },
        null,
        2,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
};
