"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  flagTranslationAction,
  type FlagOutcome,
} from "@/app/[locale]/(admin)/admin/languages/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { ActionResult } from "@/server/contracts/common";

/**
 * An admin's way to overrule the checks (spec-21): say what is wrong, hand it to the repair run.
 *
 * One form per language column on the question page. The note is required — it is what the
 * model reads on the next attempt, and "broken" alone tells it nothing.
 */
export function FlagTranslationForm({
  translationId,
  locale,
  languageName,
}: {
  translationId: string;
  locale: string;
  languageName: string;
}) {
  const t = useTranslations("admin.languages.markBroken");
  const tErrors = useTranslations();
  const [state, action] = useActionState<
    ActionResult<FlagOutcome> | undefined,
    FormData
  >(flagTranslationAction, undefined);

  if (state?.ok) {
    return (
      <FormAlert tone="success">
        {state.data.repairQueued
          ? t("doneQueued", { language: languageName })
          : t("done", { language: languageName })}
      </FormAlert>
    );
  }

  return (
    <form action={action} className="space-y-1.5">
      <input type="hidden" name="id" value={translationId} />
      <input type="hidden" name="code" value={locale} />
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      <input
        name="note"
        required
        minLength={3}
        maxLength={500}
        aria-label={`${t("note")} — ${languageName}`}
        placeholder={t("notePlaceholder")}
        className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-2 text-xs"
      />
      <label className="flex min-h-11 items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          name="repair"
          defaultChecked
          className="size-4"
        />
        <span>{t("repair")}</span>
      </label>
      <SubmitButton
        className="h-9"
        variant="destructive"
        label={t("submit")}
        pendingLabel={t("pending")}
      />
    </form>
  );
}
