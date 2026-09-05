/**
 * Versioned prompt registry (architecture blueprint §6 / spec-06).
 * Prompts are TS modules — reviewed in git, type-safe variables, never inline
 * strings at call sites. Every AI artifact stores promptVersion + modelVersion.
 *
 * Bump `version` on ANY wording change — downstream artifacts key off it.
 */

export interface PromptTemplate<TVars> {
  id: string;
  version: string;
  render: (vars: TVars) => string;
}

export const surfaceVariationPrompt: PromptTemplate<{
  questionJson: string;
}> = {
  id: "variation.surface",
  version: "1.0.0",
  render: ({ questionJson }) =>
    [
      "Reword the following driving-theory question: vary phrasing, ordering of ideas, and distractor wording WITHOUT changing the tested concept, the correct answer's meaning, difficulty, or the citations.",
      "Return the same JSON structure, both locales (en + nb).",
      "QUESTION:",
      questionJson,
    ].join("\n\n"),
};

export const citationSupportJudgePrompt: PromptTemplate<{
  questionJson: string;
  citedExcerpts: string;
}> = {
  id: "validation.citation-support",
  version: "1.0.0",
  render: ({ questionJson, citedExcerpts }) =>
    [
      "Judge strictly: is the question's correct answer fully supported by the cited legal excerpts, and is exactly one option correct?",
      'Return JSON: {"supported": boolean, "singleCorrect": boolean, "reason": string}.',
      "QUESTION:",
      questionJson,
      "CITED EXCERPTS:",
      citedExcerpts,
    ].join("\n\n"),
};

export const theoryGenerationPrompt: PromptTemplate<{
  topicName: string;
  kbExcerpts: string;
  candidateCount: number;
  avoidStems: string;
  difficultyBrief: string;
  rejectionLessons: string;
}> = {
  id: "generation.theory-questions",
  version: "1.2.0",
  render: ({
    topicName,
    kbExcerpts,
    candidateCount,
    avoidStems,
    difficultyBrief,
    rejectionLessons,
  }) =>
    [
      `Write ${candidateCount} multiple-choice questions for the Norwegian driving theory test (class B) on the topic "${topicName}".`,
      "",
      "HARD RULES — a question breaking any of these is worthless:",
      "1. Ground every question ONLY in the legal excerpts below. Never use knowledge from outside them.",
      "2. Each question cites at least one excerpt by its sourceCode and ref.",
      "3. Exactly one option is defensibly correct; the others must be clearly wrong to someone who knows the rule, never a matter of judgement.",
      "4. 3 or 4 options. Never use 'all of the above', 'none of the above' or similar.",
      "5. Do not make the correct option noticeably longer than the others — that gives the answer away.",
      "6. Write both languages: en (English) and nb (Norwegian Bokmål). Both must test exactly the same thing with the same option order and the same correct key.",
      "7. The explanation states the rule and why the other options are wrong.",
      "8. A learner driver must be able to answer from the rule alone — no trick questions, no obscure edge cases.",
      "9. Every question must test a DIFFERENT point. Do not rewrite one rule several ways, and do not write two questions whose answers are the same fact.",
      "10. Vary the situation: some questions about what a driver must do, some about what a rule means, some about a specific scenario on the road.",
      "",
      difficultyBrief,
      "",
      avoidStems
        ? `Do NOT rewrite these existing questions; write about different aspects:\n${avoidStems}`
        : "",
      "",
      rejectionLessons,
      "",
      "LEGAL EXCERPTS:",
      kbExcerpts,
      "",
      "Return STRICT JSON in exactly this shape and nothing else:",
      JSON.stringify(
        {
          questions: [
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
              correctOptionKey: "a",
              difficulty: 3,
              testsPoint:
                "one short phrase naming the specific rule this question tests",
              citations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
            },
          ],
        },
        null,
        2,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
};

/**
 * Drafting questions about a photograph (spec-06, mode 2).
 *
 * The context sheet is handed over as SETTLED FACT — it has been through closed-vocabulary
 * detection, agreement across repeated readings and a per-sign visual re-check, and possibly a
 * human. The model's job is to write, not to look: it never re-interprets the picture, because
 * anything it "sees" here would bypass every one of those defences.
 */
export const imageQuestionPrompt: PromptTemplate<{
  situationSummary: string;
  signList: string;
  sceneFacts: string;
  kbExcerpts: string;
  candidateCount: number;
  avoidStems: string;
  difficultyBrief: string;
  rejectionLessons: string;
}> = {
  id: "generation.image-questions",
  version: "1.0.0",
  render: ({
    situationSummary,
    signList,
    sceneFacts,
    kbExcerpts,
    candidateCount,
    avoidStems,
    difficultyBrief,
    rejectionLessons,
  }) =>
    [
      `Write ${candidateCount} multiple-choice questions for the Norwegian driving theory test (class B) about ONE photograph, described below.`,
      "",
      "The student sees the PHOTOGRAPH, not this description. So:",
      "- NEVER name a sign that is in the picture — not by its code and not by its name. 'What does this sign mean?' is right. 'What does the Give Way sign specify?' is WRONG and will be thrown away: the student can answer it without looking, so the picture becomes decoration. Refer to what is shown as 'this sign', 'the sign on the right', 'the upper sign'.",
      "- Never write 'in the image above', 'as described' or 'according to the context sheet'. Ask as if the reader is at the wheel.",
      "- Do not invent anything that is not in the facts below. No weather, no vehicles, no signs that were not listed.",
      "",
      "SCENE (settled fact — do not reinterpret):",
      situationSummary,
      signList
        ? `Signs present: ${signList}`
        : "No traffic signs were identified in this picture.",
      sceneFacts,
      "",
      "REGULATION TEXT — the ONLY source for what is correct:",
      kbExcerpts,
      "",
      "Every question must:",
      "- be answerable from the scene facts plus the regulation text above, and from nothing else;",
      "- cite at least one of the excerpts above by its sourceCode and ref;",
      "- have exactly one defensible answer and 3 wrong options that are plausible to someone who half-knows the rule — not absurd, not near-synonyms of each other;",
      "- be complete in BOTH English (en) and Norwegian Bokmål (nb), with the same option keys in the same order and an explanation in each language.",
      "",
      difficultyBrief,
      avoidStems
        ? `\nALREADY ASKED — do not rewrite these:\n${avoidStems}`
        : "",
      rejectionLessons,
      "",
      "Return STRICT JSON in exactly this shape and nothing else:",
      JSON.stringify(
        {
          questions: [
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
              correctOptionKey: "a",
              difficulty: 3,
              testsPoint:
                "one short phrase naming the specific rule this question tests",
              citations: [{ sourceCode: "skiltforskriften", ref: "§ 6" }],
            },
          ],
        },
        null,
        2,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
};
