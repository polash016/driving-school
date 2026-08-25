import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { QuestionCard } from "@/components/quiz/question-card";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { attemptService } from "@/server/services/assessment";
import { getAttemptSummary } from "@/server/services/assessment/history";
import type { AppLocale } from "../../../../../../../config/school.config";

/**
 * One past exam, exactly as it was sat (spec-04b): the questions as served, in the order shown,
 * with the student's own answer against the correct one.
 *
 * The engine refuses to build this for an attempt that is still running — correctness must not
 * leak into a live exam, and that rule lives in the service, not in this page.
 */
export default async function AttemptPaperPage({
  params,
}: {
  params: Promise<{ locale: string; attemptId: string }>;
}) {
  const { locale, attemptId } = await params;
  setRequestLocale(locale);
  const user = await requireUser();

  const [t, format, result, summary] = await Promise.all([
    getTranslations("history"),
    getFormatter(),
    attemptService.getResult(user.id, { attemptId, locale: locale as AppLocale }),
    getAttemptSummary(db, user, attemptId),
  ]);

  const percent = Math.round((result.correctCount / result.questionCount) * 100);
  const wrongCount = result.review.filter((question) => !question.correct).length;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-8">
      <header className="space-y-2">
        <Link
          href="/account/history"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t("backToHistory")}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t(`kind.${summary.kind}`)}
        </h1>
      </header>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardContent className="space-y-3 text-center">
          <div className="space-y-1">
            <p
              className={cn(
                "text-[length:var(--font-size-stat)] font-semibold leading-none",
                result.passed === false ? "text-destructive" : "text-[var(--status-success)]",
              )}
            >
              {result.correctCount}/{result.questionCount}
            </p>
            <p className="text-sm text-muted-foreground">
              {percent}% ·{" "}
              {result.passed === null
                ? t("noPassMark")
                : result.passed
                  ? t("passed")
                  : t("notPassed")}
              {result.passMark !== null ? ` · ${t("passMark", { mark: result.passMark })}` : ""}
            </p>
          </div>

          {/* What it was, when, and how long it took — the facts a result is quoted with. */}
          <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">{t("takenOn")}</dt>
              <dd className="font-medium text-foreground">
                {format.dateTime(summary.startedAt, { dateStyle: "medium" })}
              </dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">{t("duration")}</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {summary.durationSec === null
                  ? "—"
                  : t("minutes", { count: Math.max(1, Math.round(summary.durationSec / 60)) })}
              </dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">{t("wrongAnswers")}</dt>
              <dd className="font-medium tabular-nums text-foreground">{wrongCount}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap justify-center gap-1.5 text-[0.6875rem]">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-medium",
                summary.countsTowardGuarantee
                  ? "bg-[var(--status-success-soft)] text-[var(--status-success)]"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {summary.countsTowardGuarantee ? t("countsTowardGuarantee") : t("doesNotCount")}
            </span>
            {summary.attested ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                {t("attested")}
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {result.topicBreakdown.length > 0 ? (
        <Card className="[--card-spacing:--spacing(4)]">
          <CardContent className="space-y-2.5">
            <h2 className="text-sm font-medium text-foreground">{t("byTopic")}</h2>
            <ul className="space-y-2">
              {result.topicBreakdown.map((topic) => {
                const share = topic.total === 0 ? 0 : (topic.correct / topic.total) * 100;
                return (
                  <li key={topic.topicSlug} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="truncate text-foreground">{topic.topicName}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {topic.correct}/{topic.total}
                      </span>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                      aria-valuenow={topic.correct}
                      aria-valuemin={0}
                      aria-valuemax={topic.total}
                      aria-label={topic.topicName}
                    >
                      <div
                        className={cn(
                          "h-full rounded-full",
                          share >= 80 ? "bg-[var(--status-success)]" : "bg-primary",
                        )}
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <ol className="space-y-4">
        {result.review.map((question) => (
          <li key={question.position}>
            <Card className="[--card-spacing:--spacing(4)]">
              <CardContent className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("questionNumber", { number: question.position })}
                  {question.correct ? "" : ` · ${t("yourAnswerWrong")}`}
                </p>
                <QuestionCard
                  stem={question.stem}
                  options={question.options}
                  selectedKey={question.answeredOptionKey}
                  imageUrl={question.imageUrl}
                  reveal={{
                    correctOptionKey: question.correctOptionKey,
                    explanation: question.explanation.text,
                  }}
                />
                {question.explanation.citations.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {question.explanation.citations
                      .map((citation) => `${citation.sourceCode} ${citation.ref}`)
                      .join(" · ")}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>

      <p className="text-center text-xs text-muted-foreground">
        {t("recordedAt", {
          when: format.dateTime(new Date(), { dateStyle: "medium" }),
        })}
      </p>
    </div>
  );
}
