"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useActionState, useState, useTransition } from "react";
import {
  confirmTotpAction,
  disableTotpAction,
  startTotpAction,
} from "@/app/[locale]/(account)/account/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import type { TotpSetup } from "@/server/contracts/auth";
import type { ActionResult } from "@/server/contracts/common";

/**
 * Self-service 2FA. Enrolment is two steps in place: fetch a pending secret, then prove the
 * authenticator works before anything is stored against the account.
 */
export function TwoFactorCard({
  enabled,
  required,
}: {
  enabled: boolean;
  required: boolean;
}) {
  const t = useTranslations("auth.twoFactor");
  const tAccount = useTranslations("auth.account");
  const tErrors = useTranslations();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, startTransition] = useTransition();

  const [confirmState, confirmAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(confirmTotpAction, undefined);
  const [disableState, disableAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(disableTotpAction, undefined);

  if (enabled && !confirmState?.ok) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">{tAccount("twoFactorOn")}</FormAlert>
        {required ? (
          <p className="text-sm/relaxed text-muted-foreground">
            {tAccount("twoFactorRequired")}
          </p>
        ) : (
          <form action={disableAction} className="space-y-4" noValidate>
            {disableState?.ok === false ? (
              <FormAlert>{tErrors(disableState.messageKey)}</FormAlert>
            ) : null}
            <Field
              label={tAccount("disablePassword")}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <SubmitButton label={tAccount("disable")} variant="destructive" />
          </form>
        )}
      </div>
    );
  }

  if (confirmState?.ok) {
    return (
      <div className="space-y-2">
        <FormAlert tone="success">{t("enabledTitle")}</FormAlert>
        <p className="text-sm/relaxed text-muted-foreground">{t("enabledBody")}</p>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-4">
        <p className="text-sm/relaxed text-muted-foreground">
          {tAccount("twoFactorOff")}
        </p>
        {startError ? <FormAlert>{tErrors(startError)}</FormAlert> : null}
        <Button
          type="button"
          size="lg"
          disabled={starting}
          aria-busy={starting}
          onClick={() =>
            startTransition(async () => {
              const result = await startTotpAction();
              if (result.ok) setSetup(result.data);
              else setStartError(result.messageKey);
            })
          }
        >
          {tAccount("enable")}
        </Button>
      </div>
    );
  }

  return (
    <form action={confirmAction} className="space-y-4" noValidate>
      {confirmState?.ok === false ? (
        <FormAlert>{tErrors(confirmState.messageKey)}</FormAlert>
      ) : null}
      <ol className="space-y-1.5 text-sm/relaxed text-muted-foreground">
        <li>{t("step1")}</li>
        <li>{t("step2")}</li>
        <li>{t("step3")}</li>
      </ol>
      <div className="flex justify-center rounded-[var(--radius-control)] bg-white p-3">
        <Image
          src={setup.qrDataUrl}
          alt={t("qrAlt")}
          width={200}
          height={200}
          unoptimized
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t("secretLabel")}</p>
        <p className="rounded-[var(--radius-control)] bg-muted px-3 py-2 font-mono text-sm break-all text-foreground">
          {setup.secret}
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
      />
      <div className="flex gap-2">
        <SubmitButton label={t("confirm")} />
        <Button type="button" variant="ghost" size="lg" onClick={() => setSetup(null)}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
