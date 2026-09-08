"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addLanguageAction,
  planRunAction,
  runSliceAction,
  startBackgroundRunAction,
  startRepairRunAction,
  startSampleRunAction,
  updateLanguageAction,
  type PlanOutcome,
  type StartOutcome,
} from "@/app/[locale]/(admin)/admin/languages/actions";
import { RunPanel } from "@/components/admin/languages/run-panel";
import { isRunLive } from "@/components/admin/languages/run-view";
import { SampleResults } from "@/components/admin/languages/sample-results";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type { Blocker } from "@/server/services/i18n/languages";
import type { RunDetail } from "@/server/services/i18n/run-control";
import type { RunProgress } from "@/server/services/i18n/runs";

export interface LanguageRow {
  code: string;
  englishName: string;
  nativeName: string;
  shortLabel: string;
  urlPrefix: string;
  direction: "LTR" | "RTL";
  isBuiltIn: boolean;
  requiresApproval: boolean;
  studentVisible: boolean;
  lastSyncedAt: Date | null;
  coverage: {
    percent: number;
    ready: number;
    total: number;
    flagged: number;
    /** What is standing between this language and students — empty exactly when `complete`. */
    blockers: Blocker[];
    complete: boolean;
  };
  /** The newest background run for this language, live or finished — null if there has never been one. */
  latestRun: RunDetail | null;
}

/**
 * The languages a school offers (spec-15).
 *
 * Deliberately shows the numbers rather than a reassuring bar alone: English is merged underneath
 * every catalogue, so a half-translated language *looks* finished to anyone who cannot read it.
 * "412 of 698" is the only honest way to say how far along it is.
 */
