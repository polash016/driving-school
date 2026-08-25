"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { resetPasswordAction } from "@/app/[locale]/(auth)/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth.reset");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(resetPasswordAction, undefined);

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">{t("successTitle")}</FormAlert>
        <p className="text-sm/relaxed text-muted-foreground">
          {t("successBody")}
        </p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("title")}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="token" value={token} />
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      <Field
        label={t("password")}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
        autoFocus
      />
      <SubmitButton className="w-full" label={t("submit")} />
    </form>
  );
}
