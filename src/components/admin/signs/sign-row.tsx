"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { saveSignAction } from "@/app/[locale]/(admin)/admin/signs/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Field } from "@/components/auth/field";
import type { ActionResult } from "@/server/contracts/common";

export type EditableSign = {
  id: string;
  code: string;
  signClass: string;
  svgPath: string;
  nameEn: string;
  nameNb: string;
  meaningEn: string;
  meaningNb: string;
  isActive: boolean;
  provisional: boolean;
  sourceNote: string | null;
};

/**
 * One sign, expanded on demand.
 *
 * Collapsed by default because the registry runs to a few hundred rows and the reviewer's job is
 * to scan the graphic against its name — mounting several hundred editable forms would cost far
 * more than it buys, and the thumbnail is what the check actually turns on.
 */
export function SignRow({ sign }: { sign: EditableSign }) {
  const t = useTranslations("admin.signs");
  const tErrors = useTranslations();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(saveSignAction, undefined);

  return (
    <li className="rounded-[var(--radius-base)] ring-1 ring-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- public registry asset */}
        <img
          src={sign.svgPath}
          alt=""
          loading="lazy"
          className="size-12 shrink-0 rounded-sm bg-muted object-contain"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {sign.nameEn}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {sign.code} · {sign.nameNb}
          </span>
        </span>
        {sign.provisional ? (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            {t("provisionalBadge")}
          </span>
        ) : null}
      </button>

      {open ? (
        <form
          action={formAction}
          className="space-y-3 border-t border-border px-3 py-3"
        >
          {state?.ok === false ? (
            <FormAlert>{tErrors(state.messageKey)}</FormAlert>
          ) : null}
          {state?.ok === true ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("saved")}
            </p>
          ) : null}
          <input type="hidden" name="id" value={sign.id} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("code")}
              name="code"
              defaultValue={sign.code}
              required
            />
            <Field
              label={t("nameEn")}
              name="nameEn"
              defaultValue={sign.nameEn}
              required
            />
            <Field
              label={t("nameNb")}
              name="nameNb"
              defaultValue={sign.nameNb}
              required
            />
            <Field
              label={t("meaningEn")}
              name="meaningEn"
              defaultValue={sign.meaningEn}
              required
            />
            <Field
              label={t("meaningNb")}
              name="meaningNb"
              defaultValue={sign.meaningNb}
              required
            />
          </div>

          {sign.sourceNote ? (
            <p className="text-xs text-muted-foreground">
              {t("sourceNote")}: {sign.sourceNote}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked={sign.isActive}
                className="size-4"
              />
              {t("active")}
            </label>
            {sign.provisional ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="reviewed" className="size-4" />
                {t("markReviewed")}
              </label>
            ) : null}
          </div>

          <SubmitButton label={t("save")} />
        </form>
      ) : null}
    </li>
  );
}
