"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { uploadLearnImageAction } from "@/app/[locale]/(admin)/admin/learn/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/contracts/common";
import type { PickableImage } from "@/server/services/images/library";
import { ImagePicker } from "./image-picker";

type UploadData = { id: string; url: string; duplicateOfId: string | null };

/**
 * Insert a picture into a document (spec-23 C7): pick one from the library, or upload one through
 * the same gate as every other upload (attestation, sniff, dedupe). Alt text is required — an
 * image without one is a hole for a screen-reader user.
 */
export function ImageInsertDialog({
  open,
  onOpenChange,
  images,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  images: PickableImage[];
  onInsert: (markdown: string) => void;
}) {
  const t = useTranslations("admin.learn.image");
  const tErrors = useTranslations();
  const [tab, setTab] = useState<"library" | "upload">("library");
  const [selected, setSelected] = useState("");
  const [alt, setAlt] = useState("");
  const [library, setLibrary] = useState(images);
  const [state, uploadAction] = useActionState<ActionResult<UploadData> | undefined, FormData>(
    async (previous, formData) => {
      const result = await uploadLearnImageAction(previous, formData);
      if (result.ok) {
        const id = result.data.duplicateOfId ?? result.data.id;
        setLibrary((current) =>
          current.some((image) => image.id === id)
            ? current
            : [{ id, url: result.data.url, label: id.slice(-6), kind: "UPLOAD" as const }, ...current],
        );
        setSelected(id);
        setTab("library");
      }
      return result;
    },
    undefined,
  );

  const uploads = library.filter((image) => image.kind === "UPLOAD");
  const canInsert = selected !== "" && alt.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("title")}</DialogDescription>
        </DialogHeader>
        <div role="tablist" className="flex gap-1 border-b border-border">
          {(["library", "upload"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-medium ${
                tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground"
              }`}
            >
              {t(value)}
            </button>
          ))}
        </div>

        {tab === "library" ? (
          uploads.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ImagePicker images={library} value={selected} onChange={setSelected} label={t("library")} noneLabel="—" />
          )
        ) : (
          <form action={uploadAction} className="space-y-3">
            {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
            {state?.ok && state.data.duplicateOfId ? <FormAlert tone="info">{t("duplicate")}</FormAlert> : null}
            <label className="block space-y-1.5 text-sm font-medium">
              {t("file")}
              <Input type="file" name="file" accept="image/jpeg,image/png,image/webp" required />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="attest" required className="size-4" />
              {t("attest")}
            </label>
            <SubmitButton label={t("upload")} pendingLabel={t("uploading")} />
          </form>
        )}

        <label className="block space-y-1.5 text-sm font-medium">
          {t("alt")}
          <Input value={alt} onChange={(event) => setAlt(event.target.value)} placeholder={t("altHint")} maxLength={160} />
        </label>

        <DialogFooter>
          <Button
            type="button"
            disabled={!canInsert}
            onClick={() => {
              onInsert(`![${alt.trim().replace(/[[\]]/g, "")}](/api/images/${selected})`);
              setAlt("");
              setSelected("");
              onOpenChange(false);
            }}
          >
            {t("insert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
