"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useCallback, useEffect, useState } from "react";
import {
  cancelRunAction,
  pauseRunAction,
  resumeRunAction,
  runDetailAction,
} from "@/app/[locale]/(admin)/admin/languages/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type { RunDetail } from "@/server/services/i18n/run-control";

const POLL_MS = 3000;

/** The statuses a run can still move on from — the only ones worth polling or offering controls for. */
const LIVE = new Set(["PENDING", "RUNNING", "PAUSED"]);

/**
 * DB status → message key. A lookup rather than `status.toLowerCase()` so that an unknown status
 * cannot silently render a raw dotted path in front of an admin.
 */
const STATUS_KEYS: Record<string, string> = {
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

type RunTranslator = ReturnType<typeof useTranslations<"admin.languages.run">>;

/**
 * Whether a run can still change on its own. The board asks this to decide between offering
 * "start in background" and handing the language over to the panel's own controls.
 */
export function isRunLive(run: RunDetail | null): run is RunDetail {
  return run !== null && LIVE.has(run.status);
}

/**
 * What a background run is doing, refreshed every three seconds while it is live (spec-19).
 *
 * Polled, not streamed: a run lasts hours, and one indexed read every 3 s is robust behind nginx
 * in a way a held-open connection is not. Polling stops when the tab is hidden and never starts
 * for a finished run, so a board left open overnight costs nothing.
 *
 * Mount it with `key={run.runId}` — the initial detail is state, so a *different* run arriving
 * from the server has to remount rather than be merged into a poll already in flight.
 */
export function RunPanel({
  initial,
  workerOnline,
}: {
  initial: RunDetail;
  workerOnline: boolean;
}) {
  const t = useTranslations("admin.languages.run");
  const tErrors = useTranslations();
  const format = useFormatter();
  const [run, setRun] = useState<RunDetail>(initial);

  const [pauseState, pause] = useActionState<
    ActionResult | undefined,
    FormData
  >(pauseRunAction, undefined);
  const [resumeState, resume] = useActionState<
    ActionResult | undefined,
    FormData
  >(resumeRunAction, undefined);
  const [cancelState, cancel] = useActionState<
    ActionResult | undefined,
    FormData
  >(cancelRunAction, undefined);

  const runId = run.runId;
  const refresh = useCallback(async () => {
    const result = await runDetailAction(runId);
    if (result.ok) setRun(result.data);
  }, [runId]);

  useEffect(() => {
    if (!LIVE.has(run.status)) return;
    let cancelled = false;
    // Doubles as the visibility handler: coming back to the tab refreshes at once rather than
    // showing numbers up to three seconds stale.
    const tick = () => {
      if (!document.hidden && !cancelled) void refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [run.status, refresh]);

  // A control answered: read the run back at once rather than waiting up to three seconds for the
  // next poll. Scheduled on a timer rather than called inline — an effect must not drive setState
  // synchronously — and skipped on mount, where `initial` is already the freshest thing we have.
  useEffect(() => {
    if (!pauseState && !resumeState && !cancelState) return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [pauseState, resumeState, cancelState, refresh]);

  // Clamped: `planned` counts units and `remaining` counts jobs, and a repair run that grows its
  // job set would otherwise push aria-valuenow outside the range it declares.
  const percent =
    run.planned === 0
      ? 100
      : Math.min(
          100,
          Math.max(
            0,
            Math.round(((run.planned - run.remaining) / run.planned) * 100),
          ),
        );
  const error = [pauseState, resumeState, cancelState].find(
    (state) => state?.ok === false,
  );
  const statusKey = run.stale
    ? "stale"
    : run.cancelRequested
      ? "cancelling"
      : run.pauseRequested
        ? "pausing"
        : (STATUS_KEYS[run.status] ?? "pending");
  const live = LIVE.has(run.status);

  return (
    <Card className="[--card-spacing:--spacing(4)]" aria-live="polite">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            {t("title", { kind: t(`kinds.${run.kind}`) })}
          </CardTitle>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs",
              run.stale
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
          >
            {t(`status.${statusKey}`)}
          </span>
        </div>

        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("progressLabel")}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              run.status === "COMPLETED"
                ? "bg-[var(--status-success)]"
                : "bg-primary",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Stat
            label={t("completed")}
            value={`${run.completed} / ${run.planned}`}
          />
          <Stat label={t("flagged")} value={String(run.flagged)} />
          <Stat label={t("failed")} value={String(run.failed)} />
          <Stat label={t("memory")} value={String(run.memoryHits)} />
          <Stat
            label={t("rate")}
            value={
              run.rateUnitsPerMin === null
                ? t("estimating")
                : t("perMinute", { rate: run.rateUnitsPerMin.toFixed(1) })
            }
          />
          <Stat
            label={t("eta")}
            value={
              run.etaSeconds === null
                ? t("estimating")
                : formatDuration(t, run.etaSeconds)
            }
          />
          <Stat
            label={t("cost")}
            value={t("costValue", {
              spent: run.spentUsd.toFixed(2),
              estimate: run.estimatedUsd.toFixed(2),
            })}
          />
          {/* A wall-clock time, not "12 seconds ago": a relative one is measured against the
              reader's clock, so it differs between the server render and the first client render.
              Whether the worker is late is a judgement the server already made — `stale`. */}
          <Stat
            label={t("heartbeat")}
            value={
              run.heartbeatAt
                ? format.dateTime(new Date(run.heartbeatAt), {
                    dateStyle: "short",
                    timeStyle: "short",
                  })
                : "—"
            }
          />
        </dl>

        {run.byEntity.length > 0 ? (
          <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {run.byEntity.map((entry) => (
              <li
                key={entry.entity}
                className="rounded-full bg-muted px-2 py-0.5"
              >
                {entry.entity}: {entry.done}/
                {entry.done +
                  entry.queued +
                  entry.running +
                  entry.failed +
                  entry.skipped}
                {entry.skipped > 0
                  ? ` · ${t("skipped", { count: entry.skipped })}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}

        {run.stale ? <FormAlert>{t("staleHint")}</FormAlert> : null}
        {!workerOnline && live ? (
          <FormAlert tone="info">{t("workerOffline")}</FormAlert>
        ) : null}
        {run.error ? (
          <FormAlert>{t("errorLabel", { message: run.error })}</FormAlert>
        ) : null}
        {error?.ok === false ? (
          <FormAlert>{tErrors(error.messageKey)}</FormAlert>
        ) : null}

        {/* Every control is gated on `cancelRequested`: a run already on its way out has nothing
            left to offer, and pausing it would only delay the batch boundary that ends it. */}
        {live ? (
          <div className="flex flex-wrap gap-2">
            {run.status === "RUNNING" &&
            !run.pauseRequested &&
            !run.cancelRequested ? (
              <form action={pause}>
                <input type="hidden" name="runId" value={run.runId} />
                <SubmitButton
                  variant="outline"
                  label={t("pause")}
                  pendingLabel={t("pausing")}
                />
              </form>
            ) : null}
            {(run.status === "PAUSED" || run.pauseRequested) &&
            !run.cancelRequested ? (
              <form action={resume}>
                <input type="hidden" name="runId" value={run.runId} />
                <SubmitButton
                  label={t("resume")}
                  pendingLabel={t("resuming")}
                />
              </form>
            ) : null}
            {!run.cancelRequested ? (
              <form action={cancel}>
                <input type="hidden" name="runId" value={run.runId} />
                <SubmitButton
                  variant="ghost"
                  label={t("cancel")}
                  pendingLabel={t("cancelling")}
                />
              </form>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/** Seconds as something readable. The units are translated — nothing here is display text in code. */
function formatDuration(t: RunTranslator, seconds: number): string {
  if (seconds < 60) return t("seconds", { value: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return t("minutes", { value: minutes });
  return t("hours", { value: Math.floor(minutes / 60), rest: minutes % 60 });
}
