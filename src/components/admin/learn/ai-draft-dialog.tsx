"use client";

import { SparkleIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { draftDocumentAction } from "@/app/[locale]/(admin)/admin/learn/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/contracts/common";
import type { DraftResult, LearnDocKind } from "@/server/contracts/learn";

const LENGTHS = [400, 700, 1000] as const;

/**
 * The AI draft dialog (spec-23 C8). Runs the synchronous server action with a pending state the
 * screen reader hears (`role=status`, `aria-busy`); the result is summarised, and "Use draft"
 * hands it to the editor. Nothing is stored here.
 */
export function AiDraftDialog({
  open,
  onOpenChange,
  kind,
  bookId,
  topics,
  currentTopicId,
  sources,
  defaultWords,
  onUse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: LearnDocKind;
  bookId: string | null;
  topics: Array<{ id: string; label: string }>;
  currentTopicId: string;
  sources: Array<{ code: string; name: string }>;
  defaultWords: number;
  onUse: (draft: DraftResult) => void;
}) {
  const t = useTranslations("admin.learn.ai");
  const tErrors = useTranslations();
  const [topicId, setTopicId] = useState(currentTopicId);
  const [sourceCodes, setSourceCodes] = useState<string[]>([]);
  const [sectionRef, setSectionRef] = useState("");
  const [brief, setBrief] = useState("");
  const [targetWords, setTargetWords] = useState<number>(defaultWords);
  const [state, formAction, pending] = useActionState<ActionResult<DraftResult> | undefined, FormData>(
    draftDocumentAction,
    undefined,
  );

  const payload = JSON.stringify({
    topicId,
    kind,
    bookId,
    sourceCodes,
    ...(sectionRef.trim() ? { sectionRef: sectionRef.trim() } : {}),
    ...(brief.trim() ? { brief: brief.trim() } : {}),
    targetWords,
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparkleIcon weight="fill" className="size-5 text-primary" aria-hidden />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>

        {state?.ok ? (
          <div className="space-y-3" role="status">
            <FormAlert tone="success">{t("ready")}</FormAlert>
            <p className="text-sm text-muted-foreground">{t("excerpts", { count: state.data.excerptCount })}</p>
            {state.data.unresolvedCitations.length > 0 ? (
              <p className="text-sm text-muted-foreground">{t("unresolved", { count: state.data.unresolvedCitations.length })}</p>
            ) : null}
            {state.data.warnings.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {state.data.warnings.map((warning) => (
                  <li key={warning}>{t(`warnings.${warning}` as "warnings.length")}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-sm font-medium text-foreground">{state.data.title.en}</p>
            <p className="line-clamp-4 text-xs text-muted-foreground whitespace-pre-wrap">{state.data.body.en.slice(0, 600)}</p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("discard")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onUse(state.data);
                  onOpenChange(false);
                }}
              >
                {t("use")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form action={formAction} className="space-y-3" aria-busy={pending}>
            <input type="hidden" name="payload" value={payload} />
            {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
            <label className="block space-y-1.5 text-sm font-medium">
              {t("topic")}
              <select value={topicId} onChange={(e) => setTopicId(e.target.value)} disabled={pending} className="block h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm">
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="space-y-1.5" disabled={pending}>
              <legend className="text-sm font-medium">{t("sources")}</legend>
              <p className="text-xs text-muted-foreground">{sourceCodes.length === 0 ? t("sourcesAny") : ""}</p>
              <div className="flex flex-wrap gap-2">
                {sources.map((source) => {
                  const checked = sourceCodes.includes(source.code);
                  return (
                    <label key={source.code} className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm ${checked ? "border-primary bg-primary/10" : "border-border"}`}>
                      <input
                        type="checkbox"
                        className="size-3.5"
                        checked={checked}
                        onChange={(e) => setSourceCodes(e.target.checked ? [...sourceCodes, source.code] : sourceCodes.filter((c) => c !== source.code))}
                      />
                      {source.name}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("sectionRef")}
              <Input value={sectionRef} onChange={(e) => setSectionRef(e.target.value)} placeholder="§ 7" maxLength={40} disabled={pending} />
              <span className="block text-xs font-normal text-muted-foreground">{t("sectionRefHint")}</span>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              {t("brief")}
              <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={t("briefHint")} maxLength={500} disabled={pending} className="min-h-20" />
            </label>
            <fieldset className="space-y-1.5" disabled={pending}>
              <legend className="text-sm font-medium">{t("length")}</legend>
              <div className="flex gap-2">
                {LENGTHS.map((words) => (
                  <label key={words} className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm ${targetWords === words ? "border-primary bg-primary/10" : "border-border"}`}>
                    <input type="radio" name="length" className="size-3.5" checked={targetWords === words} onChange={() => setTargetWords(words)} />
                    {t("lengthWords", { words })}
                  </label>
                ))}
              </div>
            </fieldset>
            {pending ? (
              <div role="status" className="space-y-2 rounded-[var(--radius-control)] bg-muted p-3">
                <p className="text-sm text-foreground">{t("drafting")}</p>
                <p className="text-xs text-muted-foreground">{t("draftingHint")}</p>
                <div className="h-1 w-full overflow-hidden rounded-full bg-background">
                  <div className="h-full w-1/3 animate-[learn-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                {t("discard")}
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? t("drafting") : t("draft")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
