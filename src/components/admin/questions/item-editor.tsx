"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useMemo, useState } from "react";
import { saveItemAction } from "@/app/[locale]/(admin)/admin/questions/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { QuestionCard } from "@/components/quiz/question-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult } from "@/server/contracts/common";

/**
 * Bilingual item editor (spec-04). Options are edited as ONE list carrying both languages, so
 * the two locales cannot drift out of key parity — the failure mode the contract's superRefine
 * exists to catch is simply not reachable from this UI.
 *
 * The preview renders through the same `QuestionCard` the student exam uses (D4).
 */

const OPTION_KEYS = ["a", "b", "c", "d", "e", "f"] as const;
type Locale = "en" | "nb";

interface EditorOption {
  key: string;
  en: string;
  nb: string;
}

const ITEM_TYPES = ["TEXT", "IMAGE", "SIGN"] as const;
type ItemType = (typeof ITEM_TYPES)[number];

export interface ItemEditorProps {
  topics: { id: string; label: string }[];
  licenseClasses: { id: string; code: string }[];
  /**
   * Pictures this question can be asked about — uploads from /admin/images and the sign registry.
   * Passed in from the server page so the editor stays a pure client component.
   */
  images: { id: string; url: string; label: string; kind: "UPLOAD" | "SIGN" }[];
  item?: {
    id: string;
    topicId: string;
    licenseClassId: string | null;
    difficulty: number;
    type: ItemType;
    sourceImageId: string | null;
    version: number;
    correctOptionKey: string | null;
    content: {
      en: {
        stem: string;
        options: { key: string; text: string }[];
        explanation?: string;
      };
      nb: {
        stem: string;
        options: { key: string; text: string }[];
        explanation?: string;
      };
    };
    legalCitations: { sourceCode: string; ref: string }[];
  };
}

