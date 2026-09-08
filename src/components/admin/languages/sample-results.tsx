"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { sampleResultsAction } from "@/app/[locale]/(admin)/admin/languages/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  SampleItem,
  SampleResultsView,
} from "@/server/services/i18n/sample";

const POLL_MS = 3000;

/** The statuses a run can still move on from — the only ones worth polling. */
const LIVE = new Set(["PENDING", "RUNNING", "PAUSED"]);

/**
 * QA codes stated in words. Deliberately a copy of the list in `translation-review.tsx` rather
 * than an import: that module is the reviewer's screen and owns its own vocabulary, and a shared
 * constant would tie a five-unit preview to it for the sake of fifteen strings.
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
type LanguageTranslator = ReturnType<typeof useTranslations<"admin.languages">>;

function flagLabel(t: LanguageTranslator, flag: string): string {
  return (FLAG_KEYS as readonly string[]).includes(flag)
    ? t(`flags.${flag as FlagKey}`)
    : flag;
}

/** Whatever the payload calls its headline string — a stem, a name, or a message. */
function headline(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  return String(payload.stem ?? payload.name ?? payload.text ?? "");
}

/** The second line some payloads carry: a sign's meaning, a topic's description. */
function detail(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const value = payload.meaning ?? payload.description ?? payload.explanation;
  return typeof value === "string" ? value : "";
}

function options(
  payload: Record<string, unknown> | null,
): Array<{ key: string; text: string }> {
  const list = payload?.options;
  return Array.isArray(list)
    ? (list as Array<{ key: string; text: string }>)
    : [];
}

/**
 * What the sample produced, beside what it was translated from (spec-19).
 *
 * The point of the screen is the comparison, not the counters: a glossary term rendered the wrong
 * way, or a style note that produced the wrong register, is obvious in five units and invisible in
 * a percentage. So it is laid out exactly like the reviewer's screen — source left, translation
 * right, QA findings in words — and fills in unit by unit as the worker gets to them rather than
 * showing nothing until the whole sample lands.
 */
export function SampleResults({
  runId,
  code,
  direction,
}: {
  runId: string;
  code: string;
  direction: "LTR" | "RTL";
}) {
  const t = useTranslations("admin.languages");
  const tErrors = useTranslations();
  const [view, setView] = useState<SampleResultsView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await sampleResultsAction(runId);
    if (result.ok) setView(result.data);
    else setFailed(result.messageKey);
  }, [runId]);

  // A boolean, not the view itself: the view changes on every poll, and depending on it would tear
  // the interval down and rebuild it — and re-read — on each one. This flips exactly once, when
  // the run reaches a terminal state.
  const pollable = view === null || LIVE.has(view.status);
  useEffect(() => {
    // Nothing left to poll for once the run is terminal; a finished sample never changes again.
    if (!pollable) return;
    let cancelled = false;
    // Doubles as the visibility handler: coming back to the tab reads at once rather than showing
    // a sample up to three seconds stale.
    const tick = () => {
      if (!document.hidden && !cancelled) void refresh();
    };
    // The run was queued a moment ago by the form above, so read it straight away rather than
    // showing three seconds of skeleton. Scheduled on a timer, not called inline: an effect must
    // not drive setState synchronously.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [pollable, refresh]);

  const status = view?.status ?? "PENDING";
  const translated =
    view?.items.filter((item) => item.value !== null).length ?? 0;
  const statusLine =
    status === "PENDING"
      ? t("sample.waiting")
      : status === "RUNNING"
        ? t("sample.working")
        : status === "COMPLETED"
          ? t("sample.done", { count: translated })
          : t("sample.stopped");

  return (
    <Card className="border-primary/30 [--card-spacing:--spacing(4)]">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{t("sample.title")}</CardTitle>
          {/* Only the status line is live. Announcing the whole card on every three-second poll
              would read five translations aloud again each time. */}
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {statusLine}
          </span>
        </div>

        {failed ? <FormAlert>{tErrors(failed)}</FormAlert> : null}

        {view === null ? (
          <SampleSkeleton />
        ) : view.items.length === 0 ? (
          <p className="rounded-[var(--radius-base)] border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("sample.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {view.items.map((item) => (
              <li key={`${item.entity}:${item.entityId}`}>
                <SampleRow
                  item={item}
                  code={code}
                  direction={direction}
                  t={t}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SampleRow({
  item,
  code,
  direction,
  t,
}: {
  item: SampleItem;
  code: string;
  direction: "LTR" | "RTL";
  t: LanguageTranslator;
}) {
  const source = item.source as Record<string, unknown> | null;
  const value = item.value as Record<string, unknown> | null;
  const sourceOptions = options(source);
  // Keyed off the SOURCE options, so a missing translation is a visible gap rather than a shorter
  // list nobody notices — the same rule the reviewer's screen uses.
  const translatedByKey = new Map(
    options(value).map((option) => [option.key, option.text]),
  );

  return (
    <div className="space-y-2 rounded-[var(--radius-base)] border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-all text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {item.entity}{" "}
          <span className="font-mono normal-case tracking-normal">
            {item.label}
          </span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {item.qaFlags.map((flag) => (
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
            {headline(source)}
          </p>
          {detail(source) ? (
            <p className="text-sm text-muted-foreground" lang="en">
              {detail(source)}
            </p>
          ) : null}
          {sourceOptions.length > 0 ? (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {sourceOptions.map((option) => (
                <li key={option.key}>
                  <span className="font-mono text-xs">{option.key}</span>{" "}
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
          {value === null ? (
            <p className="text-sm italic text-muted-foreground">
              {t("sample.pending")}
            </p>
          ) : (
            <>
              <p className="text-sm text-foreground">{headline(value)}</p>
              {detail(value) ? (
                <p className="text-sm text-muted-foreground">{detail(value)}</p>
              ) : null}
              {sourceOptions.length > 0 ? (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {sourceOptions.map((option) => (
                    <li key={option.key}>
                      <span className="font-mono text-xs">{option.key}</span>{" "}
                      <span
                        className={cn(
                          !translatedByKey.get(option.key) &&
                            "text-destructive italic",
                        )}
                      >
                        {translatedByKey.get(option.key) ?? t("optionMissing")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A skeleton, not a spinner: the shape of what is coming is already known (mandate 1). */
function SampleSkeleton() {
  return (
    <ul className="space-y-3" aria-hidden>
      {[0, 1, 2].map((row) => (
        <li
          key={row}
          className="grid gap-3 rounded-[var(--radius-base)] border border-border p-3 sm:grid-cols-2"
        >
          <div className="h-16 rounded-[var(--radius-control)] bg-muted/50" />
          <div className="h-16 rounded-[var(--radius-control)] bg-accent/40" />
        </li>
      ))}
    </ul>
  );
}
