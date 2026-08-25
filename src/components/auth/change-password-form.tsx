"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { changePasswordAction } from "@/app/[locale]/(account)/account/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { ActionResult } from "@/server/contracts/common";

export function ChangePasswordForm() {
  const t = useTranslations("auth.account");
  const tErrors = useTranslations();
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    changePasswordAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      {state?.ok ? <FormAlert tone="success">{t("changed")}</FormAlert> : null}

      <Field
        label={t("currentPassword")}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />
      <Field
        label={t("newPassword")}
        name="newPassword"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
      />
      <SubmitButton label={t("changeSubmit")} />
    </form>
  );
}
