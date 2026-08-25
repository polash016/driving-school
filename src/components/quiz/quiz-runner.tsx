"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  answerAction,
  revealAction,
  submitAction,
} from "@/app/[locale]/(student)/quiz/actions";
import { QuestionCard } from "@/components/quiz/question-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ClientAttempt } from "@/server/contracts/quiz";
import type { AppLocale } from "../../../config/school.config";

/**
 * The student's quiz screen (spec-08 first cut): one question at a time, mobile-first at 390px.
 *
 * PRACTICE reveals the answer immediately — but only what the SERVER returns after grading that
 * answer. EXAM acknowledges the save and reveals nothing until submission. Neither mode has the
 * correct answer in the page until the server has been asked.
 *
 * An answer is final the moment it is given (developer decision 2026-08-25). The card locks, and
 * coming back to the question shows what was answered rather than a fresh chance at it — in
 * practice mode the correct answer has already been shown, so a second attempt would be a
 * formality. The server and a database trigger refuse the change regardless of what this file
 * does; the lock is here so the student is told, not caught.
 */
export function QuizRunner({
  attempt,
  locale,
}: {
  attempt: ClientAttempt;
  locale: AppLocale;
}) {
  const t = useTranslations("quiz");
  const tErrors = useTranslations();
  const [answers, setAnswers] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      attempt.questions
        .filter((question) => question.answeredOptionKey)
        .map((question) => [question.position, question.answeredOptionKey as string]),
    ),
  );
  const [index, setIndex] = useState(() => {
    const firstUnanswered = attempt.questions.findIndex((q) => !q.answeredOptionKey);
    return firstUnanswered === -1 ? 0 : firstUnanswered;
  });
  // Per question, because the student can navigate back to any answered one.
  const [reveals, setReveals] = useState<
    Record<number, { correctOptionKey: string; explanation: string }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(attempt.timeRemainingSec);
  const [pending, startTransition] = useTransition();

  const question = attempt.questions[index];
  const isPractice = attempt.mode !== "EXAM";
  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === attempt.questions.length;
  const locked = Boolean(answers[question.position]);
  const reveal = reveals[question.position] ?? null;

  // Server-authoritative countdown: this only displays what the server already decided.
  useEffect(() => {
    if (remaining === null) return;
    const timer = setInterval(() => {
      setRemaining((value) => (value === null ? null : Math.max(0, value - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  useEffect(() => {
    if (!isPractice) return;
    const current = attempt.questions[index];
    if (!current) return;
    const answeredKey = answers[current.position];
    if (!answeredKey || reveals[current.position]) return;

    let cancelled = false;
    const form = new FormData();
    form.set("attemptId", attempt.id);
    form.set("position", String(current.position));
    form.set("locale", locale);
    void revealAction(undefined, form).then((result) => {
      if (cancelled || !result.ok) return;
      setReveals((state) => ({
        ...state,
        [current.position]: {
          correctOptionKey: result.data.correctOptionKey,
          explanation: result.data.explanation.text,
        },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [index, isPractice, attempt.id, attempt.questions, answers, reveals, locale]);

  const clock = useMemo(() => {
    if (remaining === null) return null;
    const minutes = Math.floor(remaining / 60);
    return `${minutes}:${String(remaining % 60).padStart(2, "0")}`;
  }, [remaining]);

  function choose(optionKey: string) {
    if (pending || locked) return;
    setError(null);

    const form = new FormData();
    form.set("attemptId", attempt.id);
    form.set("position", String(question.position));
    form.set("optionKey", optionKey);
    form.set("locale", locale);

    startTransition(async () => {
      const result = await answerAction(undefined, form);
      if (!result.ok) {
        setError(tErrors(result.messageKey));
        return;
      }
      setAnswers((current) => ({ ...current, [question.position]: optionKey }));

      // Only practice mode gets an answer back — and only from the server.
      const graded = result.data;
      if ("correctOptionKey" in graded) {
        setReveals((current) => ({
          ...current,
          [question.position]: {
            correctOptionKey: graded.correctOptionKey,
            explanation: graded.explanation.text,
          },
        }));
      }
    });
  }

  function go(nextIndex: number) {
    setError(null);
    setIndex(Math.max(0, Math.min(attempt.questions.length - 1, nextIndex)));
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">
          {t("progress", { current: index + 1, total: attempt.questions.length })}
        </p>
        {clock ? (
          <p
            className={cn(
              "font-mono text-sm font-semibold",
              remaining !== null && remaining < 600 ? "text-[var(--status-warning)]" : "text-foreground",
            )}
            aria-label={t("timeRemaining")}
          >
            {clock}
          </p>
        ) : null}
      </header>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={answeredCount}
        aria-valuemin={0}
        aria-valuemax={attempt.questions.length}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${(answeredCount / attempt.questions.length) * 100}%` }}
        />
      </div>

      {error ? (
        <p role="alert" className="rounded-[var(--radius-control)] bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <QuestionCard
        stem={question.stem}
        options={question.options}
        selectedKey={answers[question.position] ?? null}
        imageUrl={question.imageUrl}
        reveal={reveal}
        onSelect={choose}
        disabled={pending || locked}
      />

      {locked ? (
        <p className="text-center text-xs text-muted-foreground" role="status">
          {t("answerLocked")}
        </p>
      ) : null}

      <nav aria-label={t("questionNavigator")} className="mt-auto flex flex-wrap gap-1.5 pt-4">
        {attempt.questions.map((item, position) => (
          <button
            key={item.position}
            type="button"
            onClick={() => go(position)}
            aria-current={position === index}
            className={cn(
              "size-8 rounded-md text-xs font-medium transition-colors",
              position === index && "ring-2 ring-ring",
              answers[item.position]
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent",
            )}
          >
            {item.position}
          </button>
        ))}
      </nav>
      <div className="flex items-center gap-2 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          {t("previous")}
        </Button>

        {index < attempt.questions.length - 1 ? (
          <Button type="button" size="lg" className="flex-1" onClick={() => go(index + 1)}>
            {t("next")}
          </Button>
        ) : (
          <form action={submitAction} className="flex-1">
            <input type="hidden" name="attemptId" value={attempt.id} />
            <input type="hidden" name="locale" value={locale} />
            <Button type="submit" size="lg" className="w-full" disabled={pending}>
              {allAnswered ? t("submit") : t("submitIncomplete", {
                unanswered: attempt.questions.length - answeredCount,
              })}
            </Button>
          </form>
        )}
      </div>

    </div>
  );
}
