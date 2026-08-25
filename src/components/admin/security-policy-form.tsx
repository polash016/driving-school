"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { saveSecurityPolicyAction } from "@/app/[locale]/(admin)/admin/security/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult } from "@/server/contracts/common";
import type { SecurityPolicy } from "@/server/services/auth/security-policy";

/**
 * Turning the admin 2FA requirement off is a real reduction in protection, so the consequence is
 * stated at the moment of the choice rather than buried in documentation.
 */
export function SecurityPolicyForm({
  policy,
  adminsWithout2fa,
}: {
  policy: SecurityPolicy;
  adminsWithout2fa: number;
}) {
  const t = useTranslations("admin.security");
  const tErrors = useTranslations();
  const [required, setRequired] = useState(policy.adminTwoFactorRequired);
  const [approvals, setApprovals] = useState(policy.aiApprovalsRequired);
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(saveSecurityPolicyAction, undefined);

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-base">{t("twoFactorTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {state?.ok === false ? (
          <FormAlert>{tErrors(state.messageKey)}</FormAlert>
        ) : null}
        {state?.ok ? <FormAlert tone="success">{t("saved")}</FormAlert> : null}

        <form action={formAction} className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="adminTwoFactorRequired"
              checked={required}
              onChange={(event) => setRequired(event.target.checked)}
              className="mt-1 size-4"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">
                {t("requireAdminTwoFactor")}
              </span>
              <span className="block text-sm/relaxed text-muted-foreground">
                {t("requireAdminTwoFactorHint")}
              </span>
            </span>
          </label>

          {!required ? (
            <FormAlert tone="error">{t("offWarning")}</FormAlert>
          ) : adminsWithout2fa > 0 ? (
            <FormAlert tone="info">
              {t("pendingEnrolment", { count: adminsWithout2fa })}
            </FormAlert>
          ) : null}

          <div className="space-y-2 border-t border-border pt-4">
            <label className="space-y-1.5">
              <span className="block text-sm font-medium text-foreground">
                {t("aiApprovals")}
              </span>
              <span className="block text-sm/relaxed text-muted-foreground">
                {t("aiApprovalsHint")}
              </span>
              <select
                name="aiApprovalsRequired"
                value={approvals}
                onChange={(event) => setApprovals(Number(event.target.value))}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {[1, 2, 3].map((count) => (
                  <option key={count} value={count}>
                    {t("aiApprovalsOption", { count })}
                  </option>
                ))}
              </select>
            </label>
            {approvals === 1 ? (
              <FormAlert tone="info">{t("aiApprovalsOneWarning")}</FormAlert>
            ) : null}
          </div>

          <SubmitButton label={t("save")} />
        </form>
      </CardContent>
    </Card>
  );
}
