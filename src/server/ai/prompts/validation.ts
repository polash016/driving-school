import type { PromptTemplate } from "./index";

/**
 * The blind answer-check (spec-06, mode 2).
 *
 * Every other validator asks "is this question well formed?". This one asks the only question that
 * matters to a student: **is the marked answer actually right?** A wrong answer key is the failure
 * no schema check, no citation check and no duplicate check can find, and the one that does real
 * damage — a learner memorises the wrong rule and is marked correct for it.
 *
 * So the verifier is given the question and nothing else: no key, no explanation, no hint about
 * which option was authored as correct, and the options re-shuffled so position leaks nothing. It
 * simply sits the question, from the same facts and the same regulation text the author had. If it
 * disagrees with the key, the question is refused rather than argued with.
 */
export const blindAnswerCheckPrompt: PromptTemplate<{
  situation: string;
  signList: string;
  legalText: string;
  stem: string;
  options: string[];
}> = {
  id: "validation.blind-answer-check",
  version: "1.0.0",
  render: ({ situation, signList, legalText, stem, options }) =>
    [
      "You are sitting one question from the Norwegian driving theory test (class B).",
      "Answer it using ONLY the scene facts and the regulation text below. Do not use any other knowledge of Norwegian traffic law, even if you are confident in it — the point of this exercise is to check whether the regulation text supports the question as written.",
      "",
      "SCENE:",
      situation,
      signList ? `Signs present: ${signList}` : "",
      "",
      "REGULATION TEXT:",
      legalText,
      "",
      "QUESTION:",
      stem,
      "",
      "OPTIONS:",
      ...options.map((option, index) => `  ${index + 1}. ${option}`),
      "",
      "Return STRICT JSON { choice, quote, unanswerable, sceneSupported } where:",
      "  choice         — the number of the single correct option.",
      "  quote          — the sentence from the regulation text that makes it correct, copied verbatim.",
      "  unanswerable   — true if the regulation text above does not settle it, or if more than one option is defensible, or if none is.",
      "  sceneSupported — false if the question assumes ANYTHING about the scene that the SCENE section does not state.",
      "",
      "Set unanswerable rather than picking the least-bad option. A question this text cannot settle is a question that should not be asked.",
      "",
      "sceneSupported deserves care, because it is easy to miss. The regulation text describes a whole family of signs, so a question can be perfectly correct about the LAW while describing a sign that is not in this picture. If the question says a sign requires stopping and no such sign is listed in the SCENE, that is sceneSupported = false — however right the rule is.",
    ]
      .filter(Boolean)
      .join("\n"),
};
