"use client";

import { CarIcon, TrafficSignIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { startQuizAction } from "@/app/[locale]/(student)/quiz/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";
import type { AppLocale } from "../../../config/school.config";

/**
 * The two secondary ways into a question (spec-16).
 *
 * **Practice** opens the setup screen — length, timer, categories — because practice is the
 * configurable path; a task set is the fixed one. **Sign test** goes straight in, unchanged from
 * before: one tap, ten signs, instant feedback.
 *
 * The Theory Test and Image Quiz tiles are gone (spec-16, DECISIONS 2026-09-03). The official
 * teoriprøven mixes text, image and sign questions in one paper, so splitting them into separate
 * student-facing modules exposed an authoring distinction the exam does not make.
 * `startQuizInput.itemType` remains in the engine — Sign test still uses it.
 *
 * Sign test is still gated on its OWN pool: a school with a full theory bank and no sign registry
 * gets an honestly disabled tile rather than one that fails on tap.
 */
export function StartTiles({
  locale,
  signCount,
  signTestEnabled,
}: {
  locale: AppLocale;
  signCount: number;
  /** School-level switch from config — a school that does not teach signs hides the tile. */
  signTestEnabled: boolean;
}) {
  const t = useTranslations("home");
  const tErrors = useTranslations();
  const [state, startAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(startQuizAction, undefined);

  const signAvailable = signTestEnabled && signCount > 0;

  return (
    <div className="space-y-3">
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Card className="glass-lift rounded-[calc(var(--radius-base)+6px)] p-0">
          <CardContent className="p-0">
            <Link
              href="/quiz/new"
              className="flex min-h-[8.75rem] flex-col items-center justify-center gap-2 rounded-[calc(var(--radius-base)+6px)] px-2 py-5 text-center transition-transform duration-150 outline-none active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              {/* Tinted chip from tokens (spec-18) — the glow and the fill are a school's to
                  re-theme. Sized by CLASS, not the `size` prop: Button forces any svg without a
                  `size-` class down to 16px, and the two tiles must match whichever element
                  wraps them. */}
              <span
                className="grid size-14 place-items-center rounded-[1.15rem] shadow-[var(--chip-brand-glow),inset_0_1px_0_oklch(1_0_0/0.85)]"
                style={{
                  backgroundImage: "var(--chip-brand-bg)",
                  color: "var(--chip-brand-fg)",
                }}
              >
                <CarIcon weight="fill" className="size-8" aria-hidden />
              </span>
              <span className="text-sm font-semibold text-foreground">
                {t("practice")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("practiceSub")}
              </span>
            </Link>
          </CardContent>
        </Card>

        {signTestEnabled ? (
          <Card className="glass-lift rounded-[calc(var(--radius-base)+6px)] p-0">
            <CardContent className="p-0">
              {signAvailable ? (
                <form action={startAction} className="contents">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="mode" value="SIGN" />
                  <input type="hidden" name="itemType" value="SIGN" />
                  <input type="hidden" name="questionCount" value="10" />
                  <SubmitButton
                    variant="ghost"
                    className="flex h-auto min-h-[8.75rem] w-full flex-col items-center justify-center gap-2 rounded-[calc(var(--radius-base)+6px)] px-2 py-5 whitespace-normal hover:bg-transparent dark:hover:bg-transparent"
                    label={t("signTest")}
                    pendingLabel={t("starting")}
                    icon={
                      // The glyph runs larger than the car inside an identical chip: a diamond
                      // has far less visual mass than a car silhouette at the same box, so equal
                      // numbers look unequal. This is what makes the pair read as a pair.
                      <span
                        className="grid size-14 place-items-center rounded-[1.15rem] shadow-[var(--chip-accent-glow),inset_0_1px_0_oklch(1_0_0/0.85)]"
                        style={{
                          backgroundImage: "var(--chip-accent-bg)",
                          color: "var(--chip-accent-fg)",
                        }}
                      >
                        <TrafficSignIcon
                          weight="fill"
                          className="size-9"
                          aria-hidden
                        />
                      </span>
                    }
                    sublabel={t("signTestSub", { count: signCount })}
                  />
                </form>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  disabled
                  title={t("tileEmptyHint")}
                  className="flex h-auto min-h-[8.75rem] w-full flex-col items-center justify-center gap-2 rounded-[calc(var(--radius-base)+6px)] px-2 py-5 text-sm whitespace-normal hover:bg-transparent dark:hover:bg-transparent"
                >
                  <span className="grid size-14 place-items-center rounded-[1.15rem] bg-muted text-muted-foreground">
                    <TrafficSignIcon
                      weight="fill"
                      className="size-9"
                      aria-hidden
                    />
                  </span>
                  {t("signTestEmpty")}
                </Button>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
