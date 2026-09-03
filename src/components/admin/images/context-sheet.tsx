"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  confirmContextSheetAction,
  extractContextSheetAction,
  generateFromImageAction,
} from "@/app/[locale]/(admin)/admin/images/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult } from "@/server/contracts/common";
import type { ContextSheet } from "@/server/contracts/image-pipeline";

export type SignOption = { code: string; name: string };

/**
 * What the AI read out of the picture, and the admin's chance to correct it (spec-06, mode 2).
 *
 * Sign identity is the only fact here that a legal citation hangs off, so it is the only thing
 * shown as a chip over the picture: a reviewer checks it by looking, not by reading a list. The
 * scene text is ordinary prose and is edited as prose.
 *
 * Confirming is optional by decision. Both buttons are offered plainly — but the copy says which
 * one leaves the facts unchecked, because the reviewer downstream inherits that choice.
 */
export function ContextSheetPanel({
  imageAssetId,
  imageUrl,
  sheet,
  verified,
  signOptions,
}: {
  imageAssetId: string;
  imageUrl: string;
  sheet: ContextSheet | null;
  verified: boolean;
  signOptions: SignOption[];
}) {
  const t = useTranslations("admin.images");
  const tErrors = useTranslations();
  const [draft, setDraft] = useState<ContextSheet | null>(sheet);

  const [extractState, extract] = useActionState<
    ActionResult<{ settled: boolean; unresolved: string[] }> | undefined,
    FormData
  >(extractContextSheetAction, undefined);
  const [confirmState, confirm] = useActionState<
    ActionResult | undefined,
    FormData
  >(confirmContextSheetAction, undefined);
  const [genState, generate] = useActionState<
    | ActionResult<{
        batchId: string;
        accepted: number;
        answerDisputed: number;
        factsVerified: boolean;
      }>
    | undefined,
    FormData
  >(generateFromImageAction, undefined);

  const nameFor = (code: string) =>
    signOptions.find((s) => s.code === code)?.name ?? code;

  function removeSign(code: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            signs: current.signs.filter((s) => s.signCode !== code),
          }
        : current,
    );
  }

  function addSign(code: string) {
    setDraft((current) => {
      if (!current || !code || current.signs.some((s) => s.signCode === code))
        return current;
      // Added by a person, so it carries full confidence — that number is display-only anyway.
      return {
        ...current,
        signs: [...current.signs, { signCode: code, confidence: 1 }],
      };
    });
  }

  const error = [extractState, confirmState, genState].find(
    (s) => s?.ok === false,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("contextSheet")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error?.ok === false ? (
          <FormAlert>{tErrors(error.messageKey)}</FormAlert>
        ) : null}

        {!draft ? (
          <>
            <p className="text-sm/relaxed text-muted-foreground">
              {t("noSheet")}
            </p>
            <form action={extract}>
              <input type="hidden" name="imageAssetId" value={imageAssetId} />
              <SubmitButton
                label={t("extract")}
                pendingLabel={t("extracting")}
              />
            </form>
          </>
        ) : (
          <>
            {/* The picture with what was found on it — a reviewer checks a sign by looking at it. */}
            <div className="relative overflow-hidden rounded-[var(--radius-base)] bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated app route */}
              <img
                src={imageUrl}
                alt=""
                className="max-h-96 w-full object-contain"
              />
              {draft.signs
                .filter((sign) => sign.bbox)
                .map((sign) => (
                  <span
                    key={sign.signCode}
                    className="pointer-events-none absolute rounded border-2 border-primary bg-primary/10"
                    style={{
                      left: `${sign.bbox!.x * 100}%`,
                      top: `${sign.bbox!.y * 100}%`,
                      width: `${sign.bbox!.w * 100}%`,
                      height: `${sign.bbox!.h * 100}%`,
                    }}
                  />
                ))}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                {t("signsFound")}
              </p>
              {draft.signs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("noSignsFound")}
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {draft.signs.map((sign) => (
                    <li key={sign.signCode}>
                      <button
                        type="button"
                        onClick={() => removeSign(sign.signCode)}
                        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-muted px-3 text-sm hover:bg-destructive/10"
                      >
                        <span>{nameFor(sign.signCode)}</span>
                        <span aria-hidden className="text-muted-foreground">
                          ×
                        </span>
                        <span className="sr-only">{t("removeSign")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <select
                aria-label={t("addSign")}
                value=""
                onChange={(event) => addSign(event.target.value)}
                className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
              >
                <option value="">{t("addSign")}</option>
                {signOptions.map((sign) => (
                  <option key={sign.code} value={sign.code}>
                    {sign.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="block space-y-1.5 text-sm font-medium">
              {t("situation")}
              <textarea
                value={draft.situationSummary}
                onChange={(event) =>
                  setDraft((c) =>
                    c ? { ...c, situationSummary: event.target.value } : c,
                  )
                }
                rows={3}
                className="w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 py-2 text-sm"
              />
            </label>

            {extractState?.ok && extractState.data.unresolved.length > 0 ? (
              <div className="space-y-1 rounded-[var(--radius-control)] bg-amber-500/10 px-3 py-2 text-sm">
                <p className="font-medium text-foreground">
                  {t("needsAttention")}
                </p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {extractState.data.unresolved.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {confirmState?.ok || verified ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("sheetConfirmed")}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <form action={confirm}>
                <input type="hidden" name="imageAssetId" value={imageAssetId} />
                <input
                  type="hidden"
                  name="sheet"
                  value={JSON.stringify(draft)}
                />
                <SubmitButton label={t("confirmSheet")} />
              </form>
              <form action={generate} className="flex items-end gap-2">
                <input type="hidden" name="imageAssetId" value={imageAssetId} />
                <label className="text-sm text-muted-foreground">
                  {t("count")}
                  <input
                    type="number"
                    name="count"
                    defaultValue={5}
                    min={1}
                    max={10}
                    className="ml-2 h-11 w-16 rounded-[var(--radius-control)] border border-input bg-transparent px-2 text-sm"
                  />
                </label>
                <SubmitButton
                  variant="secondary"
                  label={t("generate")}
                  pendingLabel={t("generating")}
                />
              </form>
            </div>
            {!verified ? (
              <p className="text-xs text-muted-foreground">
                {t("generateUnconfirmedHint")}
              </p>
            ) : null}

            {genState?.ok ? (
              <div
                className="space-y-1 rounded-[var(--radius-control)] bg-muted px-3 py-2 text-sm"
                role="status"
              >
                <p className="font-medium text-foreground">
                  {t("generated", { count: genState.data.accepted })}
                </p>
                {genState.data.answerDisputed > 0 ? (
                  <p className="text-muted-foreground">
                    {t("answerDisputed", {
                      count: genState.data.answerDisputed,
                    })}
                  </p>
                ) : null}
                <Button asChild variant="ghost" size="sm">
                  <a href="../review">{t("toReview")}</a>
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
