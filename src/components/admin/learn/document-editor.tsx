"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { upsertDocumentAction } from "@/app/[locale]/(admin)/admin/learn/actions";
import { Field } from "@/components/auth/field";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Markdown } from "@/components/learn/markdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "@/i18n/navigation";
import type { ActionResult } from "@/server/contracts/common";
import type { AdminDocument, DraftResult, LearnDocKind } from "@/server/contracts/learn";
import type { PickableImage } from "@/server/services/images/library";
import { AiDraftDialog } from "./ai-draft-dialog";
import { ImageInsertDialog } from "./image-insert-dialog";
import { ImagePicker } from "./image-picker";
import { slugFrom } from "./slug";

type Side = "en" | "nb";
const SIDES: Side[] = ["en", "nb"];
const TOOLS = ["heading", "bold", "italic", "list", "link", "image"] as const;

/** Approximate, client-side; the stored count is computed by the service on save. */
function roughWords(markdown: string): number {
  const text = markdown.replace(/[#*_`>|-]+/g, " ").trim();
  return text ? text.split(/\s+/).length : 0;
}

export interface EditorDefaults {
  kind: LearnDocKind;
  bookId: string | null;
  bookTitle: string | null;
}

/**
 * The article / chapter editor (spec-23): en and nb tabs over one textarea each, a small
 * markdown toolbar, a live preview through the same renderer students see, image insertion
 * through the library, and citation rows. Saves as one JSON payload.
 */
export function DocumentEditor({
  document,
  defaults,
  topics,
  licenseClasses,
  images,
  sources,
  readingWpm,
  draftDefaultWords,
}: {
  document: AdminDocument | null;
  defaults: EditorDefaults;
  topics: Array<{ id: string; label: string }>;
  licenseClasses: Array<{ id: string; code: string }>;
  images: PickableImage[];
  sources: Array<{ code: string; name: string }>;
  readingWpm: number;
  draftDefaultWords: number;
}) {
  const t = useTranslations("admin.learn.doc");
  const tActions = useTranslations("admin.learn.actions");
  const tAi = useTranslations("admin.learn.ai");
  const tErrors = useTranslations();
  const router = useRouter();

  const kind = document?.kind ?? defaults.kind;
  const bookId = document?.bookId ?? defaults.bookId;
  const [side, setSide] = useState<Side>("en");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [title, setTitle] = useState({ en: document?.title.en ?? "", nb: document?.title.nb ?? "" });
  const [summary, setSummary] = useState({ en: document?.summary?.en ?? "", nb: document?.summary?.nb ?? "" });
  const [body, setBody] = useState({ en: document?.body.en ?? "", nb: document?.body.nb ?? "" });
  const [slug, setSlug] = useState(document?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(document));
  const [topicId, setTopicId] = useState(document?.topicId ?? topics[0]?.id ?? "");
  const [licenseClassId, setLicenseClassId] = useState(document?.licenseClassId ?? "");
  const [heroImageId, setHeroImageId] = useState(document?.heroImageId ?? "");
  const [citations, setCitations] = useState(document?.citations ?? []);
  const [imageOpen, setImageOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [provenance, setProvenance] = useState<{ createdBy: "AI"; modelVersion: string; promptVersion: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [state, formAction] = useActionState<ActionResult<{ id: string; version: number }> | undefined, FormData>(
    async (previous, formData) => {
      const result = await upsertDocumentAction(previous, formData);
      if (result.ok) {
        setDirty(false);
        if (!document) router.push(`/admin/learn/articles/${result.data.id}`);
      }
      return result;
    },
    undefined,
  );

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const effectiveSlug = slugTouched ? slug : slugFrom(title.en);
  const payload = useMemo(
    () =>
      JSON.stringify({
        ...(document ? { id: document.id } : {}),
        kind,
        bookId,
        slug: effectiveSlug,
        topicId,
        licenseClassId: licenseClassId || null,
        title,
        summary,
        body,
        heroImageId: heroImageId || null,
        citations: citations.filter((c) => c.sourceCode && c.ref.trim()),
        ...(provenance && !document ? { provenance } : {}),
      }),
    [document, kind, bookId, effectiveSlug, topicId, licenseClassId, title, summary, body, heroImageId, citations, provenance],
  );

  function useDraft(draft: DraftResult) {
    const hasContent = title.en || title.nb || body.en || body.nb;
    if (hasContent && !window.confirm(tAi("useConfirm"))) return;
    setTitle(draft.title);
    setSummary(draft.summary);
    setBody(draft.body);
    setCitations(draft.citations);
    setProvenance({ createdBy: "AI", modelVersion: draft.modelVersion, promptVersion: draft.promptVersion });
    setDirty(true);
  }
  const fieldError = (name: string) => (state?.ok === false ? state.fieldErrors?.[name] : undefined);
  const unresolved = new Set(document?.unresolvedCitations.map((c) => `${c.sourceCode}|${c.ref}`) ?? []);

  function insertAtCaret(before: string, after = "", placeholder = "") {
    const area = textareaRef.current;
    const current = body[side];
    const start = area?.selectionStart ?? current.length;
    const end = area?.selectionEnd ?? current.length;
    const selected = current.slice(start, end) || placeholder;
    const next = current.slice(0, start) + before + selected + after + current.slice(end);
    setBody({ ...body, [side]: next });
    setDirty(true);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  function runTool(tool: (typeof TOOLS)[number]) {
    switch (tool) {
      case "heading":
        return insertAtCaret("\n## ", "\n", "Heading");
      case "bold":
        return insertAtCaret("**", "**", "text");
      case "italic":
        return insertAtCaret("_", "_", "text");
      case "list":
        return insertAtCaret("\n- ", "", "item");
      case "link":
        return insertAtCaret("[", "](https://)", "text");
      case "image":
        return setImageOpen(true);
    }
  }

  const words = roughWords(body[side]);
  const minutes = words === 0 ? 0 : Math.max(1, Math.round(words / readingWpm));

  return (
    <form action={formAction} className="space-y-4" onChange={() => setDirty(true)}>
      <input type="hidden" name="payload" value={payload} />
      {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
      {state?.ok ? <FormAlert tone="success">{tActions("saved")}</FormAlert> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {dirty ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("unsaved")}
          </p>
        ) : (
          <span />
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => setAiOpen(true)}>
          {tAi("button")}
        </Button>
      </div>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{kind === "CHAPTER" ? t("headingChapter") : t("headingArticle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {kind === "CHAPTER" ? (
            <p className="text-sm md:col-span-2">
              <span className="font-medium">{t("book")}:</span> {document?.book ? document.book.title.en : defaults.bookTitle}
            </p>
          ) : null}
          <Field label={`${t("title")} · EN`} value={title.en} onChange={(e) => setTitle({ ...title, en: e.target.value })} required maxLength={120} />
          <Field label={`${t("title")} · NO`} value={title.nb} onChange={(e) => setTitle({ ...title, nb: e.target.value })} required maxLength={120} />
          <Field
            label={t("slug")}
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            error={fieldError("slug") ? tErrors("admin.learn.errors.slug") : undefined}
            required
          />
          <label className="space-y-1.5 text-sm font-medium">
            {t("topic")}
            <select value={topicId} onChange={(e) => setTopicId(e.target.value)} required className="block h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm">
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.label}
                </option>
              ))}
            </select>
          </label>
          <Field label={`${t("summary")} · EN`} hint={t("summaryHint")} value={summary.en} onChange={(e) => setSummary({ ...summary, en: e.target.value })} maxLength={300} />
          <Field label={`${t("summary")} · NO`} value={summary.nb} onChange={(e) => setSummary({ ...summary, nb: e.target.value })} maxLength={300} />
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
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{t("body")}</CardTitle>
          <div role="tablist" aria-label={t("body")} className="flex gap-1 rounded-[var(--radius-control)] bg-muted p-0.5">
            {SIDES.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={side === value}
                onClick={() => setSide(value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    setSide(value === "en" ? "nb" : "en");
                  }
                }}
                className={`min-h-9 rounded-[calc(var(--radius-control)-2px)] px-3 text-sm font-medium ${
                  side === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"
                }`}
              >
                {value === "en" ? t("tabEn") : t("tabNb")}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div role="toolbar" aria-label={t("toolbar")} className="flex flex-wrap gap-1">
            {TOOLS.map((tool) => (
              <Button key={tool} type="button" size="sm" variant="outline" onClick={() => runTool(tool)}>
                {t(tool)}
              </Button>
            ))}
            <Button type="button" size="sm" variant="ghost" className="ml-auto md:hidden" onClick={() => setMobilePreview((v) => !v)} aria-pressed={mobilePreview}>
              {mobilePreview ? t("edit") : t("preview")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("bodyHint")}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className={mobilePreview ? "hidden md:block" : ""}>
              <Textarea
                ref={textareaRef}
                aria-label={`${t("body")} · ${side.toUpperCase()}`}
                value={body[side]}
                onChange={(e) => setBody({ ...body, [side]: e.target.value })}
                className="min-h-[28rem] font-mono text-[13px] leading-relaxed"
                spellCheck
                lang={side === "nb" ? "nb" : "en"}
              />
              <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                {t("wordCount", { words, minutes })}
              </p>
            </div>
            <div className={mobilePreview ? "" : "hidden md:block"} aria-label={t("preview")}>
              <div className="max-h-[30rem] overflow-y-auto rounded-[var(--radius-control)] border border-border p-4">
                <Markdown source={body[side]} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("citations")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {citations.map((citation, index) => {
            const key = `${citation.sourceCode}|${citation.ref}`;
            return (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <label className="space-y-1 text-sm font-medium">
                  {t("citationSource")}
                  <select
                    value={citation.sourceCode}
                    onChange={(e) => setCitations(citations.map((c, i) => (i === index ? { ...c, sourceCode: e.target.value } : c)))}
                    className="block h-11 min-w-48 rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="">—</option>
                    {sources.map((source) => (
                      <option key={source.code} value={source.code}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  label={t("citationRef")}
                  value={citation.ref}
                  onChange={(e) => setCitations(citations.map((c, i) => (i === index ? { ...c, ref: e.target.value } : c)))}
                  placeholder="§ 7 nr. 2"
                  className="min-w-40"
                  error={unresolved.has(key) ? t("citationUnresolved") : undefined}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setCitations(citations.filter((_, i) => i !== index))}>
                  {t("citationRemove")}
                </Button>
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" onClick={() => setCitations([...citations, { sourceCode: sources[0]?.code ?? "", ref: "" }])}>
            {t("citationAdd")}
          </Button>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="text-base">{t("hero")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ImagePicker images={images} value={heroImageId} onChange={setHeroImageId} label={t("hero")} noneLabel={t("heroNone")} />
        </CardContent>
      </Card>

      <SubmitButton label={tActions("save")} pendingLabel={tActions("saving")} />

      <AiDraftDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        kind={kind}
        bookId={bookId}
        topics={topics}
        currentTopicId={topicId}
        sources={sources}
        defaultWords={draftDefaultWords}
        onUse={useDraft}
      />
      <ImageInsertDialog
        open={imageOpen}
        onOpenChange={setImageOpen}
        images={images}
        onInsert={(markdown) => insertAtCaret(`\n${markdown}\n`)}
      />
    </form>
  );
}
