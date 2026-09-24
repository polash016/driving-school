"use client";

import { useTranslations } from "next-intl";
import { useActionState, useRef } from "react";
import { toast } from "sonner";
import {
  deleteLearnAction,
  transitionLearnAction,
} from "@/app/[locale]/(admin)/admin/learn/actions";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/contracts/common";
import type { LearnStatus } from "@/server/contracts/learn";

/**
 * Publish / unpublish / archive / restore, and delete for admins. One form per button, so each
 * submit names exactly one transition and the pending state stays on the control pressed.
 */
export function TransitionButtons({
  entity,
  id,
  status,
  canDelete,
  size = "sm",
}: {
  entity: "BOOK" | "DOCUMENT";
  id: string;
  status: LearnStatus;
  canDelete: boolean;
  size?: "sm" | "default";
}) {
  const t = useTranslations("admin.learn.actions");
  const tErrors = useTranslations();
  const lastTo = useRef<LearnStatus | null>(null);
  const [, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    async (previous, formData) => {
      const result = await transitionLearnAction(previous, formData);
      if (result.ok) {
        const to = lastTo.current;
        toast.success(
          t(
            to === "PUBLISHED"
              ? "publishedToast"
              : to === "ARCHIVED"
                ? "archivedToast"
                : status === "ARCHIVED"
                  ? "restoredToast"
                  : "unpublishedToast",
          ),
        );
      } else {
        toast.error(tErrors(result.messageKey));
      }
      return result;
    },
    undefined,
  );
  const [, deleteAction, deleting] = useActionState<ActionResult | undefined, FormData>(
    async (previous, formData) => {
      const result = await deleteLearnAction(previous, formData);
      if (result.ok) toast.success(t("deletedToast"));
      else toast.error(tErrors(result.messageKey));
      return result;
    },
    undefined,
  );

  const transitions: Array<{ to: LearnStatus; label: string; variant: "default" | "outline" | "secondary" }> =
    status === "DRAFT"
      ? [
          { to: "PUBLISHED", label: t("publish"), variant: "default" },
          { to: "ARCHIVED", label: t("archive"), variant: "outline" },
        ]
      : status === "PUBLISHED"
        ? [
            { to: "DRAFT", label: t("unpublish"), variant: "outline" },
            { to: "ARCHIVED", label: t("archive"), variant: "outline" },
          ]
        : [{ to: "DRAFT", label: t("restore"), variant: "secondary" }];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {transitions.map((transition) => (
        <form
          key={transition.to}
          action={formAction}
          onSubmit={() => {
            lastTo.current = transition.to;
          }}
        >
          <input type="hidden" name="entity" value={entity} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="to" value={transition.to} />
          <Button type="submit" size={size} variant={transition.variant} disabled={pending || deleting} aria-busy={pending}>
            {transition.label}
          </Button>
        </form>
      ))}
      {canDelete ? (
        <form
          action={deleteAction}
          onSubmit={(event) => {
            if (!window.confirm(t("deleteConfirm"))) event.preventDefault();
          }}
        >
          <input type="hidden" name="entity" value={entity} />
          <input type="hidden" name="id" value={id} />
          <Button type="submit" size={size} variant="ghost" className="text-destructive" disabled={pending || deleting} aria-busy={deleting}>
            {t("delete")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
