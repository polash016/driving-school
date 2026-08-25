"use client";

import { useTranslations } from "next-intl";
import { useActionState, useMemo, useState } from "react";
import { startConfiguredQuizAction } from "@/app/[locale]/(student)/quiz/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type { AppLocale } from "../../../config/school.config";

/**
 * Test setup. Everything the student changes updates one honest sentence: whether this attempt
 * will count towards the pass guarantee, and if not, why.
 *
 * The same rule is evaluated again on the server — this screen explains the decision, it does not
 * make it.
 */

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 90;

export function QuizSetup({
  locale,
  timeLimitMin,
  officialCount,
  officialPassMark,
  topics,
}: {
  locale: AppLocale;
  timeLimitMin: number;
  officialCount: number;
  officialPassMark: number;
  topics: { slug: string; label: string }[];
}) {
  const t = useTranslations("quiz.setup");
  const tErrors = useTranslations();

  const [timed, setTimed] = useState(true);
  const [questionCount, setQuestionCount] = useState(officialCount);
  const [selected, setSelected] = useState<string[]>(() => topics.map((topic) => topic.slug));
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    startConfiguredQuizAction,
    undefined,
  );

  // Mirrors evaluateGuarantee() on the server; the server's answer is the one that is stored.
  const warnings = useMemo(() => {
    const reasons: string[] = [];
    if (selected.length < topics.length) reasons.push(t("guaranteeNeedsAllCategories"));
    if (questionCount < officialCount) {
      reasons.push(t("guaranteeNeedsQuestionCount", { count: officialCount }));
    }
    return reasons;
  }, [officialCount, questionCount, selected.length, t, topics.length]);

  const counts = warnings.length === 0;
  const scaledPassMark = Math.ceil((questionCount * officialPassMark) / officialCount);

  function toggleTopic(slug: string) {
    setSelected((current) =>
      current.includes(slug)
        ? current.filter((value) => value !== slug)
        : [...current, slug],
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="questionCount" value={questionCount} />
      <input type="hidden" name="timed" value={timed ? "on" : "off"} />
      {selected.map((slug) => (
        <input key={slug} type="hidden" name="topicSlugs" value={slug} />
      ))}

      {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}

      <Card className="[--card-spacing:--spacing(5)]">
        <CardContent className="space-y-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={timed}
              onChange={(event) => setTimed(event.target.checked)}
              className="mt-1 size-4"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-foreground">
                {t("timeLimit")}
              </span>
              <span className="block text-sm text-muted-foreground">
                {timed
                  ? t("timeLimitOn", { minutes: timeLimitMin })
                  : t("timeLimitOff")}
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardContent className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-foreground">{t("questionCount")}</span>
            <span className="font-mono text-lg font-semibold text-foreground">
              {questionCount}
            </span>
          </div>
          <input
            type="range"
            min={MIN_QUESTIONS}
            max={MAX_QUESTIONS}
            value={questionCount}
            onChange={(event) => setQuestionCount(Number(event.target.value))}
            aria-label={t("questionCount")}
            className="h-11 w-full accent-[var(--brand-primary)]"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{MIN_QUESTIONS}</span>
            <button
              type="button"
              onClick={() => setQuestionCount(officialCount)}
              className="rounded-md px-2 py-1 text-primary underline-offset-4 hover:underline"
            >
              {t("useOfficialLength", { count: officialCount })}
            </button>
            <span>{MAX_QUESTIONS}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("passMarkNote", { mark: scaledPassMark, count: questionCount })}
          </p>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">{t("categories")}</span>
            <button
              type="button"
              onClick={() =>
                setSelected(
                  selected.length === topics.length ? [] : topics.map((topic) => topic.slug),
                )
              }
              className="min-h-11 rounded-md px-2 text-sm text-primary underline-offset-4 hover:underline"
            >
              {selected.length === topics.length ? t("unselectAll") : t("selectAll")}
            </button>
          </div>

          <ul className="space-y-1">
            {topics.map((topic) => {
              const on = selected.includes(topic.slug);
              return (
                <li key={topic.slug}>
                  <label
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors",
                      on ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleTopic(topic.slug)}
                      className="size-4"
                    />
                    {topic.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {/* The whole point of this screen: say now, not afterwards. */}
      {counts ? (
        <FormAlert tone="success">{t("guaranteeCounts")}</FormAlert>
      ) : (
        <div className="space-y-2">
          {warnings.map((warning) => (
            <FormAlert key={warning} tone="info">
              {warning}
            </FormAlert>
          ))}
        </div>
      )}

      <SubmitButton
        className="w-full"
        label={t("start")}
        pendingLabel={t("starting")}
      />
    </form>
  );
}
