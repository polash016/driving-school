"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { completeTotpSetupAction } from "@/app/[locale]/(auth)/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { ActionResult } from "@/server/contracts/common";

/** Forced admin enrolment during login — the setup ticket lives in an httpOnly cookie. */
export function TotpSetupForm({
  qrDataUrl,
  secret,
}: {
  qrDataUrl: string;
  secret: string;
}) {
  const t = useTranslations("auth.twoFactor");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(completeTotpSetupAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}

      <ol className="space-y-1.5 text-sm/relaxed text-muted-foreground">
        <li>{t("step1")}</li>
        <li>{t("step2")}</li>
        <li>{t("step3")}</li>
      </ol>

      <div className="flex justify-center rounded-[var(--radius-control)] bg-white p-3">
        <Image
          src={qrDataUrl}
          alt={t("qrAlt")}
          width={200}
          height={200}
          unoptimized
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          {t("secretLabel")}
        </p>
        <p className="rounded-[var(--radius-control)] bg-muted px-3 py-2 font-mono text-sm break-all text-foreground">
          {secret}
        </p>
      </div>

      <Field
        label={t("codeLabel")}
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        required
        autoFocus
      />
      <SubmitButton className="w-full" label={t("confirm")} />
    </form>
  );
}
