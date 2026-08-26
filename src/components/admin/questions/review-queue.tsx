"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  transitionItemAction,
  type TransitionOutcome,
} from "@/app/[locale]/(admin)/admin/questions/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { QuestionCard } from "@/components/quiz/question-card";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * Review queue (spec-04): one question at a time, every action on the keyboard —
 * A approve · E edit · R reject · J/K move. A reviewer should never need the mouse.
 */

const REASONS = [
  "WRONG_ANSWER",
  "AMBIGUOUS_DISTRACTOR",
  "CITATION_MISMATCH",
  "DUPLICATE",
  "LANGUAGE_QUALITY",
  "IMAGE_MISMATCH",
  "OUT_OF_SCOPE",
  "OTHER",
] as const;

export interface ReviewItem {
  id: string;
  /** How many sign-offs this question still needs — AI drafts need two (spec-04b). */
  approvalsRecorded: number;
  approvalsRequired: number;
  topicLabel: string;
  difficulty: number;
  stem: string;
  options: { key: string; text: string }[];
  correctOptionKey: string;
  explanation: string;
  citations: { sourceCode: string; ref: string }[];
  /**
   * The picture the question is about. A reviewer cannot judge an image question without seeing
   * it — approving one blind is not review, it is a rubber stamp.
   */
  imageUrl: string | null;
  /**
   * False when the question was generated from a picture whose facts nobody confirmed. The
   * reviewer is then checking WHAT IS IN THE PICTURE as well as how the question is worded, and
   * has to be told so.
   */
  factsVerified: boolean;
}

export function ReviewQueue({ items }: { items: ReviewItem[] }) {
  const t = useTranslations("admin.review");
  const tErrors = useTranslations();
  const [queue, setQueue] = useState(items);
  const [index, setIndex] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  // The reviewer's own words. Optional — but it is the strongest lesson the AI ever gets, so it
  // is offered before the reason buttons rather than hidden behind them.
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{
    tone: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const current = queue[index];

  const act = useCallback(
    (to: "APPROVED" | "RETIRED", reason?: string) => {
      if (!current) return;
      const form = new FormData();
      form.set("id", current.id);
      form.set("to", to);
      if (reason) form.set("reason", reason);
      if (reason && note.trim()) form.set("note", note.trim());

      startTransition(async () => {
        const result = await transitionItemAction(undefined, form);
        if (!result.ok) {
          setMessage({ tone: "error", text: tErrors(result.messageKey) });
          return;
        }

        // Either the question moved, or this reviewer's approval was recorded and a second one
        // is still needed. Both mean *this* reviewer is done with it, so it leaves their queue.
        const outcome: TransitionOutcome = result.data;
        setQueue((rows) => rows.filter((row) => row.id !== current.id));
        setIndex((value) => Math.min(value, Math.max(0, queue.length - 2)));
        setRejecting(false);
        setNote("");
        setMessage({
          tone: outcome.applied ? "success" : "info",
          text: outcome.applied
            ? to === "APPROVED"
              ? t("approved")
              : t("rejected")
            : t("recordedNeedsSecond", {
                count: outcome.approvalsRecorded ?? 1,
                required: outcome.approvalsRequired ?? 2,
              }),
        });
      });
    },
    [current, note, queue.length, t, tErrors],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
        return;
      if (rejecting) return;

      const key = event.key.toLowerCase();
      if (key === "a") act("APPROVED");
      else if (key === "r") setRejecting(true);
      else if (key === "j")
        setIndex((value) => Math.min(value + 1, queue.length - 1));
      else if (key === "k") setIndex((value) => Math.max(value - 1, 0));
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, queue.length, rejecting]);

  if (!current) {
    return (
      <div className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
        {message ? <FormAlert tone="success">{message.text}</FormAlert> : null}
        <p className="mt-3">{t("empty")}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="space-y-4">
        {message ? (
          <FormAlert tone={message.tone}>{message.text}</FormAlert>
        ) : null}

        <div
          className="rounded-[var(--radius-base)] bg-card p-5 shadow-card ring-1 ring-foreground/5"
          aria-live="polite"
        >
          <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
            {current.topicLabel} · {current.difficulty}/5 ·{" "}
            {t("approvals", {
              count: current.approvalsRecorded,
              required: current.approvalsRequired,
            })}
          </p>
          {current.imageUrl && !current.factsVerified ? (
            <p
              role="status"
              className="rounded-[var(--radius-control)] bg-amber-500/10 px-3 py-2 text-sm text-foreground"
            >
              {t("factsUnverified")}
            </p>
          ) : null}

          <QuestionCard
            stem={current.stem}
            imageUrl={current.imageUrl}
            imageAlt={t("imageAlt")}
            options={current.options}
            reveal={{
              correctOptionKey: current.correctOptionKey,
              explanation: current.explanation,
            }}
          />
          {current.citations.length > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {current.citations
                .map((c) => `${c.sourceCode} ${c.ref}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>

        {rejecting ? (
          <div
            role="group"
            aria-label={t("rejectTitle")}
            className="space-y-2 rounded-[var(--radius-base)] border border-destructive/40 bg-destructive/5 p-4"
          >
            <p className="text-sm font-medium text-foreground">
              {t("rejectTitle")}
            </p>
            <label
              className="block text-xs text-muted-foreground"
              htmlFor="reject-note"
            >
              {t("noteLabel")}
            </label>
            <textarea
              id="reject-note"
              name="note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              placeholder={t("notePlaceholder")}
              className="w-full rounded-[var(--radius-base)] border border-border bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">{t("noteHint")}</p>
            <div className="flex flex-wrap gap-2">
              {REASONS.map((reason) => (
                <Button
                  key={reason}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => act("RETIRED", reason)}
                >
                  {t(`reasons.${reason}`)}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setRejecting(false);
                setNote("");
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => act("APPROVED")}
            >
              {t("approve")}
            </Button>
            <Button asChild variant="outline">
              <Link href={`/admin/questions/${current.id}`}>{t("edit")}</Link>
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => setRejecting(true)}
            >
              {t("reject")}
            </Button>
          </div>
        )}
      </div>

      <aside className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("remaining", { count: queue.length })}
        </p>
        <p className="text-xs text-muted-foreground">{t("shortcuts")}</p>
        <ol className="space-y-1">
          {queue.map((item, position) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setIndex(position)}
                className={cn(
                  "w-full truncate rounded-[var(--radius-control)] px-3 py-2 text-left text-sm",
                  position === index
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {item.stem}
              </button>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
