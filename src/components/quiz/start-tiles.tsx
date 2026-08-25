"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { startQuizAction } from "@/app/[locale]/(student)/quiz/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/contracts/common";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { AppLocale } from "../../../config/school.config";

/**
 * The way into a test (spec-08 first cut). Practice for learning, mock exam for rehearsal, topic
 * practice for a weak area.
 *
 * A mock exam needs a full blueprint's worth of approved questions; below that the tile says so
 * rather than failing when tapped — an empty pool is a normal state early in a school's life, not
 * an error to hide.
 */

export function StartTiles({
  locale,
  approvedTotal,
  examReady,
  examShortfall,
  topics,
}: {
  locale: AppLocale;
  approvedTotal: number;
  /** A mock exam mirrors the official blueprint: enough per topic, not just enough in total. */
  examReady: boolean;
  examShortfall: number;
  topics: { slug: string; label: string }[];
}) {
  const t = useTranslations("home");
  const tErrors = useTranslations();
  const [topicSlug, setTopicSlug] = useState(topics[0]?.slug ?? "");

  const canPractice = approvedTotal > 0;
  const canExam = examReady;
  const [state, startAction] = useActionState<ActionResult | undefined, FormData>(
    startQuizAction,
    undefined,
  );

  if (!canPractice) {
    return (
      <Card>
        <CardContent className="space-y-2 text-center">
          <p className="font-medium text-foreground">{t("noQuestionsTitle")}</p>
          <p className="text-sm/relaxed text-muted-foreground">{t("noQuestionsBody")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}

      <div className="grid grid-cols-2 gap-3">
        <form action={startAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="mode" value="PRACTICE" />
          <input type="hidden" name="questionCount" value="10" />
          <SubmitButton
            className="h-24 w-full flex-col gap-1"
            label={t("practice")}
            pendingLabel={t("starting")}
          />
        </form>

        {canExam ? (
          // Straight to setup: the student chooses the clock, the length and the categories.
          <Button asChild variant="secondary" className="h-24 w-full flex-col gap-1">
            <Link href="/quiz/new">{t("mockExam")}</Link>
          </Button>
        ) : (
          // Actually disabled, not merely faded: a tile that looks unavailable but still fires
          // is worse than one that is plainly out of reach.
          <Button
            type="button"
            variant="secondary"
            disabled
            title={t("mockExamLockedHint", { topics: examShortfall })}
            className={cn("h-24 w-full flex-col gap-1 whitespace-normal text-sm")}
          >
            {t("mockExamLocked")}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium text-foreground">{t("topicPractice")}</p>
          <form action={startAction} className="flex gap-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="mode" value="TOPIC" />
            <input type="hidden" name="questionCount" value="10" />
            <input type="hidden" name="topicSlug" value={topicSlug} />
            <select
              value={topicSlug}
              onChange={(event) => setTopicSlug(event.target.value)}
              aria-label={t("topicPractice")}
              className="h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
            >
              {topics.map((topic) => (
                <option key={topic.slug} value={topic.slug}>
                  {topic.label}
                </option>
              ))}
            </select>
            <SubmitButton label={t("start")} pendingLabel={t("starting")} />
          </form>
        </CardContent>
      </Card>

    </div>
  );
}
