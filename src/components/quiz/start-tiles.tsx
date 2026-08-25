"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  CarProfile,
  Exam,
  ImageSquare,
  TrafficSign,
} from "@phosphor-icons/react/dist/ssr";
import { startQuizAction } from "@/app/[locale]/(student)/quiz/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/contracts/common";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "../../../config/school.config";

/**
 * The way into a test (spec-08/09).
 *
 * Three tiles — Theory, Image, Sign — are ONE engine with one parameter: `itemType` filters which
 * candidates assembly may draw from (DECISIONS 2026-08-24). No separate quiz kinds, no separate
 * code paths, so a fix to the exam experience lands in all three at once.
 *
 * Each tile is gated on its OWN pool. A school typically fills the theory bank long before it has
 * a sign registry or a single uploaded photo, and a tile that looks available but fails on tap is
 * worse than one that is plainly out of reach — so an empty pool renders a genuinely `disabled`
 * button carrying the reason, never a faded-but-live one.
 */

type Counts = { TEXT: number; IMAGE: number; SIGN: number };

export function StartTiles({
  locale,
  counts,
  signTestEnabled,
  examReady,
  examShortfall,
  topics,
}: {
  locale: AppLocale;
  counts: Counts;
  /** School-level switch from config — a school that does not teach signs hides the tile. */
  signTestEnabled: boolean;
  /** A mock exam mirrors the official blueprint: enough per topic, not just enough in total. */
  examReady: boolean;
  examShortfall: number;
  topics: { slug: string; label: string }[];
}) {
  const t = useTranslations("home");
  const tErrors = useTranslations();
  const [topicSlug, setTopicSlug] = useState(topics[0]?.slug ?? "");
  const [state, startAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(startQuizAction, undefined);

  const total = counts.TEXT + counts.IMAGE + counts.SIGN;
  if (total === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 text-center">
          <p className="font-medium text-foreground">{t("noQuestionsTitle")}</p>
          <p className="text-sm/relaxed text-muted-foreground">
            {t("noQuestionsBody")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const tiles = [
    {
      key: "theoryTest",
      itemType: "TEXT" as const,
      mode: "PRACTICE" as const,
      icon: CarProfile,
      available: counts.TEXT > 0,
    },
    {
      key: "imageQuiz",
      itemType: "IMAGE" as const,
      mode: "PRACTICE" as const,
      icon: ImageSquare,
      available: counts.IMAGE > 0,
    },
    ...(signTestEnabled
      ? [
          {
            key: "signTest",
            itemType: "SIGN" as const,
            // SIGN is its own attempt mode, so a sign test is recorded as one in the student's
            // record rather than blurring into general practice.
            mode: "SIGN" as const,
            icon: TrafficSign,
            available: counts.SIGN > 0,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return tile.available ? (
            <form key={tile.key} action={startAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="mode" value={tile.mode} />
              <input type="hidden" name="itemType" value={tile.itemType} />
              <input type="hidden" name="questionCount" value="10" />
              <SubmitButton
                className="h-24 w-full flex-col gap-1.5"
                label={t(tile.key)}
                pendingLabel={t("starting")}
                icon={<Icon size={24} weight="duotone" aria-hidden />}
              />
            </form>
          ) : (
            <Button
              key={tile.key}
              type="button"
              variant="secondary"
              disabled
              title={t("tileEmptyHint")}
              className="h-24 w-full flex-col gap-1.5 whitespace-normal text-sm"
            >
              <Icon size={24} weight="duotone" aria-hidden />
              {t(`${tile.key}Empty` as "theoryTestEmpty")}
            </Button>
          );
        })}

        {examReady ? (
          // Straight to setup: the student chooses the clock, the length and the categories.
          <Button
            asChild
            variant="secondary"
            className="h-24 w-full flex-col gap-1.5"
          >
            <Link href="/quiz/new">
              <Exam size={24} weight="duotone" aria-hidden />
              {t("mockExam")}
            </Link>
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled
            title={t("mockExamLockedHint", { topics: examShortfall })}
            className="h-24 w-full flex-col gap-1.5 whitespace-normal text-sm"
          >
            <Exam size={24} weight="duotone" aria-hidden />
            {t("mockExamLocked")}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium text-foreground">
            {t("topicPractice")}
          </p>
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
