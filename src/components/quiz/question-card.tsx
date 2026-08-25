"use client";

import { cn } from "@/lib/utils";

/**
 * THE question rendering (spec-04 D4). Built here for the admin preview and consumed unchanged
 * by the student exam UI (spec-08) — one implementation, so "the preview shows exactly what the
 * student sees" stays true instead of drifting into two lookalikes.
 *
 * SECURITY: correctness arrives only through the optional `reveal` prop. The student pre-submit
 * path has no correctness to pass (the serializer's payload structurally lacks it), so leaking
 * an answer would take deliberately constructing a `reveal` object — not a forgotten flag.
 */

export interface QuestionOption {
  key: string;
  text: string;
}

export interface QuestionCardProps {
  stem: string;
  options: QuestionOption[];
  /** Chosen by the student — drives the selected state only. */
  selectedKey?: string | null;
  /** Post-submit / admin-preview only: the answer and why. */
  reveal?: { correctOptionKey: string; explanation?: string } | null;
  imageUrl?: string | null;
  /**
   * Alternative text that must NOT describe what the picture shows.
   *
   * On a test image the description IS the answer: "Give way sign" as alt text hands the question
   * to every screen-reader user and to anyone who opens the page source. WCAG asks that such an
   * image be identified without being explained, so callers pass a neutral label.
   */
  imageAlt?: string;
  onSelect?: (key: string) => void;
  disabled?: boolean;
  className?: string;
}

export function QuestionCard({
  stem,
  options,
  selectedKey = null,
  reveal = null,
  imageUrl = null,
  imageAlt = "",
  onSelect,
  disabled = false,
  className,
}: QuestionCardProps) {
  return (
    <div className={cn("flex w-full flex-col gap-4", className)}>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- source is a signed app route (spec-06/12), not a static asset
        <img
          src={imageUrl}
          alt={imageAlt}
          // `contain`, never `cover`: cropping is a correctness bug here, not a cosmetic one. A
          // road sign clipped at the edges can become a different sign, and the arrow or number
          // the question turns on is exactly what sits near the border.
          className="max-h-64 w-full rounded-[var(--radius-base)] bg-muted object-contain"
        />
      ) : null}

      <p className="text-balance text-lg/relaxed font-medium text-foreground">
        {stem}
      </p>

      <div
        role="radiogroup"
        aria-label={stem}
        className="flex flex-col gap-2.5"
      >
        {options.map((option) => {
          const selected = selectedKey === option.key;
          const isCorrect = reveal?.correctOptionKey === option.key;
          const isWrongPick = Boolean(reveal) && selected && !isCorrect;

          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || !onSelect}
              onClick={() => onSelect?.(option.key)}
              className={cn(
                "flex min-h-[3.25rem] w-full items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-left text-base/relaxed transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                "disabled:cursor-default",
                selected &&
                  !reveal &&
                  "border-primary bg-accent text-accent-foreground",
                !selected && !reveal && "border-border bg-card hover:bg-muted",
                isCorrect &&
                  "border-[var(--status-success)] bg-[var(--status-success-soft)] text-[var(--status-success)]",
                isWrongPick &&
                  "border-destructive bg-destructive/10 text-destructive",
                reveal &&
                  !isCorrect &&
                  !isWrongPick &&
                  "border-border bg-card text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border text-sm font-semibold",
                  selected || isCorrect
                    ? "border-current"
                    : "border-border text-muted-foreground",
                )}
              >
                {option.key.toUpperCase()}
              </span>
              <span className="flex-1">{option.text}</span>
            </button>
          );
        })}
      </div>

      {reveal?.explanation ? (
        // KNOWN DEFECT (spec-08): the answer lock and this explanation arrive in two separate
        // paints, so the content below shifts after the reveal. Spec-08 asks for CLS ~= 0 here and
        // will need to land both in one update or reserve the space. The hook lets a test wait for
        // the second paint instead of racing it.
        <p
          data-testid="explanation"
          className="rounded-[var(--radius-control)] bg-muted px-3.5 py-3 text-sm/relaxed text-muted-foreground"
        >
          {reveal.explanation}
        </p>
      ) : null}
    </div>
  );
}