export function LanguageBoard({
  languages,
  workerOnline,
}: {
  languages: LanguageRow[];
  /** The background worker reported in recently — without it an enqueued run just waits. */
  workerOnline: boolean;
}) {
  const t = useTranslations("admin.languages");
  const tErrors = useTranslations();
  const [adding, setAdding] = useState(false);

  const [addState, addAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(addLanguageAction, undefined);
  const [updateState, updateAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(updateLanguageAction, undefined);
  const [planState, planAction] = useActionState<
    ActionResult<PlanOutcome> | undefined,
    FormData
  >(planRunAction, undefined);
  const [runState, runAction] = useActionState<
    ActionResult<RunProgress> | undefined,
    FormData
  >(runSliceAction, undefined);
  const [startState, startAction] = useActionState<
    ActionResult<StartOutcome> | undefined,
    FormData
  >(startBackgroundRunAction, undefined);
  const [repairState, repairAction] = useActionState<
    ActionResult<StartOutcome> | undefined,
    FormData
  >(startRepairRunAction, undefined);
  const [sampleState, sampleAction] = useActionState<
    ActionResult<StartOutcome> | undefined,
    FormData
  >(startSampleRunAction, undefined);

  const error = [
    addState,
    updateState,
    planState,
    runState,
    startState,
    repairState,
    sampleState,
  ].find((state) => state?.ok === false);
  // Both actions enqueue a background run, so both report it the same way.
  const queued = startState?.ok
    ? startState.data
    : repairState?.ok
      ? repairState.data
      : null;
  // The sample panel renders the translation itself, so it needs the language's own reading
  // direction — an Arabic sample laid out left-to-right is unreadable to the person judging it.
  const sample = sampleState?.ok ? sampleState.data : null;
  const sampleDirection =
    languages.find((language) => language.code === sample?.locale)?.direction ??
    "LTR";

  return (
    <div className="space-y-5">
      {error?.ok === false ? (
        <FormAlert>{tErrors(error.messageKey)}</FormAlert>
      ) : null}

      {queued ? (
        <FormAlert tone="success">
          {t("startQueued", {
            count: queued.plannedUnits,
            cost: queued.estimatedUsd.toFixed(2),
          })}
        </FormAlert>
      ) : null}

      <p className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            "rounded-full px-2 py-0.5",
            workerOnline
              ? "bg-[var(--status-success-soft)] text-[var(--status-success-strong)]"
              : "bg-muted text-muted-foreground",
          )}
        >
          {workerOnline ? t("workerOnline") : t("workerOffline")}
        </span>
      </p>

      <ul className="space-y-3">
        {languages.map((language) => (
          <li key={language.code}>
            <Card className="[--card-spacing:--spacing(4)]">
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="font-medium text-foreground">
                      {language.nativeName}{" "}
                      <span className="text-sm font-normal text-muted-foreground">
                        {language.englishName} · {language.urlPrefix}
                      </span>
                    </p>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs">
                      {language.isBuiltIn ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          {t("builtIn")}
                        </span>
                      ) : null}
                      {language.direction === "RTL" ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          {t("rtl")}
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5",
                          language.studentVisible
                            ? "bg-[var(--status-success-soft)] text-[var(--status-success-strong)]"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {language.studentVisible ? t("visible") : t("hidden")}
                      </span>
                      {!language.isBuiltIn ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                          {language.requiresApproval
                            ? t("approvalOn")
                            : t("approvalOff")}
                        </span>
                      ) : null}
                    </p>
                  </div>

                  {!language.isBuiltIn ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/languages/${language.code}`}>
                        {t("open")}
                      </Link>
                    </Button>
                  ) : null}
                </div>

                {!language.isBuiltIn ? (
                  <>
                    <div className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">
                          {t("coverage")}
                        </span>
                        <span className="tabular-nums text-foreground">
                          {t("coverageCount", {
                            ready: language.coverage.ready,
                            total: language.coverage.total,
                          })}{" "}
                          · {language.coverage.percent}%
                          {language.coverage.flagged > 0
                            ? ` · ${t("flaggedCount", { count: language.coverage.flagged })}`
                            : ""}
                        </span>
                      </div>
                      <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-valuenow={language.coverage.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={t("coverage")}
                      >
                        <div
                          className={cn(
                            "h-full rounded-full transition-[width] duration-300",
                            language.coverage.complete
                              ? "bg-[var(--status-success)]"
                              : "bg-primary",
                          )}
                          style={{ width: `${language.coverage.percent}%` }}
                        />
                      </div>
                      {/* The percentage says how far off; this says what of. The same list the
                          language's own page turns into links. */}
                      {language.coverage.blockers.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {language.coverage.blockers
                            .map(
                              (blocker) =>
                                `${blocker.count} ${t(`readiness.kinds.${blocker.kind}`)}`,
                            )
                            .join(" · ")}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <form action={planAction}>
                        <input
                          type="hidden"
                          name="code"
                          value={language.code}
                        />
                        <SubmitButton
                          className="h-9"
                          label={t("plan")}
                          pendingLabel={t("planning")}
                        />
                      </form>

                      {/* Hidden while a run is live: startBackgroundRun would only refuse it, and
                          the panel below already carries pause, resume and cancel. */}
                      {!isRunLive(language.latestRun) ? (
                        <form action={startAction}>
                          <input
                            type="hidden"
                            name="code"
                            value={language.code}
                          />
                          <SubmitButton
                            className="h-9"
                            label={t("startBackground")}
                            pendingLabel={t("starting")}
                          />
                        </form>
                      ) : null}

                      {/* The way back in when the repair chain stopped: a repair that fixed
                          nothing does not plan another, so an admin restarts it by hand. Only
                          offered when there is something flagged to repair. */}
                      {!isRunLive(language.latestRun) &&
                      language.coverage.flagged > 0 ? (
                        <form action={repairAction}>
                          <input
                            type="hidden"
                            name="code"
                            value={language.code}
                          />
                          <SubmitButton
                            className="h-9"
                            variant="outline"
                            label={t("repairFlagged", {
                              count: language.coverage.flagged,
                            })}
                            pendingLabel={t("starting")}
                          />
                        </form>
                      ) : null}

                      <form action={updateAction}>
                        <input
                          type="hidden"
                          name="code"
                          value={language.code}
                        />
                        <input
                          type="hidden"
                          name="requiresApproval"
                          value={String(!language.requiresApproval)}
                        />
                        <SubmitButton
                          className="h-9"
                          variant="outline"
                          label={
                            language.requiresApproval
                              ? t("turnApprovalOff")
                              : t("turnApprovalOn")
                          }
                          pendingLabel={t("saving")}
                        />
                      </form>

                      <form action={updateAction}>
                        <input
                          type="hidden"
                          name="code"
                          value={language.code}
                        />
                        <input
                          type="hidden"
                          name="studentVisible"
                          value={String(!language.studentVisible)}
                        />
                        <SubmitButton
                          className="h-9"
                          variant="outline"
                          disabled={
                            !language.studentVisible &&
                            !language.coverage.complete
                          }
                          label={
                            language.studentVisible ? t("hide") : t("show")
                          }
                          pendingLabel={t("saving")}
                        />
                      </form>

                      {!language.studentVisible &&
                      !language.coverage.complete ? (
                        <span className="text-xs text-muted-foreground">
                          {t("showBlocked", {
                            percent: language.coverage.percent,
                          })}
                        </span>
                      ) : null}
                    </div>

                    {!isRunLive(language.latestRun) ? (
                      <p className="text-xs text-muted-foreground">
                        {workerOnline
                          ? t("startBackgroundNote")
                          : t("workerOfflineNote")}
                      </p>
                    ) : null}

                    {/* Keyed by run id: the detail is panel state, so a different run has to
                        remount rather than merge into a poll already in flight. */}
                    {language.latestRun ? (
                      <RunPanel
                        key={language.latestRun.runId}
                        initial={language.latestRun}
                        workerOnline={workerOnline}
                      />
                    ) : null}
                  </>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {planState?.ok && planState.data.plannedUnits > 0 ? (
        <Card className="border-primary/30 bg-accent/40 [--card-spacing:--spacing(4)]">
          <CardContent className="space-y-3">
            <p className="text-sm font-medium text-foreground">
              {t("planReady", {
                count: planState.data.plannedUnits,
                cost: planState.data.estimatedUsd.toFixed(2),
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {Object.entries(planState.data.byEntity)
                .map(([entity, count]) => `${entity}: ${count}`)
                .join(" · ")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <form action={runAction}>
                <input
                  type="hidden"
                  name="runId"
                  value={planState.data.runId}
                />
                <input type="hidden" name="maxUnits" value="25" />
                <SubmitButton
                  label={t("translateSlice")}
                  pendingLabel={t("translating")}
                />
              </form>

              {/* The cheapest way to find out the glossary or the style note is wrong: five units
                  across the different kinds of content, read before anyone commits to the bill. */}
              <form action={sampleAction}>
                <input
                  type="hidden"
                  name="code"
                  value={planState.data.locale}
                />
                <SubmitButton
                  variant="outline"
                  label={t("sampleFirst")}
                  pendingLabel={t("starting")}
                />
              </form>
            </div>
            <p className="text-xs text-muted-foreground">{t("sliceNote")}</p>
            <p className="text-xs text-muted-foreground">{t("sampleNote")}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* Keyed by run id, like the progress panel: a second sample is a different run and has to
          remount rather than merge into a poll already in flight. */}
      {sample && sample.plannedUnits > 0 ? (
        <SampleResults
          key={sample.runId}
          runId={sample.runId}
          code={sample.locale}
          direction={sampleDirection}
        />
      ) : null}

      {sample && sample.plannedUnits === 0 ? (
        <FormAlert tone="success">{t("nothingToDo")}</FormAlert>
      ) : null}

      {planState?.ok && planState.data.plannedUnits === 0 ? (
        <FormAlert tone="success">{t("nothingToDo")}</FormAlert>
      ) : null}

      {runState?.ok ? (
        <FormAlert tone={runState.data.done ? "success" : "info"}>
          {t("runProgress", {
            completed: runState.data.completed,
            planned: runState.data.planned,
            flagged: runState.data.flagged,
            failed: runState.data.failed,
          })}
        </FormAlert>
      ) : null}

      {adding ? (
        <Card className="[--card-spacing:--spacing(4)]">
          <CardContent className="space-y-3">
            <CardTitle className="text-base">{t("addTitle")}</CardTitle>
            <form action={addAction} className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t("code")}</span>
                <input
                  name="code"
                  required
                  pattern="[a-z]{2,3}(-[A-Za-z0-9]{2,8})*"
                  placeholder="es"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                />
                <span className="block text-xs text-muted-foreground">
                  {t("codeHint")}
                </span>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t("shortLabel")}</span>
                <input
                  name="shortLabel"
                  required
                  maxLength={6}
                  placeholder="ES"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">
                  {t("englishName")}
                </span>
                <input
                  name="englishName"
                  required
                  placeholder="Spanish"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t("nativeName")}</span>
                <input
                  name="nativeName"
                  required
                  placeholder="Español"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t("direction")}</span>
                <select
                  name="direction"
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                >
                  <option value="LTR">{t("ltrOption")}</option>
                  <option value="RTL">{t("rtlOption")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 self-end text-sm">
                <input
                  type="checkbox"
                  name="requiresApproval"
                  defaultChecked
                  className="size-4"
                />
                <span className="text-foreground">{t("requiresApproval")}</span>
              </label>
              <label className="space-y-1 text-sm sm:col-span-2">
                <span className="text-muted-foreground">{t("styleNote")}</span>
                <input
                  name="styleNote"
                  placeholder={t("styleNotePlaceholder")}
                  className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                />
              </label>
              <div className="flex items-center gap-2 sm:col-span-2">
                <SubmitButton label={t("add")} pendingLabel={t("saving")} />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                >
                  {t("cancel")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button type="button" onClick={() => setAdding(true)}>
          {t("addLanguage")}
        </Button>
      )}
    </div>
  );
}
