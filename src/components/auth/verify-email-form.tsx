"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { verifyEmailAction } from "@/app/[locale]/(auth)/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Link } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";

/**
 * Verification is confirmed with a POST, not by loading the link: mail scanners and link
 * previewers routinely fetch every URL in an email, and a GET would burn the token for them.
 */
export function VerifyEmailForm({ token }: { token: string }) {
  const t = useTranslations("auth.verify");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    verifyEmailAction,
    undefined,
  );

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">{t("successTitle")}</FormAlert>
        <p className="text-sm/relaxed text-muted-foreground">{t("successBody")}</p>
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("toLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="token" value={token} />
      {state?.ok === false ? (
        <>
          <FormAlert>{tErrors(state.messageKey)}</FormAlert>
          <p className="text-sm/relaxed text-muted-foreground">{t("failedBody")}</p>
        </>
      ) : null}
      <SubmitButton className="w-full" label={t("title")} />
    </form>
  );
}
