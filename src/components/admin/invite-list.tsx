"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState } from "react";
import { revokeInviteAction } from "@/app/[locale]/(admin)/admin/invites/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { Invite } from "@/server/contracts/auth";
import type { ActionResult } from "@/server/contracts/common";
import { CopyLinkButton } from "./copy-link-button";

/** Recent invitations with their state and a revoke control. Desktop-first (admin panel). */
export function InviteList({
  invites,
  now,
}: {
  invites: Invite[];
  /** Server render time — expiry is derived from it, never from a clock read during render. */
  now: Date;
}) {
  const t = useTranslations("admin.invites");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(revokeInviteAction, undefined);

  if (invites.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("listEmpty")}</p>;
  }

  function status(invite: Invite): string {
    if (invite.revokedAt) return t("statusRevoked");
    if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
      return t("statusExpired");
    }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      return t("statusUsedUp");
    }
    return t("statusActive");
  }

  return (
    <div className="space-y-3">
      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      {state?.ok ? <FormAlert tone="success">{t("revoked")}</FormAlert> : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {t("columnRole")}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {t("columnUses")}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {t("columnExpires")}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {t("columnStatus")}
              </th>
              <th scope="col" className="py-2 font-medium">
                {t("columnLink")}
              </th>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr key={invite.id} className="border-b border-border/60">
                <td className="py-2.5 pr-3 align-middle text-foreground">
                  {invite.role}
                </td>
                <td className="py-2.5 pr-3 align-middle text-muted-foreground">
                  {invite.usedCount}
                  {invite.maxUses === null ? "" : ` / ${invite.maxUses}`}
                </td>
                <td className="py-2.5 pr-3 align-middle text-muted-foreground">
                  {invite.expiresAt
                    ? format.dateTime(invite.expiresAt, { dateStyle: "medium" })
                    : "—"}
                </td>
                <td className="py-2.5 pr-3 align-middle text-muted-foreground">
                  {status(invite)}
                </td>
                <td className="py-2.5 align-middle">
                  <div className="flex items-center justify-end gap-2">
                    <CopyLinkButton url={invite.url} />
                    {invite.revokedAt ? null : (
                      <form action={formAction}>
                        <input
                          type="hidden"
                          name="inviteId"
                          value={invite.id}
                        />
                        <SubmitButton label={t("revoke")} variant="ghost" />
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
