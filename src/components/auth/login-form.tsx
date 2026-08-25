"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  loginAction,
  resendVerificationAction,
} from "@/app/[locale]/(auth)/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";

/**
 * Login form. Two-factor is a second step of the same form: the service answers
 * TOTP_REQUIRED, the code field appears, and the already-typed credentials are re-submitted
 * with it — no separate page, no re-typing.
 */
export function LoginForm() {
  const t = useTranslations("auth.login");
  const tErrors = useTranslations();
  const tVerify = useTranslations("auth.verify");
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    loginAction,
    undefined,
  );
  const [resendState, resendAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(resendVerificationAction, undefined);

  const needsTotp = state?.ok === false && state.code === "TOTP_REQUIRED";
  const showError = state?.ok === false && !needsTotp;
  const unverified =
    state?.ok === false && state.messageKey === "auth.errors.emailNotVerified";

  const form = (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {showError ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
      {needsTotp ? (
        <FormAlert tone="info">{t("totpSubtitle")}</FormAlert>
      ) : null}

      <Field
        label={t("email")}
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        autoFocus={!needsTotp}
        readOnly={needsTotp}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Field
        label={t("password")}
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      {needsTotp ? (
        <Field
          label={t("totpLabel")}
          name="totpCode"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          required
          autoFocus
        />
      ) : null}

      <SubmitButton
        className="w-full"
        label={needsTotp ? t("totpSubmit") : t("submit")}
      />

      <div className="flex flex-col items-center gap-1 pt-1 text-sm">
        <Link
          href="/forgot-password"
          className="rounded-md text-primary underline-offset-4 hover:underline"
        >
          {t("forgot")}
        </Link>
      </div>
    </form>
  );

  return (
    <div className="space-y-4">
      {form}
      {/* A dead end otherwise: an unverified account cannot log in and has no other route back. */}
      {unverified && !resendState?.ok ? (
        <form action={resendAction} className="border-t border-border pt-4">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="email" value={email} />
          <SubmitButton
            className="w-full"
            variant="outline"
            label={t("resendVerification")}
          />
        </form>
      ) : null}
      {resendState?.ok ? (
        <FormAlert tone="success">{tVerify("resentBody")}</FormAlert>
      ) : null}
    </div>
  );
}
