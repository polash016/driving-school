/**
 * Grading (spec-07): PURE server-side grading. Official pass rules come from
 * the attempt's LicenseClass snapshots — never hardcoded (mandate 4).
 */

export interface GradableQuestion {
  position: number;
  topicSlug: string;
  answeredOptionKey: string | null; // null = unanswered = wrong
  correctOptionKey: string;
}

export interface TopicResult {
  topicSlug: string;
  total: number;
  correct: number;
}

export interface GradeResult {
  questionCount: number;
  correctCount: number;
  /** null when no pass mark applies (open practice). */
  passed: boolean | null;
  perQuestion: Array<{ position: number; correct: boolean }>;
  topicBreakdown: TopicResult[];
}

export function gradeAttempt(
  questions: readonly GradableQuestion[],
  passMark: number | null,
): GradeResult {
  const perQuestion = questions.map((q) => ({
    position: q.position,
    correct: q.answeredOptionKey !== null && q.answeredOptionKey === q.correctOptionKey,
  }));

  const byTopic = new Map<string, TopicResult>();
  questions.forEach((q, i) => {
    const entry = byTopic.get(q.topicSlug) ?? {
      topicSlug: q.topicSlug,
      total: 0,
      correct: 0,
    };
    entry.total += 1;
    if (perQuestion[i].correct) entry.correct += 1;
    byTopic.set(q.topicSlug, entry);
  });

  const correctCount = perQuestion.filter((q) => q.correct).length;

  return {
    questionCount: questions.length,
    correctCount,
    passed: passMark === null ? null : correctCount >= passMark,
    perQuestion,
    topicBreakdown: [...byTopic.values()].sort((a, b) =>
      a.topicSlug.localeCompare(b.topicSlug),
    ),
  };
}
