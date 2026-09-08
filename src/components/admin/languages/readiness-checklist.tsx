"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  startBackgroundRunAction,
  type StartOutcome,
} from "@/app/[locale]/(admin)/admin/languages/actions";
import { canStartRuns } from "@/components/admin/languages/run-view";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type {
  Blocker,
  BlockerKind,
  UntranslatedUnit,
} from "@/server/services/i18n/languages";
import type { Role } from "@prisma/client";

/**
 * What is standing between this language and students (spec-19).
 *
 * A percentage tells an admin they are not finished; it never tells them what to do about it.
 * This is the same shortfall said as work: how many units, held by what, and what would clear it —
 * with every line opening the rows it counted, because a number nobody can click through to is a
 * number nobody can act on.
 *
 * The list is derived from the coverage blockers, which is also what `complete` is derived from.
 * So an empty checklist and an unlocked publish toggle are the same fact stated twice, and cannot
 * come apart.
 */
export function ReadinessChecklist({
  code,
  blockers,
  complete,
  active,
}: {
  code: string;
  blockers: Blocker[];
  complete: boolean;
  /** The blocker the page is currently filtered to, so the admin can see where they are. */
  active?: BlockerKind;
}) {
  const t = useTranslations("admin.languages.readiness");

  if (complete) {
    return (
      <p className="text-sm font-medium text-[var(--status-success-strong)]">
        {t("ready")}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-foreground">{t("title")}</p>
      <ul className="text-sm">
        {blockers.map((blocker) => (
          <li key={blocker.kind}>
            <Link
              href={`/admin/languages/${code}?blocker=${blocker.kind}`}
              {...(active === blocker.kind
                ? { "aria-current": "true" as const }
                : {})}
              className={cn(
                "inline-flex min-h-11 flex-wrap items-center gap-x-2 rounded-[var(--radius-control)] px-2 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active === blocker.kind && "bg-muted",
              )}
            >
              <span className="font-medium tabular-nums text-foreground">
                {blocker.count}
              </span>
              <span className="text-foreground">
                {t(`kinds.${blocker.kind}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`hints.${blocker.kind}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The units behind the UNTRANSLATED and FAILED lines.
 *
 * These have no translation row at all, so the review queue cannot show them — without this list
 * two of the four checklist lines would count something an admin could never look at. A failure
 * carries the error the machine stopped on, which is usually the whole answer to "why".
 */
export function UntranslatedList({
  code,
  units,
  kind,
  limit,
  viewerRole,
}: {
  code: string;
  units: UntranslatedUnit[];
  kind: "UNTRANSLATED" | "FAILED";
  /** How many the page asked for — the list says so when it is showing a first page. */
  limit: number;
  /** This page is open to INSTRUCTOR; starting a run is not. */
  viewerRole: Role;
}) {
  const t = useTranslations("admin.languages");
  const tErrors = useTranslations();
  const [startState, startAction] = useActionState<
    ActionResult<StartOutcome> | undefined,
    FormData
  >(startBackgroundRunAction, undefined);

  return (
    <div className="space-y-3">
      {startState?.ok === false ? (
        <FormAlert>{tErrors(startState.messageKey)}</FormAlert>
      ) : null}
      {startState?.ok ? (
        <FormAlert tone="success">
          {t("startQueued", {
            count: startState.data.plannedUnits,
            cost: startState.data.estimatedUsd.toFixed(2),
          })}
        </FormAlert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">
          {kind === "FAILED"
            ? t("readiness.listTitleFailed")
            : t("readiness.listTitle")}
        </h2>
        {/* Both lists are cleared the same way: plan what is missing and let the worker run it.
            A failure is re-planned like anything else — nothing about it is sticky.

            Admins only, because `startBackgroundRunAction` is: an instructor pressing this would
            get a `forbidden()` navigation interrupt rather than anything they could read. */}
        {canStartRuns(viewerRole) ? (
          <form action={startAction}>
            <input type="hidden" name="code" value={code} />
            <SubmitButton
              className="h-9"
              variant="outline"
              label={t("startBackground")}
              pendingLabel={t("starting")}
            />
          </form>
        ) : null}
      </div>

      {units.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("readiness.listEmpty")}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-[var(--radius-base)] border border-border">
            {units.map((unit) => (
              <li
                key={`${unit.entity}:${unit.entityId}`}
                className="flex flex-col gap-1 px-3 py-2.5"
              >
                <p className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
                    {unit.entity}
                  </span>
                  <span className="text-sm text-foreground" lang="en">
                    {unit.label}
                  </span>
                </p>
                {unit.error ? (
                  <p className="text-xs text-destructive">{unit.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {units.length >= limit ? (
            <p className="text-xs text-muted-foreground">
              {t("readiness.listMore", { count: limit })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
