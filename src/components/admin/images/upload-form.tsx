"use client";

import { useTranslations } from "next-intl";
import { useActionState, useRef, useState } from "react";
import {
  uploadImagesAction,
  type UploadSummary,
} from "@/app/[locale]/(admin)/admin/images/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import type { ActionResult } from "@/server/contracts/common";

/**
 * Drag-and-drop batch upload.
 *
 * The drop zone is a real `<input type="file">` with a label wrapped round it rather than a
 * div listening for drop events: that way the keyboard path and the screen-reader announcement
 * come from the platform, and drag-and-drop is the enhancement rather than the only way in.
 */
export function UploadForm({
  accept,
  maxMb,
  maxBatch,
}: {
  accept: string;
  maxMb: number;
  maxBatch: number;
}) {
  const t = useTranslations("admin.images");
  const tErrors = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [state, formAction] = useActionState<
    ActionResult<UploadSummary> | undefined,
    FormData
  >(uploadImagesAction, undefined);

  function adopt(files: FileList | null) {
    setNames(files ? [...files].map((file) => file.name) : []);
  }

  return (
    <Card>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {state?.ok === false ? (
            <FormAlert>{tErrors(state.messageKey)}</FormAlert>
          ) : null}
          {state?.ok === true ? (
            <div
              className="space-y-1 rounded-[var(--radius-control)] bg-muted px-3 py-2 text-sm"
              role="status"
            >
              <p className="font-medium text-foreground">
                {t("uploaded", { count: state.data.uploaded })}
              </p>
              {state.data.duplicates > 0 ? (
                <p className="text-muted-foreground">
                  {t("duplicate", { count: state.data.duplicates })}
                </p>
              ) : null}
              {state.data.failed > 0 ? (
                <p className="text-destructive">
                  {t("failed", { count: state.data.failed })}
                </p>
              ) : null}
            </div>
          ) : null}

          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (inputRef.current && event.dataTransfer.files.length > 0) {
                inputRef.current.files = event.dataTransfer.files;
                adopt(event.dataTransfer.files);
              }
            }}
            className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-base)] border-2 border-dashed px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-ring ${
              dragging ? "border-primary bg-primary/5" : "border-input"
            }`}
          >
            <span className="text-sm font-medium text-foreground">
              {t("choose")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("limits", { maxMb, maxBatch })}
            </span>
            <input
              ref={inputRef}
              type="file"
              name="files"
              multiple
              accept={accept}
              onChange={(event) => adopt(event.target.files)}
              className="sr-only"
            />
            {names.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {names.slice(0, 4).join(", ")}
                {names.length > 4 ? ` +${names.length - 4}` : ""}
              </span>
            ) : null}
          </label>

          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              name="attest"
              className="mt-1 size-4"
              required
            />
            <span>{t("attest")}</span>
          </label>

          <SubmitButton label={t("upload")} pendingLabel={t("uploading")} />
        </form>
      </CardContent>
    </Card>
  );
}
