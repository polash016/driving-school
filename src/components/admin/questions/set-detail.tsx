"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  detachFromSetAction,
  transitionItemAction,
} from "@/app/[locale]/(admin)/admin/questions/actions";
import type { TransitionOutcome } from "@/app/[locale]/(admin)/admin/questions/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { BatchDetail } from "@/server/contracts/question-bank";
import type { ActionResult } from "@/server/contracts/common";

/**
 * One generation set: every question with its state and provenance, plus the curation controls.
 *
 * "Revise with AI" and "Generate more" are rendered disabled on purpose — revision must cite the
 * knowledge base to be worth anything, and that arrives with the AI pipeline (spec-06). A
 * disabled control with an explanation beats a live one that quietly does something worse.
 */
export function SetDetail({ set }: { set: BatchDetail }) {
  const t = useTranslations("admin.sets");
  const tQuestions = useTranslations("admin.questions");
  const tErrors = useTranslations();
  const [detachState, detachAction] = useActionState<
    ActionResult | undefined,
    FormData
  >(detachFromSetAction, undefined);
  const [transitionState, transitionAction] = useActionState<
    ActionResult<TransitionOutcome> | undefined,
    FormData
  >(transitionItemAction, undefined);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] bg-muted px-4 py-3 text-sm">
        <span className="font-medium text-foreground">
          {t("counts", {
            approved: set.counts.approved,
            retired: set.counts.retired,
            pending: set.counts.draft + set.counts.inReview,
          })}
        </span>
        <span className="text-muted-foreground">
          {set.acceptanceRate === null
            ? t("acceptanceUnknown")
            : t("acceptance", {
                percent: Math.round(set.acceptanceRate * 100),
              })}
        </span>
        <span className="ml-auto flex gap-2">
          {set.counts.inReview > 0 ? (
            <Button asChild variant="secondary">
              <Link href={`/admin/review?batch=${set.id}`}>
                {t("reviewThisSet", { count: set.counts.inReview })}
              </Link>
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled title={t("aiSoon")}>
            {t("aiRevise")}
          </Button>
          <Button type="button" variant="outline" disabled title={t("aiSoon")}>
            {t("aiGenerateMore")}
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("aiSoon")}</p>

      {detachState?.ok === false ? (
        <FormAlert>{tErrors(detachState.messageKey)}</FormAlert>
      ) : null}
      {detachState?.ok ? (
        <FormAlert tone="success">{t("removed")}</FormAlert>
      ) : null}
      {transitionState?.ok === false ? (
        <FormAlert>{tErrors(transitionState.messageKey)}</FormAlert>
      ) : null}

      {set.items.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {t("emptySet")}
        </p>
      ) : (
        <ul className="space-y-3">
          {set.items.map((item) => (
            <li key={item.id}>
              <Card className="[--card-spacing:--spacing(4)]">
                <CardContent className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <Link
                      href={`/admin/questions/${item.id}`}
                      className="block font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {item.stemPreview}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {item.status} · {item.difficulty}/5 ·{" "}
                      {item.createdBy === "AI"
                        ? tQuestions("sourceAI")
                        : tQuestions("sourceHUMAN")}
                      {item.reviewReason ? ` · ${item.reviewReason}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {item.status === "IN_REVIEW" ? (
                      <form action={transitionAction}>
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="to" value="APPROVED" />
                        <SubmitButton label={t("keep")} />
                      </form>
                    ) : null}
                    <form action={detachAction}>
                      <input type="hidden" name="itemId" value={item.id} />
                      <SubmitButton
                        label={t("removeFromSet")}
                        variant="ghost"
                      />
                    </form>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