export function ItemEditor({
  topics,
  licenseClasses,
  images,
  item,
}: ItemEditorProps) {
  const t = useTranslations("admin.questions");
  const tErrors = useTranslations();
  const uiLocale = useLocale() as Locale;

  const [stemEn, setStemEn] = useState(item?.content.en.stem ?? "");
  const [stemNb, setStemNb] = useState(item?.content.nb.stem ?? "");
  const [explanationEn, setExplanationEn] = useState(
    item?.content.en.explanation ?? "",
  );
  const [explanationNb, setExplanationNb] = useState(
    item?.content.nb.explanation ?? "",
  );
  const [options, setOptions] = useState<EditorOption[]>(() =>
    item
      ? item.content.en.options.map((option, index) => ({
          key: option.key,
          en: option.text,
          nb: item.content.nb.options[index]?.text ?? "",
        }))
      : [
          { key: "a", en: "", nb: "" },
          { key: "b", en: "", nb: "" },
          { key: "c", en: "", nb: "" },
        ],
  );
  const [correctKey, setCorrectKey] = useState(item?.correctOptionKey ?? "a");
  const [type, setType] = useState<ItemType>(item?.type ?? "TEXT");
  const [sourceImageId, setSourceImageId] = useState(item?.sourceImageId ?? "");
  const [topicId, setTopicId] = useState(item?.topicId ?? topics[0]?.id ?? "");
  const [difficulty, setDifficulty] = useState(item?.difficulty ?? 3);
  const [licenseClassId, setLicenseClassId] = useState(
    item?.licenseClassId ?? "",
  );
  const [citations, setCitations] = useState(
    item?.legalCitations?.length
      ? item.legalCitations
      : [{ sourceCode: "", ref: "" }],
  );
  const [previewLocale, setPreviewLocale] = useState<Locale>(uiLocale);

  const [state, formAction] = useActionState<
    ActionResult<{ id: string }> | undefined,
    FormData
  >(saveItemAction, undefined);

  const payload = useMemo(
    () => ({
      ...(item ? { id: item.id } : {}),
      type,
      // Only an image/sign question carries a picture; switching back to TEXT must clear the link
      // rather than leave an orphaned reference that the exam screen would then render.
      sourceImageId: type === "TEXT" ? null : sourceImageId || null,
      topicId,
      licenseClassId: licenseClassId || null,
      difficulty,
      content: {
        en: {
          stem: stemEn,
          options: options.map((option) => ({
            key: option.key,
            text: option.en,
          })),
          explanation: explanationEn,
        },
        nb: {
          stem: stemNb,
          options: options.map((option) => ({
            key: option.key,
            text: option.nb,
          })),
          explanation: explanationNb,
        },
      },
      correctOptionKey: correctKey,
      legalCitations: citations.filter(
        (citation) => citation.sourceCode && citation.ref,
      ),
    }),
    [
      citations,
      correctKey,
      difficulty,
      explanationEn,
      explanationNb,
      item,
      licenseClassId,
      options,
      sourceImageId,
      stemEn,
      stemNb,
      topicId,
      type,
    ],
  );

  function updateOption(index: number, patch: Partial<EditorOption>) {
    setOptions((current) =>
      current.map((option, i) =>
        i === index ? { ...option, ...patch } : option,
      ),
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="payload" value={JSON.stringify(payload)} />

        {state?.ok === false ? (
          <FormAlert>{tErrors(state.messageKey)}</FormAlert>
        ) : null}
        {state?.ok ? <FormAlert tone="success">{t("saved")}</FormAlert> : null}

        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("stem")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field
              label="English"
              name="stemEn"
              value={stemEn}
              onChange={(event) => setStemEn(event.target.value)}
              required
            />
            <Field
              label="Norsk"
              name="stemNb"
              value={stemNb}
              onChange={(event) => setStemNb(event.target.value)}
              required
            />
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("options")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <fieldset className="space-y-3">
              <legend className="sr-only">{t("correctOption")}</legend>
              {options.map((option, index) => (
                <div
                  key={option.key}
                  className="grid gap-2 rounded-[var(--radius-control)] border border-border p-3 md:grid-cols-[auto_1fr_1fr_auto] md:items-end"
                >
                  <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                    <input
                      type="radio"
                      name="correctOptionKey"
                      value={option.key}
                      checked={correctKey === option.key}
                      onChange={() => setCorrectKey(option.key)}
                      className="size-4"
                    />
                    <span className="uppercase">{option.key}</span>
                    <span className="sr-only">{t("correctOption")}</span>
                  </label>
                  <Field
                    label={`English — ${t("optionLabel", { key: option.key.toUpperCase() })}`}
                    value={option.en}
                    onChange={(event) =>
                      updateOption(index, { en: event.target.value })
                    }
                    required
                  />
                  <Field
                    label={`Norsk — ${t("optionLabel", { key: option.key.toUpperCase() })}`}
                    value={option.nb}
                    onChange={(event) =>
                      updateOption(index, { nb: event.target.value })
                    }
                    required
                  />
                  {options.length > 2 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11"
                      onClick={() =>
                        setOptions((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      {t("removeOption", { key: option.key.toUpperCase() })}
                    </Button>
                  ) : null}
                </div>
              ))}
            </fieldset>

            {options.length < OPTION_KEYS.length ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setOptions((current) => [
                    ...current,
                    { key: OPTION_KEYS[current.length], en: "", nb: "" },
                  ])
                }
              >
                {t("addOption")}
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("explanation")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field
              label="English"
              value={explanationEn}
              onChange={(event) => setExplanationEn(event.target.value)}
              required
            />
            <Field
              label="Norsk"
              value={explanationNb}
              onChange={(event) => setExplanationNb(event.target.value)}
              required
            />
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(5)]">
          <CardHeader>
            <CardTitle className="text-base">{t("citations")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("citationHint")}</p>
            {citations.map((citation, index) => (
              <div
                key={index}
                className="grid gap-2 md:grid-cols-[1fr_1fr_auto] md:items-end"
              >
                <Field
                  label={t("citationSource")}
                  value={citation.sourceCode}
                  onChange={(event) =>
                    setCitations((current) =>
                      current.map((c, i) =>
                        i === index
                          ? { ...c, sourceCode: event.target.value }
                          : c,
                      ),
                    )
                  }
                />
                <Field
                  label={t("citationRef")}
                  value={citation.ref}
                  onChange={(event) =>
                    setCitations((current) =>
                      current.map((c, i) =>
                        i === index ? { ...c, ref: event.target.value } : c,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() =>
                    setCitations((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                >
                  {t("removeCitation")}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setCitations((current) => [
                  ...current,
                  { sourceCode: "", ref: "" },
                ])
              }
            >
              {t("addCitation")}
            </Button>
          </CardContent>
        </Card>

        <Card className="[--card-spacing:--spacing(5)]">
          <CardContent className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5 text-sm font-medium">
              {t("type")}
              <select
                value={type}
                onChange={(event) => setType(event.target.value as ItemType)}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {ITEM_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`types.${value}` as "types.TEXT")}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              {t("topic")}
              <select
                value={topicId}
                onChange={(event) => setTopicId(event.target.value)}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              {t("difficulty")}
              <select
                value={difficulty}
                onChange={(event) => setDifficulty(Number(event.target.value))}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                {[1, 2, 3, 4, 5].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              {t("licenseClass")}
              <select
                value={licenseClassId}
                onChange={(event) => setLicenseClassId(event.target.value)}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                <option value="">{t("anyLicenseClass")}</option>
                {licenseClasses.map((licenseClass) => (
                  <option key={licenseClass.id} value={licenseClass.id}>
                    {licenseClass.code}
                  </option>
                ))}
              </select>
            </label>
          </CardContent>
        </Card>

        {/*
          The picture is only part of an image or sign question, so the picker appears only then —
          a permanently visible gallery on every text question is noise, and a stale selection left
          behind by a type change is a bug waiting to reach a student.
        */}
        {type !== "TEXT" ? (
          <Card className="[--card-spacing:--spacing(5)]">
            <CardHeader>
              <CardTitle className="text-base">{t("image")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {images.length === 0 ? (
                <p className="text-sm/relaxed text-muted-foreground">
                  {t("imageEmpty")}
                </p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t("image")}
                  className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5"
                >
                  {images.map((image) => {
                    const selected = sourceImageId === image.id;
                    return (
                      <button
                        key={image.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        title={image.label}
                        onClick={() =>
                          setSourceImageId(selected ? "" : image.id)
                        }
                        className={`flex min-h-11 flex-col items-center gap-1 rounded-[var(--radius-control)] border p-1.5 transition-colors ${
                          selected
                            ? "border-primary ring-2 ring-primary"
                            : "border-input hover:border-muted-foreground"
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- admin picker; sources are app routes and registry assets */}
                        <img
                          src={image.url}
                          alt=""
                          loading="lazy"
                          className="h-14 w-full rounded-sm bg-muted object-contain"
                        />
                        <span className="line-clamp-1 text-[11px] text-muted-foreground">
                          {image.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {!sourceImageId ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {t("imageRequired")}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <SubmitButton label={t("save")} />
      </form>

      <aside className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">
            {t("preview")}
          </h2>
          <div className="flex gap-1">
            {(["en", "nb"] as const).map((locale) => (
              <Button
                key={locale}
                type="button"
                size="sm"
                variant={previewLocale === locale ? "secondary" : "ghost"}
                onClick={() => setPreviewLocale(locale)}
              >
                {locale.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("previewHint")}</p>
        {/* 390px frame: the student design target (CLAUDE.md). */}
        <div className="w-[390px] max-w-full rounded-[var(--radius-base)] bg-background p-4 ring-1 ring-border">
          <QuestionCard
            stem={previewLocale === "en" ? stemEn : stemNb}
            // The preview is only honest if it shows what the student sees, picture included —
            // an image question previewed without its image hides the one thing worth checking.
            imageUrl={
              type === "TEXT"
                ? null
                : (images.find((image) => image.id === sourceImageId)?.url ??
                  null)
            }
            imageAlt=""
            options={options.map((option) => ({
              key: option.key,
              text: previewLocale === "en" ? option.en : option.nb,
            }))}
            reveal={{
              correctOptionKey: correctKey,
              explanation:
                previewLocale === "en" ? explanationEn : explanationNb,
            }}
          />
        </div>
      </aside>
    </div>
  );
}
