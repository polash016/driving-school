"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { importStudentsAction } from "@/app/[locale]/(admin)/admin/invites/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { CsvImportResult } from "@/server/contracts/auth";
import type { ActionResult } from "@/server/contracts/common";
import type { GroupOption } from "@/server/services/groups";

/** Bulk import: every valid row gets a personal single-use invite by email. */
export function CsvImportForm({ groups }: { groups: GroupOption[] }) {
  const t = useTranslations("admin.invites");
  const tErrors = useTranslations();
  const locale = useLocale();
  const [state, formAction] = useActionState<
    ActionResult<CsvImportResult> | undefined,
    FormData
  >(importStudentsAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state?.ok === false ? (
        <FormAlert>{tErrors(state.messageKey)}</FormAlert>
      ) : null}
      {state?.ok ? (
        <div className="space-y-2">
          <FormAlert tone="success">
            {t("csvResult", {
              invited: state.data.invited,
              skipped: state.data.skipped,
            })}
          </FormAlert>
          <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
            {state.data.rows.map((row, index) => (
              <li
                key={`${row.email}-${index}`}
                className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5"
              >
                <span className="truncate text-foreground">{row.email || "—"}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {tErrors(row.messageKey)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-sm/relaxed text-muted-foreground">{t("csvHelp")}</p>

      <div className="space-y-1.5">
        <label
          htmlFor="csv-file"
          className="block text-sm font-medium text-foreground"
        >
          {t("csvLabel")}
        </label>
        <input
          id="csv-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          className="block w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 py-2.5 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="csv-group"
          className="block text-sm font-medium text-foreground"
        >
          {t("group")}
        </label>
        <select
          id="csv-group"
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

      <SubmitButton label={t("csvSubmit")} />
    </form>
  );
}
