"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { registerAction } from "@/app/[locale]/(auth)/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";

/** Invite-only registration. The invite token rides along as a hidden field. */
export function RegisterForm({
  inviteToken,
  presetEmail,
}: {
  inviteToken: string;
  presetEmail?: string;
}) {
  const t = useTranslations("auth.register");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(registerAction, undefined);

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">{t("successTitle")}</FormAlert>
        <p className="text-sm/relaxed text-muted-foreground">
          {t("successBody", { email: presetEmail ?? "" })}
        </p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("haveAccount")}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="inviteToken" value={inviteToken} />

      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t("firstName")}
          name="firstName"
          autoComplete="given-name"
          required
          autoFocus
        />
        <Field
          label={t("lastName")}
          name="lastName"
          autoComplete="family-name"
          required
        />
      </div>
      <Field
        label={t("email")}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        defaultValue={presetEmail}
        readOnly={Boolean(presetEmail)}
        required
      />
      <Field
        label={t("password")}
        name="password"
        type="password"
        autoComplete="new-password"
        hint={t("passwordHint")}
        minLength={10}
        required
      />

      <SubmitButton className="w-full" label={t("submit")} />
    </form>
  );
}
