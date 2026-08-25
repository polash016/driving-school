import { setRequestLocale } from "next-intl/server";
import { QuizRunner } from "@/components/quiz/quiz-runner";
import { redirect } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { attemptService } from "@/server/services/assessment";
import type { AppLocale } from "../../../../../../config/school.config";

/**
 * A quiz in progress (spec-07 integration / spec-08).
 *
 * The payload rendered here comes straight from the engine's serializer: it carries the questions
 * and the student's own answers, and structurally cannot carry the correct answer. Grading is a
 * server round trip in every mode.
 *
 * Resuming is simply opening this page again: answers are written as they are given, so the
 * attempt is already where the student left it. `serveAttempt` closes and grades an attempt whose
 * clock ran out while they were away — in that case there is nothing to resume, and the student is
 * sent to the result instead of a paper they can no longer answer.
 */
export default async function QuizPage({
  params,
}: {
  params: Promise<{ locale: string; attemptId: string }>;
}) {
  const { locale, attemptId } = await params;
  setRequestLocale(locale);
  const user = await requireUser();

  const attempt = await attemptService.serveAttempt(user.id, {
    attemptId,
    locale: locale as AppLocale,
  });

  if (attempt.status !== "IN_PROGRESS") {
    redirect({ href: `/account/history/${attemptId}`, locale });
  }

  return <QuizRunner attempt={attempt} locale={locale as AppLocale} />;
}
