import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gradeAttempt, type GradableQuestion } from "./grading";

const questionArb = fc.record({
  topicSlug: fc.constantFrom("t1", "t2", "t3"),
  correctOptionKey: fc.constantFrom("a", "b", "c", "d"),
  answeredOptionKey: fc.option(fc.constantFrom("a", "b", "c", "d"), {
    nil: null,
  }),
});

const questionsArb = fc
  .array(questionArb, { minLength: 1, maxLength: 60 })
  .map((qs) => qs.map((q, i) => ({ ...q, position: i + 1 })));

describe("gradeAttempt properties", () => {
  it("correctCount equals the number of exact matches; bounded by question count", () => {
    fc.assert(
      fc.property(questionsArb, (questions) => {
        const grade = gradeAttempt(questions, null);
        const expected = questions.filter(
          (q) => q.answeredOptionKey === q.correctOptionKey,
        ).length;
        expect(grade.correctCount).toBe(expected);
        expect(grade.correctCount).toBeLessThanOrEqual(grade.questionCount);
      }),
    );
  });

  it("topic breakdown partitions the exam: totals sum to N, corrects sum to correctCount", () => {
    fc.assert(
      fc.property(questionsArb, (questions) => {
        const grade = gradeAttempt(questions, null);
        const totals = grade.topicBreakdown.reduce((s, t) => s + t.total, 0);
        const corrects = grade.topicBreakdown.reduce((s, t) => s + t.correct, 0);
        expect(totals).toBe(questions.length);
        expect(corrects).toBe(grade.correctCount);
        for (const t of grade.topicBreakdown) {
          expect(t.correct).toBeLessThanOrEqual(t.total);
        }
      }),
    );
  });

  it("question order never changes the result", () => {
    fc.assert(
      fc.property(questionsArb, (questions) => {
        const shuffled = [...questions].reverse();
        const a = gradeAttempt(questions, 5);
        const b = gradeAttempt(shuffled, 5);
        expect(b.correctCount).toBe(a.correctCount);
        expect(b.passed).toBe(a.passed);
        expect(b.topicBreakdown).toEqual(a.topicBreakdown);
      }),
    );
  });

  it("pass rule matches the configured mark exactly (correcting one wrong answer never lowers the score)", () => {
    fc.assert(
      fc.property(questionsArb, fc.integer({ min: 1, max: 60 }), (questions, passMark) => {
        const grade = gradeAttempt(questions, passMark);
        expect(grade.passed).toBe(grade.correctCount >= passMark);

        const wrongIdx = questions.findIndex(
          (q) => q.answeredOptionKey !== q.correctOptionKey,
        );
        if (wrongIdx >= 0) {
          const improved: GradableQuestion[] = questions.map((q, i) =>
            i === wrongIdx ? { ...q, answeredOptionKey: q.correctOptionKey } : q,
          );
          expect(gradeAttempt(improved, passMark).correctCount).toBe(
            grade.correctCount + 1,
          );
        }
      }),
    );
  });

  it("official class B rules: 45 questions, pass at 38", () => {
    const mk = (correct: number): GradableQuestion[] =>
      Array.from({ length: 45 }, (_, i) => ({
        position: i + 1,
        topicSlug: `t${i % 7}`,
        correctOptionKey: "a",
        answeredOptionKey: i < correct ? "a" : "b",
      }));
    expect(gradeAttempt(mk(38), 38).passed).toBe(true);
    expect(gradeAttempt(mk(37), 38).passed).toBe(false);
    expect(gradeAttempt(mk(45), 38).passed).toBe(true);
    expect(gradeAttempt(mk(0), 38).passed).toBe(false);
  });

  it("unanswered questions are wrong, never correct", () => {
    const grade = gradeAttempt(
      [
        { position: 1, topicSlug: "t", correctOptionKey: "a", answeredOptionKey: null },
      ],
      1,
    );
    expect(grade.correctCount).toBe(0);
    expect(grade.passed).toBe(false);
  });
});
