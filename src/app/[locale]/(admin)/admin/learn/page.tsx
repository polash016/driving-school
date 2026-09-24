import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LearnTable } from "@/components/admin/learn/learn-table";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import type { LearnStatus } from "@/server/contracts/learn";
import { learnService } from "@/server/services/learn";
import { schoolConfig } from "../../../../../../config/school.config";

const TABS = ["BOOKS", "ARTICLES", "CHAPTERS"] as const;
const STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;

/** The Learn list (spec-23). Server-paginated; tab, status and search come in as search params. */
export default async function LearnAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  const user = await requireUser("INSTRUCTOR");

  const tab = TABS.includes(query.tab as (typeof TABS)[number]) ? (query.tab as (typeof TABS)[number]) : "ARTICLES";
  const status = STATUSES.includes(query.status as LearnStatus) ? (query.status as LearnStatus) : undefined;
  const search = query.search?.trim() || undefined;
  const pageNumber = Math.max(1, Number(query.page ?? 1) || 1);

  const [t, page] = await Promise.all([
    getTranslations("admin.learn"),
    learnService.listAdmin(
      { tab, page: pageNumber, pageSize: 20, ...(status ? { status } : {}), ...(search ? { search } : {}) },
      locale,
    ),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/learn/books/new">{t("newBook")}</Link>
          </Button>
          <Button asChild>
            <Link href="/admin/learn/articles/new">{t("newArticle")}</Link>
          </Button>
        </div>
      </header>
      <LearnTable
        page={page}
        query={{ tab, status, search, page: pageNumber }}
        locale={locale}
        canDelete={user.role === "ADMIN"}
      />
    </div>
  );
}
