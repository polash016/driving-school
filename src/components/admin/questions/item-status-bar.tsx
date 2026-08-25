"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  deleteItemAction,
  transitionItemAction,
} from "@/app/[locale]/(admin)/admin/questions/actions";
import type { TransitionOutcome } from "@/app/[locale]/(admin)/admin/questions/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import type { ActionResult } from "@/server/contracts/common";

/**
 * Lifecycle controls for one item. Which buttons appear is driven by the same allowed-transition
 * map the server enforces — the UI never offers a move the service would refuse.
 */
export function ItemStatusBar({
  itemId,
  status,
  canDelete,
}: {
  itemId: string;
  status: string;
  canDelete: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("admin.questions");
  const tErrors = useTranslations();
  const [state, formAction] = useActionState<
    ActionResult<TransitionOutcome> | undefined,
    FormData
  >(transitionItemAction, undefined);
  const [deleteState, deleteAction] = useActionState<ActionResult | undefined, FormData>(
    deleteItemAction,
    undefined,
  );

  const canReview = status === "DRAFT" || status === "NEEDS_REVIEW";
  const canApprove = status === "IN_REVIEW";
  const canRetire = ["DRAFT", "IN_REVIEW", "APPROVED", "NEEDS_REVIEW"].includes(status);

  return (
    <div className="space-y-2">
      {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
      {deleteState?.ok === false ? (
        <FormAlert>{tErrors(deleteState.messageKey)}</FormAlert>
      ) : null}
      {deleteState?.ok ? <FormAlert tone="success">{t("deleted")}</FormAlert> : null}

      <div className="flex flex-wrap gap-2">
        {canReview ? (
          <form action={formAction}>
            <input type="hidden" name="id" value={itemId} />
            <input type="hidden" name="to" value="IN_REVIEW" />
            <SubmitButton label={t("sendToReview")} variant="outline" />
          </form>
        ) : null}
        {canApprove ? (
          <form action={formAction}>
            <input type="hidden" name="id" value={itemId} />
            <input type="hidden" name="to" value="APPROVED" />
            <SubmitButton label={t("approve")} />
          </form>
        ) : null}
        {canRetire ? (
          <form action={formAction}>
            <input type="hidden" name="id" value={itemId} />
            <input type="hidden" name="to" value="RETIRED" />
            <input type="hidden" name="reason" value="OTHER" />
            <SubmitButton label={t("retire")} variant="destructive" />
          </form>
        ) : null}
        {canDelete ? (
          <form action={deleteAction}>
            <input type="hidden" name="id" value={itemId} />
            <input type="hidden" name="locale" value={locale} />
            <SubmitButton label={t("delete")} variant="ghost" />
          </form>
        ) : null}
      </div>
    </div>
  );
}
