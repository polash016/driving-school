"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  bulkApproveAction,
  editTranslationAction,
  reviewTranslationAction,
  type BulkApproveOutcome,
} from "@/app/[locale]/(admin)/admin/languages/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";

/**
 * QA codes stated in words.
 *
 * The reviewer reads the language but does not read our source: "the speed limit changed" is
 * something they can act on, "NUMBER_DRIFT" is not. An unrecognised code falls through to itself
 * rather than rendering an empty chip.
 */
const FLAG_KEYS = [
  "NUMBER_DRIFT",
  "CITATION_DRIFT",
  "KEY_MISMATCH",
  "OPTION_COUNT",
  "ANSWER_KEY_LOST",
  "ANSWER_PERMUTED",
  "SEMANTIC_DRIFT",
  "PLACEHOLDER_LOST",
  "SLOT_LOST",
  "UNTRANSLATED",
  "EMPTY_FIELD",
  "STEM_MISSING",
  "LENGTH_OUTLIER",
  "MODEL_FLAGGED",
  "QA_UNAVAILABLE",
] as const;

type FlagKey = (typeof FLAG_KEYS)[number];

function flagLabel(
  t: ReturnType<typeof useTranslations<"admin.languages">>,
  flag: string,
): string {
  return (FLAG_KEYS as readonly string[]).includes(flag)
    ? t(`flags.${flag as FlagKey}`)
    : flag;
}

export interface ReviewRow {
  id: string;
  entity: string;
  entityId: string;
  status: string;
  label: string;
  qaFlags: string[];
  semanticScore: number | null;
  source: Record<string, unknown> | null;
  value: Record<string, unknown>;
}

/**
 * Reviewing translations (spec-15).
 *
 * Laid out source-left, translation-right, with the QA flags stated in words rather than as codes:
 * the person doing this reads the language but does not read our source, and "the speed limit
 * changed" is actionable where "NUMBER_DRIFT" is not.
 *
 * Rows are keyed by option key rather than by position, which is what makes a swapped or missing
 * option visible at a glance — that being the whole point of putting them side by side.
 */
export function TranslationReview({
  code,
  direction,
  rows,
  pendingClean,
}: {
  code: string;
  direction: "LTR" | "RTL";
  rows: ReviewRow[];
  /** Clean machine translations waiting — what a bulk approve would clear. */
  pendingClean: number;
}) {
  const t = useTranslations("admin.languages");
  const tErrors = useTranslations();
  const [editing, setEditing] = useState<string | null>(null);

  const [reviewState, reviewAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(reviewTranslationAction, undefined);
  const [editState, editAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(editTranslationAction, undefined);
  const [bulkState, bulkAction] = useActionState<
    ActionResult<BulkApproveOutcome> | undefined,
    FormData
  >(bulkApproveAction, undefined);
  const error = [reviewState, editState, bulkState].find(
    (state) => state?.ok === false,
  );

  const banner = (
    <>
      {error?.ok === false ? (
        <FormAlert>{tErrors(error.messageKey)}</FormAlert>
      ) : null}
      {bulkState?.ok ? (
        <FormAlert tone="success">
          {t("bulkApproved", {
            approved: bulkState.data.approved,
            skipped: bulkState.data.skipped,
          })}
        </FormAlert>
      ) : null}
      {pendingClean > 0 ? (
        <form
          action={bulkAction}
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius-base)] border border-border bg-muted/40 p-3"
        >
          <input type="hidden" name="code" value={code} />
          <SubmitButton
            className="h-9"
            label={t("bulkApprove", { count: pendingClean })}
            pendingLabel={t("saving")}
          />
          {/* The line that keeps a bulk action honest: it never touches a finding. */}
          <span className="text-xs text-muted-foreground">
            {t("bulkApproveNote")}
          </span>
        </form>
      ) : null}
    </>
  );

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        {banner}
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("reviewEmpty")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {banner}

      {rows.map((row) => {
        const sourceOptions = (row.source?.options ?? []) as Array<{
          key: string;
          text: string;
        }>;
        const valueOptions = (row.value.options ?? []) as Array<{
          key: string;
          text: string;
        }>;
        const translatedByKey = new Map(
          valueOptions.map((option) => [option.key, option.text]),
        );

        return (
          <Card key={row.id} className="[--card-spacing:--spacing(4)]">
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {row.entity}
                  {row.semanticScore !== null
                    ? ` · ${t("drift", { score: row.semanticScore.toFixed(2) })}`
                    : ""}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {row.qaFlags.map((flag) => (
                    <span
                      key={flag}
                      className="rounded-full bg-destructive/10 px-2 py-0.5 text-[0.6875rem] font-medium text-destructive"
                      title={flag}
                    >
                      {flagLabel(t, flag)}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 rounded-[var(--radius-control)] bg-muted/50 p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("sourceSide")}
                  </p>
                  <p className="text-sm text-foreground" lang="en">
                    {String(
                      row.source?.stem ??
                        row.source?.name ??
                        row.source?.text ??
                        "",
                    )}
                  </p>
                  {sourceOptions.length > 0 ? (
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {sourceOptions.map((option) => (
                        <li key={option.key}>
                          <span className="font-mono text-xs">
                            {option.key}
                          </span>{" "}
                          {option.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div
                  className="space-y-2 rounded-[var(--radius-control)] bg-accent/40 p-3"
                  lang={code}
                  dir={direction === "RTL" ? "rtl" : "ltr"}
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("translationSide")}
                  </p>
                  <p className="text-sm text-foreground">
                    {String(
                      row.value.stem ?? row.value.name ?? row.value.text ?? "",
                    )}
                  </p>
                  {sourceOptions.length > 0 ? (
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {/* Keyed off the SOURCE options, so a missing translation is a visible gap
                          rather than a shorter list nobody notices. */}
                      {sourceOptions.map((option) => (
                        <li key={option.key}>
                          <span className="font-mono text-xs">
                            {option.key}
                          </span>{" "}
                          <span
                            className={cn(
                              !translatedByKey.get(option.key) &&
                                "text-destructive italic",
                            )}
                          >
                            {translatedByKey.get(option.key) ??
                              t("optionMissing")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>

              {editing === row.id ? (
                <form action={editAction} className="space-y-2">
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="code" value={code} />
                  <label
                    className="block text-xs text-muted-foreground"
                    htmlFor={`v-${row.id}`}
                  >
                    {t("editLabel")}
                  </label>
                  <textarea
                    id={`v-${row.id}`}
                    name="value"
                    rows={6}
                    defaultValue={JSON.stringify(row.value, null, 2)}
                    className="w-full rounded-[var(--radius-control)] border border-input bg-transparent p-2 font-mono text-xs text-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("editHint")}
                  </p>
                  <div className="flex gap-2">
                    <SubmitButton
                      className="h-9"
                      label={t("saveEdit")}
                      pendingLabel={t("saving")}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <form action={reviewAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="code" value={code} />
                    <input type="hidden" name="action" value="APPROVE" />
                    <SubmitButton
                      className="h-9"
                      label={t("approve")}
                      pendingLabel={t("saving")}
                    />
                  </form>
                  <form
                    action={reviewAction}
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="code" value={code} />
                    <input type="hidden" name="action" value="REJECT" />
                    <input
                      name="note"
                      placeholder={t("rejectNote")}
                      className="h-9 w-56 rounded-[var(--radius-control)] border border-input bg-transparent px-2 text-sm"
                    />
                    <SubmitButton
                      className="h-9"
                      variant="destructive"
                      label={t("reject")}
                      pendingLabel={t("saving")}
                    />
                  </form>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(row.id)}
                  >
                    {t("edit")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
