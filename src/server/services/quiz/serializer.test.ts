import { describe, expect, it } from "vitest";
import {
  buildAttemptResult,
  buildClientAttempt,
  buildPracticeResult,
  type ServedQuestionRow,
} from "./serializer";

const variantContent = {
  en: {
    stem: "What applies at the sign?",
    options: [
      { key: "a", text: "Yield" },
      { key: "b", text: "Stop" },
      { key: "c", text: "Priority" },
    ],
  },
  nb: {
    stem: "Hva gjelder ved skiltet?",
    options: [
      { key: "a", text: "Vikeplikt" },
      { key: "b", text: "Stopp" },
      { key: "c", text: "Forkjørsrett" },
    ],
  },
};

const explanation = {
  en: "You must yield.",
  nb: "Du har vikeplikt.",
  citations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
};

function servedRow(overrides: Partial<ServedQuestionRow> = {}): ServedQuestionRow {
  return {
    position: 1,
    optionOrder: ["c", "a", "b"],
    answeredOptionKey: null,
    flagged: false,
    topicSlug: "right-of-way",
    type: "TEXT",
    variantContent,
    imageUrl: null,
    ...overrides,
  };
}

describe("anti-leak serializer (SECURITY INVARIANT)", () => {
  it("served attempt JSON never contains correctness or explanations", () => {
    const attempt = buildClientAttempt({
      id: "att1",
      mode: "EXAM",
      status: "IN_PROGRESS",
      locale: "en",
      questionCount: 1,
      timeRemainingSec: 5400,
      questions: [servedRow()],
    });
    const json = JSON.stringify(attempt);
    expect(json).not.toContain("correctOptionKey");
    expect(json).not.toContain("isCorrect");
    expect(json).not.toContain("explanation");
    expect(json).not.toContain("Du har vikeplikt");
  });

  it("options are rendered in the per-attempt shuffled order, localized", () => {
    const attempt = buildClientAttempt({
      id: "att1",
      mode: "PRACTICE",
      status: "IN_PROGRESS",
      locale: "nb",
      questionCount: 1,
      timeRemainingSec: null,
      questions: [servedRow()],
    });
    expect(attempt.questions[0].options.map((o) => o.key)).toEqual(["c", "a", "b"]);
    expect(attempt.questions[0].options[0].text).toBe("Forkjørsrett");
    expect(attempt.questions[0].stem).toBe("Hva gjelder ved skiltet?");
  });

  it("poisoned input rows never reach the wire — builders copy whitelisted fields only", () => {
    const poisoned = {
      ...servedRow(),
      isCorrect: true,
      correctOptionKey: "a",
    } as ServedQuestionRow;
    const attempt = buildClientAttempt({
      id: "att1",
      mode: "EXAM",
      status: "IN_PROGRESS",
      locale: "en",
      questionCount: 1,
      timeRemainingSec: 10,
      questions: [poisoned],
    });
    expect(JSON.stringify(attempt)).not.toContain("isCorrect");
    expect(JSON.stringify(attempt)).not.toContain("correctOptionKey");
  });

  it("the .strict() contracts themselves reject any extra field (guards future serializer refactors)", async () => {
    const { clientQuestionSchema, clientAttemptSchema } = await import(
      "@/server/contracts/quiz"
    );
    const validQuestion = {
      position: 1,
      type: "TEXT",
      topicSlug: "right-of-way",
      stem: "s",
      options: [
        { key: "a", text: "A" },
        { key: "b", text: "B" },
      ],
      imageUrl: null,
      flagged: false,
      answeredOptionKey: null,
    };
    expect(() => clientQuestionSchema.parse(validQuestion)).not.toThrow();
    // a refactor that spreads a DB row (…row) would carry these — and must THROW:
    expect(() =>
      clientQuestionSchema.parse({ ...validQuestion, isCorrect: true }),
    ).toThrow();
    expect(() =>
      clientQuestionSchema.parse({ ...validQuestion, correctOptionKey: "a" }),
    ).toThrow();
    expect(() =>
      clientAttemptSchema.parse({
        id: "x",
        mode: "EXAM",
        status: "IN_PROGRESS",
        locale: "en",
        questionCount: 1,
        currentPosition: 1,
        timeRemainingSec: 1,
        questions: [validQuestion],
        answers: [],
      }),
    ).toThrow();
  });

  it("currentPosition resumes at the first unanswered question", () => {
    const attempt = buildClientAttempt({
      id: "att1",
      mode: "EXAM",
      status: "IN_PROGRESS",
      locale: "en",
      questionCount: 3,
      timeRemainingSec: 100,
      questions: [
        servedRow({ position: 1, answeredOptionKey: "a" }),
        servedRow({ position: 2 }),
        servedRow({ position: 3 }),
      ],
    });
    expect(attempt.currentPosition).toBe(2);
  });

  it("throws when optionOrder references a key missing from content (corrupt state loud, not silent)", () => {
    expect(() =>
      buildClientAttempt({
        id: "a",
        mode: "EXAM",
        status: "IN_PROGRESS",
        locale: "en",
        questionCount: 1,
        timeRemainingSec: 1,
        questions: [servedRow({ optionOrder: ["a", "b", "z"] })],
      }),
    ).toThrow(/missing in content/);
  });
});

describe("post-grading builders (reveal allowed)", () => {
  it("practice result reveals correctness + localized explanation with citations", () => {
    const result = buildPracticeResult({
      position: 3,
      correct: false,
      correctOptionKey: "a",
      explanation,
      locale: "nb",
    });
    expect(result).toEqual({
      position: 3,
      correct: false,
      correctOptionKey: "a",
      explanation: {
        text: "Du har vikeplikt.",
        citations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
      },
    });
  });

  it("attempt result carries review with correctness and localized topic names", () => {
    const result = buildAttemptResult({
      attemptId: "att1",
      mode: "EXAM",
      locale: "en",
      correctCount: 1,
      passMark: 1,
      passed: true,
      topicNames: { "right-of-way": { en: "Right of way", nb: "Vikeplikt" } },
      topicBreakdown: [{ topicSlug: "right-of-way", total: 1, correct: 1 }],
      questions: [
        {
          ...servedRow({ answeredOptionKey: "a" }),
          correctOptionKey: "a",
          isCorrect: true,
          explanation,
        },
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.review[0].correct).toBe(true);
    expect(result.review[0].explanation.text).toBe("You must yield.");
    expect(result.topicBreakdown[0].topicName).toBe("Right of way");
  });
});
