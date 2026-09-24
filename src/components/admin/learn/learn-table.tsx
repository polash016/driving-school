"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { pickBilingualText } from "@/lib/i18n-content";
import type { AdminLearnPage, LearnStatus } from "@/server/contracts/learn";
import { StatusBadge } from "./status-badge";
import { TransitionButtons } from "./transition-buttons";

type Tab = "BOOKS" | "ARTICLES" | "CHAPTERS";
const TABS: Tab[] = ["BOOKS", "ARTICLES", "CHAPTERS"];
const STATUSES: LearnStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"];

export interface LearnListQuery {
  tab: Tab;
  status?: LearnStatus;
  search?: string;
  page: number;
}

/** The Learn list (spec-23): server-paginated, filters in the URL, one row per book or document. */
export function LearnTable({
  page,
  query,
  locale,
  canDelete,
}: {
  page: AdminLearnPage;
  query: LearnListQuery;
  locale: string;
  canDelete: boolean;
}) {
  const t = useTranslations("admin.learn");
  const format = useFormatter();
  const router = useRouter();

  const lastPage = Math.max(1, Math.ceil(page.totalCount / page.pageSize));
  const firstItem = page.totalCount === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const lastItem = Math.min(page.page * page.pageSize, page.totalCount);

  function href(next: Partial<LearnListQuery>): `/admin/learn?${string}` | "/admin/learn" {
    const merged = { ...query, ...next };
    const params = new URLSearchParams();
    if (merged.tab !== "ARTICLES") params.set("tab", merged.tab);
    if (merged.status) params.set("status", merged.status);
    if (merged.search) params.set("search", merged.search);
    if (merged.page > 1) params.set("page", String(merged.page));
    const search = params.toString();
    return search ? `/admin/learn?${search}` : "/admin/learn";
  }

  function applyFilters(formData: FormData) {
    const status = String(formData.get("status") ?? "");
    const search = String(formData.get("search") ?? "").trim();
    router.push(
      href({
        status: STATUSES.includes(status as LearnStatus) ? (status as LearnStatus) : undefined,
        search: search || undefined,
        page: 1,
      }),
    );
  }

  const isBooks = query.tab === "BOOKS";

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t("title")} className="flex gap-1 border-b border-border">
        {TABS.map((tab) => (
          <Link
            key={tab}
            role="tab"
            aria-selected={query.tab === tab}
            href={href({ tab, page: 1 })}
            className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${
              query.tab === tab
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`tabs.${tab}`)}
          </Link>
        ))}
      </div>

      <form action={applyFilters} className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm font-medium">
          {t("filterStatus")}
          <select
            name="status"
            defaultValue={query.status ?? ""}
            className="block h-11 min-w-40 rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          >
            <option value="">{t("filterAny")}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium">
          {t("search")}
          <input
            name="search"
            type="search"
            defaultValue={query.search ?? ""}
            placeholder={t("searchPlaceholder")}
            className="block h-11 min-w-56 rounded-[var(--radius-control)] border border-input bg-transparent px-3 text-sm"
          />
        </label>
        <Button type="submit" variant="secondary">
          {t("apply")}
        </Button>
        {query.status || query.search ? (
          <Button asChild variant="ghost">
            <Link href={href({ status: undefined, search: undefined, page: 1 })}>{t("clear")}</Link>
          </Button>
        ) : null}
      </form>

      {page.items.length === 0 ? (
        <p className="rounded-[var(--radius-base)] border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-base)] border border-border">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t("columns.title")}</th>
                {isBooks ? (
                  <th className="px-3 py-2">{t("columns.chapters")}</th>
                ) : (
                  <>
                    <th className="px-3 py-2">{t("columns.topic")}</th>
                    {query.tab === "CHAPTERS" ? <th className="px-3 py-2">{t("columns.book")}</th> : null}
                    <th className="px-3 py-2">{t("columns.words")}</th>
                  </>
                )}
                <th className="px-3 py-2">{t("columns.status")}</th>
                <th className="px-3 py-2">{t("columns.updated")}</th>
                <th className="px-3 py-2">{t("columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <Link
                      href={row.entity === "BOOK" ? `/admin/learn/books/${row.id}` : `/admin/learn/articles/${row.id}`}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {pickBilingualText(row.title, locale)}
                    </Link>
                    <div className="text-xs text-muted-foreground">/{row.slug}</div>
                  </td>
                  {isBooks ? (
                    <td className="px-3 py-2 tabular-nums">{row.chapterCount ?? 0}</td>
                  ) : (
                    <>
                      <td className="px-3 py-2">{row.topicName ?? "—"}</td>
                      {query.tab === "CHAPTERS" ? <td className="px-3 py-2">{row.bookTitle ?? "—"}</td> : null}
                      <td className="px-3 py-2 tabular-nums">{row.wordCountEn ?? 0}</td>
                    </>
                  )}
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {format.dateTime(row.updatedAt, { dateStyle: "medium" })}
                  </td>
                  <td className="px-3 py-2">
                    <TransitionButtons entity={row.entity} id={row.id} status={row.status} canDelete={canDelete} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label={t("page", { page: page.page })} className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t("pagination", { first: firstItem, last: lastItem, total: page.totalCount })}
        </span>
        <div className="flex gap-1">
          <Button asChild variant="outline" size="sm" disabled={page.page <= 1}>
            <Link href={href({ page: Math.max(1, page.page - 1) })} aria-disabled={page.page <= 1}>
              {t("previous")}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" disabled={page.page >= lastPage}>
            <Link href={href({ page: Math.min(lastPage, page.page + 1) })} aria-disabled={page.page >= lastPage}>
              {t("next")}
            </Link>
          </Button>
        </div>
      </nav>
    </div>
  );
}
