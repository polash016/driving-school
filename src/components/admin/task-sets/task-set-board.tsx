"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  buildTaskSetsAction,
  publishTaskSetsAction,
} from "@/app/[locale]/(admin)/admin/task-sets/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult } from "@/server/contracts/common";
import type { AdminBuild, TaskSetSummary } from "@/server/contracts/task-sets";

/**
 * The build board (spec-16). One row per partitioning run, each listing the slices it proposes
 * with the numbers an admin needs to judge them: pool and paper size, topic spread, average
 * difficulty, and how many questions carry a picture.
 *
 * Warnings are shown at the set that raised them, not aggregated — "#3 is thin on images" is
 * actionable, "3 warnings" is not.
 */
export function TaskSetBoard({
  builds,
  licenseClassCode,
}: {
  builds: AdminBuild[];
  licenseClassCode: string;
}) {
  const t = useTranslations("admin.taskSets");
  const tErrors = useTranslations();
  const format = useFormatter();

  const [buildState, buildAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(buildTaskSetsAction, undefined);
  const [publishState, publishAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(publishTaskSetsAction, undefined);

  return (
    <div className="space-y-5">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle>{t("rebuildTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm/relaxed text-muted-foreground">
            {t("rebuildBody")}
          </p>
          {buildState?.ok === false ? (
            <FormAlert>{tErrors(buildState.messageKey)}</FormAlert>
          ) : null}
          {publishState?.ok === false ? (
            <FormAlert>{tErrors(publishState.messageKey)}</FormAlert>
          ) : null}
          <form action={buildAction}>
            <input
              type="hidden"
              name="licenseClassCode"
              value={licenseClassCode}
            />
            <SubmitButton label={t("rebuild")} pendingLabel={t("rebuilding")} />
          </form>
        </CardContent>
      </Card>

      {builds.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 text-center">
            <p className="font-medium text-foreground">{t("emptyTitle")}</p>
            <p className="text-sm/relaxed text-muted-foreground">
              {t("emptyBody")}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {builds.map((build) => (
        <Card key={build.id} className="[--card-spacing:--spacing(5)]">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <CardTitle>
                {t("buildTitle", { count: build.sets.length })}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {format.dateTime(build.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {build.requestedByEmail ? ` · ${build.requestedByEmail}` : ""}
              </p>
            </div>
            {build.published ? (
              <span className="rounded-full bg-[var(--status-success-soft)] px-3 py-1 text-xs font-semibold text-[var(--status-success)]">
                {t("published")}
              </span>
            ) : (
              <form action={publishAction}>
                <input type="hidden" name="buildId" value={build.id} />
                <SubmitButton
                  label={t("publish", { count: build.sets.length })}
                  pendingLabel={t("publishing")}
                />
              </form>
            )}
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t("colSet")}</th>
                  <th className="py-2 pr-3 font-medium">{t("colPool")}</th>
                  <th className="py-2 pr-3 font-medium">{t("colPaper")}</th>
                  <th className="py-2 pr-3 font-medium">{t("colTopics")}</th>
                  <th className="py-2 pr-3 font-medium">{t("colVisual")}</th>
                  <th className="py-2 pr-3 font-medium">
                    {t("colDifficulty")}
                  </th>
                  <th className="py-2 font-medium">{t("colNotes")}</th>
                </tr>
              </thead>
              <tbody>
                {build.sets.map((set) => (
                  <SetRow key={set.id} set={set} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SetRow({ set }: { set: TaskSetSummary }) {
  const t = useTranslations("admin.taskSets");
  const visual =
    (set.composition.typeCounts.IMAGE ?? 0) +
    (set.composition.typeCounts.SIGN ?? 0);

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="py-2 pr-3 font-mono font-semibold text-foreground">
        #{set.number}
      </td>
      <td className="py-2 pr-3 tabular-nums">{set.poolSize}</td>
      <td className="py-2 pr-3 tabular-nums">
        {t("paperCell", { paper: set.paperSize, mark: set.passMark })}
      </td>
      <td className="py-2 pr-3 tabular-nums">
        {Object.keys(set.composition.topicCounts).length}
      </td>
      <td className="py-2 pr-3 tabular-nums">{visual}</td>
      <td className="py-2 pr-3 tabular-nums">
        {set.composition.avgDifficulty.toFixed(1)}
      </td>
      <td className="py-2 text-xs">
        {set.composition.warnings.length === 0 ? (
          <span className="text-[var(--status-success)]">{t("balanced")}</span>
        ) : (
          <span className="text-[var(--status-warning-fg)]">
            {set.composition.warnings
              .map((warning) =>
                t(`warning.${warning}` as "warning.SINGLE_TOPIC"),
              )
              .join(" · ")}
          </span>
        )}
      </td>
    </tr>
  );
}
