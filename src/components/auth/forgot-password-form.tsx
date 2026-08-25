"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { forgotPasswordAction } from "@/app/[locale]/(auth)/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";

/** The response is identical for known and unknown addresses (no user enumeration). */
export function ForgotPasswordForm() {
  const t = useTranslations("auth.forgot");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    forgotPasswordAction,
    undefined,
  );

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">{t("sentTitle")}</FormAlert>
        <p className="text-sm/relaxed text-muted-foreground">{t("sentBody")}</p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      <Field
        label={t("email")}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        autoFocus
      />
      <SubmitButton className="w-full" label={t("submit")} />
    </form>
  );
}
