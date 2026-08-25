import { getTranslations, setRequestLocale } from "next-intl/server";
import { QuestionTable } from "@/components/admin/questions/question-table";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listItems } from "@/server/services/question-bank/items";
import type { AppLocale } from "../../../../../../config/school.config";

/** The question bank browser (spec-04). Server-paginated; filters come in as search params. */
export default async function QuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const user = await requireUser("INSTRUCTOR");

  const [t, page, topics] = await Promise.all([
    getTranslations("admin.questions"),
    listItems(
      db,
      {
        page: Number(query.page ?? 1),
        pageSize: 20,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.topicSlug ? { topicSlug: query.topicSlug } : {}),
      ...(query.difficulty ? { difficulty: Number(query.difficulty) } : {}),
      ...(query.search ? { search: query.search } : {}),
        ...(query.languageIncomplete === "1" ? { languageIncomplete: true } : {}),
        ...(query.awaitingMyReview === "1" ? { awaitingMyReview: true } : {}),
      },
      user.id,
    ),
    // Every topic, not just the roots: questions are tagged to the subtopic they test, and a
    // table that cannot name a question's topic is worse than no column at all.
    db.topic.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true, name: true, parentId: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  // How much is actually waiting on this person — the number that makes the filter worth using.
  const awaitingMine = await db.masterItem.count({
    where: {
      status: "IN_REVIEW",
      deletedAt: null,
      NOT: { approvals: { some: { approverId: user.id } } },
      OR: [{ createdById: { not: user.id } }, { createdBy: "AI" }],
    },
  });

  // Roots first, each followed by its own children, so the filter reads as the tree it is.
  const nameOf = (topic: (typeof topics)[number]) =>
    pickBilingualText(topic.name, locale as AppLocale);
  const roots = topics.filter((topic) => !topic.parentId);
  const topicOptions = roots.flatMap((root) => [
    { id: root.id, slug: root.slug, label: nameOf(root) },
    ...topics
      .filter((topic) => topic.parentId === root.id)
      .map((child) => ({ id: child.id, slug: child.slug, label: `— ${nameOf(child)}` })),
  ]);
  // Orphans (a topic whose parent was removed) must still be nameable in the table.
  const listed = new Set(topicOptions.map((option) => option.id));
  topicOptions.push(
    ...topics
      .filter((topic) => !listed.has(topic.id))
      .map((topic) => ({ id: topic.id, slug: topic.slug, label: nameOf(topic) })),
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{t("title")}</h1>
          <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/admin/questions/new">{t("new")}</Link>
        </Button>
      </header>

      <QuestionTable
        page={page}
        topics={topicOptions}
        canBulkAct={user.role === "ADMIN"}
        awaitingMine={awaitingMine}
        query={{
          awaitingMyReview: query.awaitingMyReview === "1",
          status: query.status ?? "",
          type: query.type ?? "",
          topicSlug: query.topicSlug ?? "",
          difficulty: query.difficulty ?? "",
          search: query.search ?? "",
          languageIncomplete: query.languageIncomplete === "1",
        }}
      />
    </div>
  );
}
