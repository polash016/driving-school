"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  createSetAction,
  generateQuestionsAction,
  type GenerationSummary,
} from "@/app/[locale]/(admin)/admin/questions/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { BatchSummary } from "@/server/contracts/question-bank";
import type { ActionResult } from "@/server/contracts/common";

export function SetBoard({
  sets,
  topics,
}: {
  sets: BatchSummary[];
  topics: { id: string; label: string }[];
}) {
  const t = useTranslations("admin.sets");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [state, formAction] = useActionState<
    ActionResult<{ id: string }> | undefined,
    FormData
  >(createSetAction, undefined);
  const [genState, genAction] = useActionState<
    ActionResult<GenerationSummary> | undefined,
    FormData
  >(generateQuestionsAction, undefined);

  return (
    <div className="space-y-5">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("generateTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm/relaxed text-muted-foreground">
            {t("generateHint")}
          </p>
          <form
            action={genAction}
            className="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end"
          >
            <label className="space-y-1.5 text-sm font-medium">
              {t("sourceTopic")}
              <select
                name="topicId"
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.label}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={t("generateCount")}
              name="count"
              type="number"
              min={1}
              max={10}
              defaultValue={5}
            />
            <SubmitButton
              label={t("generate")}
              pendingLabel={t("generating")}
            />
          </form>

          {genState?.ok === false ? (
            <FormAlert>{tErrors(genState.messageKey)}</FormAlert>
          ) : null}
          {genState?.ok ? (
            <FormAlert tone="success">
              {t("generated", {
                accepted: genState.data.accepted,
                returned: genState.data.returned,
                rejected: genState.data.rejected,
              })}
            </FormAlert>
          ) : null}
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("create")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            action={formAction}
            className="grid gap-3 md:grid-cols-[1fr_2fr_auto] md:items-end"
          >
            <label className="space-y-1.5 text-sm font-medium">
              {t("sourceTopic")}
              <select
                name="topicId"
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.label}
                  </option>
                ))}
              </select>
            </label>
            <Field label={t("notes")} name="notes" />
            <SubmitButton label={t("create")} />
          </form>
          {state?.ok === false ? (
            <FormAlert className="mt-3">{tErrors(state.messageKey)}</FormAlert>
          ) : null}
          {state?.ok ? (
            <FormAlert tone="success" className="mt-3">
              {t("created")}
            </FormAlert>
          ) : null}
        </CardContent>
      </Card>

      {sets.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-base)] bg-card shadow-card ring-1 ring-foreground/5">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="p-3 font-medium">
                  {t("columnSet")}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {t("columnItems")}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {t("columnAccepted")}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {t("columnCreated")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sets.map((set) => (
                <tr
                  key={set.id}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="p-3">
                    <Link
                      href={`/admin/sets/${set.id}`}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {set.notes || `${set.kind} · ${set.id.slice(0, 8)}`}
                    </Link>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {t("counts", {
                      approved: set.counts.approved,
                      retired: set.counts.retired,
                      pending: set.counts.draft + set.counts.inReview,
                    })}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {set.acceptanceRate === null
                      ? t("acceptanceUnknown")
                      : t("acceptance", {
                          percent: Math.round(set.acceptanceRate * 100),
                        })}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {format.dateTime(set.createdAt, { dateStyle: "medium" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
