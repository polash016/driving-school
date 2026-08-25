"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { bulkActionAction } from "@/app/[locale]/(admin)/admin/questions/actions";
import { FormAlert } from "@/components/auth/form-alert";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/contracts/common";
import type { BulkOutcome } from "@/server/services/question-bank/transitions";

/** Filterable, server-paginated question list with bulk actions (spec-04). */

interface Row {
  id: string;
  type: string;
  status: string;
  topicId: string;
  difficulty: number;
  version: number;
  createdBy: string;
  stemPreview: string;
  updatedAt: Date;
}

const STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "NEEDS_REVIEW", "RETIRED"] as const;
const TYPES = ["TEXT", "IMAGE", "SIGN"] as const;

/** Bulk is only useful if it says precisely what happened to each item. */
function BulkSummary({ outcomes }: { outcomes: BulkOutcome[] }) {
  const t = useTranslations("admin.questions");
  const tErrors = useTranslations();

  const count = (outcome: BulkOutcome["outcome"]) =>
    outcomes.filter((row) => row.outcome === outcome).length;
  const failures = outcomes.filter((row) => row.outcome === "failed");
  const waiting = count("awaitingApproval");

  return (
    <div className="space-y-2">
      <FormAlert tone={failures.length > 0 ? "info" : "success"}>
        {t("bulkDone", {
          approved: count("approved") + count("retired") + count("retagged"),
          waiting,
          failed: failures.length,
          total: outcomes.length,
        })}
      </FormAlert>
      {waiting > 0 ? (
        <p className="text-sm text-muted-foreground">{t("bulkAwaitingSecond")}</p>
      ) : null}
      {failures.length > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {failures.slice(0, 8).map((failure) => (
            <li key={failure.itemId}>{tErrors(failure.messageKey ?? "errors.internal")}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function QuestionTable({
  page,
  topics,
  canBulkAct,
  awaitingMine,
  query,
}: {
  page: { items: Row[]; page: number; pageSize: number; totalCount: number };
  topics: { id: string; slug: string; label: string }[];
  canBulkAct: boolean;
  /** How many questions are waiting on this reviewer specifically. */
  awaitingMine: number;
  query: {
    awaitingMyReview: boolean;
    status: string;
    type: string;
    topicSlug: string;
    difficulty: string;
    search: string;
    languageIncomplete: boolean;
  };
}) {
  const t = useTranslations("admin.questions");
  const tErrors = useTranslations();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [state, formAction] = useActionState<
    ActionResult<BulkOutcome[]> | undefined,
    FormData
  >(bulkActionAction, undefined);

  const topicLabel = (topicId: string) =>
    topics.find((topic) => topic.id === topicId)?.label ?? "—";
  const lastPage = Math.max(1, Math.ceil(page.totalCount / page.pageSize));

  function applyFilters(formData: FormData) {
    const next = new URLSearchParams();
    for (const key of ["status", "type", "topicSlug", "difficulty", "search"]) {
      const value = String(formData.get(key) ?? "");
      if (value) next.set(key, value);
    }
    if (formData.get("languageIncomplete")) next.set("languageIncomplete", "1");
    router.push(`/admin/questions?${next.toString()}`);
  }

  return (
    <div className="space-y-4">
      <form
        action={applyFilters}
        className="grid gap-3 rounded-[var(--radius-base)] bg-card p-4 shadow-card ring-1 ring-foreground/5 md:grid-cols-[2fr_1fr_1fr_1fr_auto]"
      >
        <label className="space-y-1.5 text-sm font-medium">
          {t("search")}
          <Input
            name="search"
            defaultValue={query.search}
            placeholder={t("searchPlaceholder")}
            className="h-11"
          />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          {t("filterTopic")}
          <select
            name="topicSlug"
            defaultValue={query.topicSlug}
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          >
            <option value="">{t("anyTopic")}</option>
            {topics.map((topic) => (
              <option key={topic.slug} value={topic.slug}>
                {topic.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          {t("filterStatus")}
          <select
            name="status"
            defaultValue={query.status}
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          >
            <option value="">{t("anyStatus")}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          {t("filterType")}
          <select
            name="type"
            defaultValue={query.type}
            className="h-11 w-full rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          >
            <option value="">{t("anyType")}</option>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" className="min-h-11">
            {t("apply")}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground md:col-span-5">
          <input
            type="checkbox"
            name="languageIncomplete"
            defaultChecked={query.languageIncomplete}
            className="size-4"
          />
          {t("languageIncomplete")}
        </label>
      </form>

      {canBulkAct ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* The queue that matters for bulk review: what THIS reviewer can still move. */}
            <Button asChild variant={query.awaitingMyReview ? "secondary" : "outline"}>
              <Link href="/admin/questions?awaitingMyReview=1">
                {t("awaitingMyReview", { count: awaitingMine })}
              </Link>
            </Button>
            <Button asChild variant={query.status === "DRAFT" ? "secondary" : "ghost"}>
              <Link href="/admin/questions?status=DRAFT">{t("filterDrafts")}</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/admin/questions">{t("clear")}</Link>
            </Button>
            <Link
              href="/admin/review"
              className="ml-auto text-sm text-primary underline-offset-4 hover:underline"
            >
              {t("reviewQueueLink")}
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">{t("bulkReviewHint")}</p>
        </div>
      ) : null}

      {canBulkAct && selected.length > 0 ? (
        <form
          action={formAction}
          className="flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] bg-accent px-4 py-3"
        >
          {selected.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <span className="text-sm font-medium text-accent-foreground">
            {t("selected", { count: selected.length })}
          </span>
          {/* Each button submits its own action — a hidden one never fires, which is why bulk
              approve silently posted an empty action before. */}
          <SubmitButton label={t("bulkApprove")} name="action" value="APPROVE" />
          <SubmitButton
            label={t("bulkRetire")}
            name="action"
            value="RETIRE"
            variant="destructive"
          />
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => setSelected([])}
          >
            {t("clearSelection")}
          </Button>
        </form>
      ) : null}

      {state?.ok === false ? <FormAlert>{tErrors(state.messageKey)}</FormAlert> : null}
      {state?.ok ? <BulkSummary outcomes={state.data} /> : null}

      {page.items.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-muted-foreground">
          {page.totalCount === 0 && !query.search ? t("emptyBank") : t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-base)] bg-card shadow-card ring-1 ring-foreground/5">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                {canBulkAct ? (
                  <th scope="col" className="w-10 p-3">
                    {/* Select-all over the current page: the unit a reviewer works through. */}
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={t("selectAll")}
                      checked={
                        page.items.length > 0 &&
                        page.items.every((row) => selected.includes(row.id))
                      }
                      onChange={(event) =>
                        setSelected(event.target.checked ? page.items.map((row) => row.id) : [])
                      }
                    />
                  </th>
                ) : null}
                <th scope="col" className="p-3 font-medium">{t("columnQuestion")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnTopic")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnStatus")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnDifficulty")}</th>
                <th scope="col" className="p-3 font-medium">{t("columnSource")}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((row) => (
                <tr key={row.id} className="border-b border-border/60 last:border-0">
                  {canBulkAct ? (
                    <td className="p-3">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={row.stemPreview}
                        checked={selected.includes(row.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, row.id]
                              : current.filter((id) => id !== row.id),
                          )
                        }
                      />
                    </td>
                  ) : null}
                  <td className="max-w-md p-3">
                    <Link
                      href={`/admin/questions/${row.id}`}
                      className="block truncate font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {row.stemPreview}
                    </Link>
                  </td>
                  <td className="p-3 text-muted-foreground">{topicLabel(row.topicId)}</td>
                  <td className="p-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        row.status === "APPROVED" &&
                          "bg-[var(--status-success-soft)] text-[var(--status-success)]",
                        row.status === "RETIRED" && "bg-muted text-muted-foreground",
                        row.status === "IN_REVIEW" &&
                          "bg-[var(--status-warning-soft)] text-[var(--status-warning)]",
                        row.status === "NEEDS_REVIEW" && "bg-destructive/10 text-destructive",
                        row.status === "DRAFT" && "bg-muted text-muted-foreground",
                      )}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="p-3 text-muted-foreground">{row.difficulty}/5</td>
                  <td className="p-3 text-muted-foreground">
                    {row.createdBy === "AI" ? t("sourceAI") : t("sourceHUMAN")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 ? (
        <nav className="flex items-center justify-center gap-2" aria-label="pagination">
          {Array.from({ length: lastPage }, (_, index) => index + 1).map((number) => (
            <Button
              key={number}
              asChild
              size="sm"
              variant={number === page.page ? "secondary" : "ghost"}
            >
              <Link href={`/admin/questions?page=${number}`}>{number}</Link>
            </Button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
