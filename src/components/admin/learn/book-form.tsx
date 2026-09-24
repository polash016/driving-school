"use client";

import { useTranslations } from "next-intl";
import { useActionState, useMemo, useState } from "react";
import { upsertBookAction } from "@/app/[locale]/(admin)/admin/learn/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRouter } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";
import type { AdminBook } from "@/server/contracts/learn";
import type { PickableImage } from "@/server/services/images/library";
import { ImagePicker } from "./image-picker";
import { slugFrom } from "./slug";

export function BookForm({
  book,
  images,
  licenseClasses,
}: {
  book: AdminBook | null;
  images: PickableImage[];
  licenseClasses: Array<{ id: string; code: string }>;
}) {
  const t = useTranslations("admin.learn.book");
  const tActions = useTranslations("admin.learn.actions");
  const tErrors = useTranslations();
  const router = useRouter();
  const [titleEn, setTitleEn] = useState(book?.title.en ?? "");
  const [titleNb, setTitleNb] = useState(book?.title.nb ?? "");
  const [slug, setSlug] = useState(book?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(book));
  const [descriptionEn, setDescriptionEn] = useState(book?.description?.en ?? "");
  const [descriptionNb, setDescriptionNb] = useState(book?.description?.nb ?? "");
  const [coverImageId, setCoverImageId] = useState(book?.coverImageId ?? "");
  const [licenseClassId, setLicenseClassId] = useState(book?.licenseClassId ?? "");
  const [sortOrder, setSortOrder] = useState(book?.sortOrder ?? 0);

  const [state, formAction] = useActionState<ActionResult<{ id: string }> | undefined, FormData>(
    async (previous, formData) => {
      const result = await upsertBookAction(previous, formData);
      if (result.ok && !book) router.push(`/admin/learn/books/${result.data.id}`);
      return result;
    },
    undefined,
  );

  const payload = useMemo(
    () =>
      JSON.stringify({
        ...(book ? { id: book.id } : {}),
        slug: slugTouched ? slug : slugFrom(titleEn),
        title: { en: titleEn, nb: titleNb },
        description: { en: descriptionEn, nb: descriptionNb },
        coverImageId: coverImageId || null,
        licenseClassId: licenseClassId || null,
        sortOrder,
      }),
    [book, slug, slugTouched, titleEn, titleNb, descriptionEn, descriptionNb, coverImageId, licenseClassId, sortOrder],
  );
  const fieldError = (name: string) => (state?.ok === false ? state.fieldErrors?.[name] : undefined);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="payload" value={payload} />
      {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
      {state?.ok ? <FormAlert tone="success">{tActions("saved")}</FormAlert> : null}

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("heading")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label={`${t("title")} · EN`} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} required maxLength={120} error={fieldError("title.en") && tErrors(fieldError("title.en")!)} />
          <Field label={`${t("title")} · NO`} value={titleNb} onChange={(e) => setTitleNb(e.target.value)} required maxLength={120} />
          <Field
            label={t("slug")}
            hint={t("slugHint")}
            value={slugTouched ? slug : slugFrom(titleEn)}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            error={fieldError("slug") ? tErrors("admin.learn.errors.slug") : undefined}
            required
          />
          <label className="space-y-1.5 text-sm font-medium">
            {t("sortOrder")}
            <input type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)} className="block h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm" />
          </label>
          <Field label={`${t("description")} · EN`} value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} maxLength={300} />
          <Field label={`${t("description")} · NO`} value={descriptionNb} onChange={(e) => setDescriptionNb(e.target.value)} maxLength={300} />
          <label className="space-y-1.5 text-sm font-medium">
            {t("licenseClass")}
            <select value={licenseClassId} onChange={(e) => setLicenseClassId(e.target.value)} className="block h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm">
              <option value="">{t("licenseAny")}</option>
              {licenseClasses.map((lc) => (
                <option key={lc.id} value={lc.id}>
                  {lc.code}
                </option>
              ))}
            </select>
          </label>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("cover")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ImagePicker images={images} value={coverImageId} onChange={setCoverImageId} label={t("cover")} noneLabel={t("coverNone")} />
        </CardContent>
      </Card>

      <SubmitButton label={tActions("save")} pendingLabel={tActions("saving")} />
    </form>
  );
}
