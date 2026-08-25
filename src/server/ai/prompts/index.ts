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

export const visionContextSheetPrompt: PromptTemplate<{
  signCodesHint: string[];
}> = {
  id: "vision.context-sheet",
  version: "1.0.0",
  render: ({ signCodesHint }) =>
    [
      "You analyze a Norwegian traffic scene photo for a driving-theory platform.",
      "Return STRICT JSON matching the provided schema: detected signs (official skiltforskriften codes only), road markings, actors, conditions, a neutral situation summary, and applicable rules with source references.",
      "Never guess a sign code you are not confident about — use confidence < 0.5 and it will be routed to a human.",
      signCodesHint.length > 0
        ? `Known sign codes in this deployment's registry include: ${signCodesHint.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
};

export const questionGenerationPrompt: PromptTemplate<{
  contextSheetJson: string;
  kbExcerpts: string;
  candidateCount: number;
}> = {
  id: "generation.image-questions",
  version: "1.0.0",
  render: ({ contextSheetJson, kbExcerpts, candidateCount }) =>
    [
      `Draft ${candidateCount} candidate multiple-choice questions (Norwegian driving theory, class B) grounded ONLY in the context sheet and legal excerpts below.`,
      "Each question: bilingual (en + nb), exactly one correct option, 3–4 plausible but unambiguous distractors, and at least one citation to the provided legal excerpts. No knowledge outside the excerpts.",
      "CONTEXT SHEET:",
      contextSheetJson,
      "LEGAL EXCERPTS:",
      kbExcerpts,
    ].join("\n\n"),
};

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
              testsPoint: "one short phrase naming the specific rule this question tests",
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
