"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { createInviteAction } from "@/app/[locale]/(admin)/admin/invites/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { GroupOption } from "@/server/services/groups";
import type { Invite } from "@/server/contracts/auth";
import type { ActionResult } from "@/server/contracts/common";
import { CopyLinkButton } from "./copy-link-button";

export function InviteCreateForm({ groups }: { groups: GroupOption[] }) {
  const t = useTranslations("admin.invites");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<
    ActionResult<Invite> | undefined,
    FormData
  >(createInviteAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      {state?.ok ? (
        <div className="space-y-2">
          <FormAlert tone="success">{t("created")}</FormAlert>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] bg-muted px-3 py-2 text-xs text-foreground">
              {state.data.url}
            </code>
            <CopyLinkButton url={state.data.url} />
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor="invite-role"
            className="block text-sm font-medium text-foreground"
          >
            {t("role")}
          </label>
          <select
            id="invite-role"
            name="role"
            defaultValue="STUDENT"
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            <option value="STUDENT">STUDENT</option>
            <option value="INSTRUCTOR">INSTRUCTOR</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="invite-group"
            className="block text-sm font-medium text-foreground"
          >
            {t("group")}
          </label>
          <select
            id="invite-group"
            name="groupId"
            defaultValue=""
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            <option value="">{t("noGroup")}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>

        <Field
          label={t("maxUses")}
          name="maxUses"
          type="number"
          min={1}
          max={500}
          defaultValue={1}
          hint={t("singleUse")}
        />
        <Field
          label={t("expiresIn")}
          name="expiresInDays"
          type="number"
          min={1}
          max={90}
          defaultValue={14}
        />
      </div>

      <SubmitButton label={t("create")} />
    </form>
  );
}
