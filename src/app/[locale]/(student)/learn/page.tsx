import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ArticleCard } from "@/components/learn/article-card";
import { BookCard } from "@/components/learn/book-card";
import { ContinueReadingCard } from "@/components/learn/continue-reading-card";
import { TopicFilter } from "@/components/learn/topic-filter";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";
import { learnService } from "@/server/services/learn";
import { schoolConfig } from "../../../../../config/school.config";

/** The Learn hub (spec-23): continue card, books row, topic chips, article list. */
export default async function LearnHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  if (!schoolConfig.featureFlags.learn) notFound();
  const user = await requireUser();
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const [t, hub] = await Promise.all([
    getTranslations("learn"),
    learnService.hub(locale, user.id, { page, pageSize: 20, ...(query.topic ? { topicId: query.topic } : {}) }),
  ]);
  const lastPage = Math.max(1, Math.ceil(hub.articles.totalCount / hub.articles.pageSize));
  const nothing = hub.books.length === 0 && hub.articles.totalCount === 0 && !query.topic;

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-6">
      <header className="space-y-1.5">
        <h1 className="text-[1.55rem] font-bold tracking-[-0.026em] text-foreground">{t("title")}</h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>

      {hub.continue ? <ContinueReadingCard item={hub.continue} /> : null}

      {nothing ? (
        <section className="glass space-y-1 rounded-[calc(var(--radius-base)+6px)] p-6 text-center">
          <p className="font-semibold text-foreground">{t("emptyTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("emptyBody")}</p>
        </section>
      ) : null}

      {hub.books.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">{t("booksTitle")}</h2>
          <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
            {hub.books.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>
        </section>
      ) : null}

      {hub.topics.length > 0 || query.topic ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">{t("articlesTitle")}</h2>
          <TopicFilter topics={hub.topics} activeId={query.topic} />
          {hub.articles.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("emptyTopic")}</p>
          ) : (
            <ul className="space-y-3">
              {hub.articles.items.map((article) => (
                <li key={article.id}>
                  <ArticleCard article={article} />
                </li>
              ))}
            </ul>
          )}
          {lastPage > 1 ? (
            <nav aria-label={t("pageOf", { page, total: lastPage })} className="flex items-center justify-between text-sm">
              <Button asChild variant="outline" size="sm" disabled={page <= 1}>
                <Link href={`/learn?${new URLSearchParams({ ...(query.topic ? { topic: query.topic } : {}), page: String(page - 1) })}`}>{t("previousPage")}</Link>
              </Button>
              <span className="text-muted-foreground">{t("pageOf", { page, total: lastPage })}</span>
              <Button asChild variant="outline" size="sm" disabled={page >= lastPage}>
                <Link href={`/learn?${new URLSearchParams({ ...(query.topic ? { topic: query.topic } : {}), page: String(page + 1) })}`}>{t("nextPage")}</Link>
              </Button>
            </nav>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
