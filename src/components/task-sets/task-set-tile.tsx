"use client";

import { CheckIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { StudentTaskSet } from "@/server/contracts/task-sets";

/**
 * One numbered tile in the grid (spec-16).
 *
 * Four states, and deliberately **no red one**. A set a student attempted and did not pass shows
 * its last score in muted text: that is information they can act on. A wall of red tiles is a
 * verdict on the student, which is the opposite of what a study tool is for. Green is reserved
 * for a genuine pass, and once earned it is never taken away — `passed` comes from `passedAt`,
 * which the grading transaction sets once and never clears.
 */
export function TaskSetTile({
  set,
  onOpen,
  buttonRef,
}: {
  set: StudentTaskSet;
  onOpen: () => void;
  /** Registers the node so the grid can put focus back here when the sheet closes. */
  buttonRef?: (node: HTMLButtonElement | null) => void;
}) {
  const t = useTranslations("taskSets");

  const state = set.passed
    ? "passed"
    : set.inProgressAttemptId
      ? "inProgress"
      : set.attempts > 0
        ? "attempted"
        : "fresh";

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      // The accessible name carries the state too: a screen-reader user must not have to infer
      // "passed" from a colour.
      aria-label={`${t("openSet", { number: set.number })} — ${t(state === "fresh" ? "notStarted" : state === "attempted" ? "failed" : state)}`}
      className={cn(
        "relative flex min-h-[4.5rem] flex-col items-center justify-center gap-0.5 rounded-[calc(var(--radius-base)+4px)] border px-1.5 py-3 text-center shadow-[var(--shadow-card)] transition-transform duration-150 outline-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:active:scale-100",
        // Passed and in-progress keep their SOLID status colour on purpose: a frosted green is a
        // weaker signal than a green one, and this tile's whole job is to be scannable at a glance.
        state === "passed" &&
          "border-[var(--status-success)]/45 bg-[var(--status-success-soft)]",
        state === "inProgress" && "border-primary bg-accent/60",
        (state === "attempted" || state === "fresh") &&
          "glass border-[var(--glass-ring)] hover:border-border-strong",
      )}
    >
      {set.passed ? (
        <span
          aria-hidden
          className="absolute top-1.5 right-1.5 grid size-[1.15rem] place-items-center rounded-full bg-[var(--status-success)] text-[var(--status-success-fg)]"
        >
          <CheckIcon weight="bold" className="size-3" />
        </span>
      ) : null}

      <span
        className={cn(
          "text-lg font-bold tracking-tight tabular-nums",
          state === "passed"
            ? "text-[var(--status-success-strong)]"
            : "text-foreground",
        )}
      >
        #{set.number}
      </span>

      <span className="text-[0.65rem] leading-tight font-medium">
        {state === "inProgress" ? (
          <span className="text-primary">{t("resume")}</span>
        ) : set.bestCorrect !== null && set.bestOutOf !== null ? (
          <span
            className={
              set.passed
                ? "text-[var(--status-success-strong)]"
                : "text-muted-foreground"
            }
          >
            {t("scoreOf", {
              correct: set.bestCorrect,
              total: set.bestOutOf,
            })}
          </span>
        ) : (
          // Keeps every tile the same height whether or not it has a score.
          <span aria-hidden>&nbsp;</span>
        )}
      </span>
    </button>
  );
}
