"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState } from "react";
import { startTaskSetAction } from "@/app/[locale]/(student)/quiz/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";
import type {
  StudentTaskSet,
  TaskSetAttempt,
} from "@/server/contracts/task-sets";
import type { AppLocale } from "../../../config/school.config";

/**
 * What a tap on a numbered tile opens (spec-16).
 *
 * The sheet exists because a task set can be retried: the student needs somewhere to see what
 * they scored before deciding to sit it again, and a passed set needs somewhere to keep saying it
 * is passed. It also explains, in one line, why a retry is not the same paper — `poolNote` is the
 * honest version of "we shuffled it".
 *
 * Radix's Dialog gives the focus trap, the Esc handler and the return of focus to the tile that
 * opened it, so those are not reimplemented here.
 */
export function TaskSetSheet({
  set,
  attempts,
  locale,
  open,
  onOpenChange,
}: {
  set: StudentTaskSet | null;
  attempts: TaskSetAttempt[];
  locale: AppLocale;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("taskSets");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(startTaskSetAction, undefined);

  if (!set) return null;

  const minutes = Math.round(set.timeLimitSec / 60);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85vh] gap-0 overflow-y-auto rounded-t-[calc(var(--radius-base)+6px)] sm:max-w-md"
      >
        <SheetHeader className="gap-1.5 pb-2">
          <div className="flex items-start justify-between gap-3 pr-8">
            <SheetTitle className="text-lg font-semibold tracking-tight">
              {t("setNumber", { number: set.number })}
            </SheetTitle>
            {set.passed ? (
              <span className="shrink-0 rounded-full bg-[var(--status-success)] px-2.5 py-1 text-[0.7rem] font-semibold text-[var(--status-success-fg)]">
                {t("passed")}
              </span>
            ) : null}
          </div>
          <SheetDescription className="text-sm text-muted-foreground">
            {t("meta", {
              count: set.paperSize,
              minutes,
              mark: set.passMark,
            })}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-5">
          <dl className="grid grid-cols-3 gap-2">
            <Stat
              label={t("best")}
              value={
                set.bestCorrect !== null && set.bestOutOf !== null
                  ? t("scoreOf", {
                      correct: set.bestCorrect,
                      total: set.bestOutOf,
                    })
                  : "—"
              }
            />
            <Stat label={t("attempts")} value={String(set.attempts)} />
            <Stat label={t("inPool")} value={String(set.poolSize)} />
          </dl>

          {state?.ok === false ? (
            <FormAlert>{tErrors(state.messageKey)}</FormAlert>
          ) : null}

          {set.inProgressAttemptId ? (
            // An unfinished sitting is offered back before a new one is started — starting a
            // second paper for the same set would abandon answers the student already gave.
            <Button asChild className="h-12 w-full text-base">
              <Link href={`/quiz/${set.inProgressAttemptId}`}>
                {t("resume")}
              </Link>
            </Button>
          ) : (
            <form action={formAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="taskSetId" value={set.id} />
              <SubmitButton
                className="h-12 w-full text-base"
                label={set.attempts === 0 ? t("start") : t("tryAgain")}
                pendingLabel={t("starting")}
              />
            </form>
          )}

          <p className="text-center text-xs/relaxed text-muted-foreground">
            {t("poolNote", { paper: set.paperSize, pool: set.poolSize })}
          </p>

          <section className="space-y-1">
            <h3 className="text-[0.7rem] font-bold tracking-wide text-muted-foreground uppercase">
              {t("yourAttempts")}
            </h3>
            {attempts.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                {t("noAttempts")}
              </p>
            ) : (
              <ul>
                {attempts.map((attempt) => (
                  <li
                    key={attempt.id}
                    className="flex items-center justify-between gap-3 border-t border-border/60 py-2.5 text-sm"
                  >
                    <span className="font-semibold tabular-nums text-foreground">
                      {attempt.correctCount === null
                        ? "—"
                        : t("scoreOf", {
                            correct: attempt.correctCount,
                            total: attempt.outOf,
                          })}
                    </span>
                    <span className="flex-1 truncate text-xs text-muted-foreground">
                      {format.dateTime(attempt.startedAt, {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                    <AttemptChip attempt={attempt} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-muted px-2 py-2.5 text-center">
      <dd className="text-[0.95rem] font-bold tabular-nums text-foreground">
        {value}
      </dd>
      <dt className="mt-0.5 text-[0.6rem] tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
    </div>
  );
}

function AttemptChip({ attempt }: { attempt: TaskSetAttempt }) {
  const t = useTranslations("taskSets");

  if (attempt.status === "IN_PROGRESS") {
    return (
      <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-semibold text-primary">
        {t("inProgress")}
      </span>
    );
  }
  return (
    <span
      className={
        attempt.passed
          ? "shrink-0 rounded-full bg-[var(--status-success-soft)] px-2 py-0.5 text-[0.65rem] font-semibold text-[var(--status-success)]"
          : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.65rem] font-semibold text-muted-foreground"
      }
    >
      {attempt.passed ? t("passed") : t("failed")}
    </span>
  );
}
