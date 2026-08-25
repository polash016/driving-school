import { getTranslations, setRequestLocale } from "next-intl/server";
import { SetBoard } from "@/components/admin/questions/set-board";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listBatches } from "@/server/services/question-bank/batches";
import type { AppLocale } from "../../../../../../config/school.config";

/** The set board (spec-04 amendment) — one row per generation run. */
export default async function SetsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const [t, page, topics] = await Promise.all([
    getTranslations("admin.sets"),
    listBatches(db, { page: 1, pageSize: 50 }),
    // Children included: a generation run targets the specific subtopic it can cite law for
    // ("roundabouts"), so a root-only picker cannot express most of the real work.
    db.topic.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, parentId: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>
      <SetBoard
        sets={page.items}
        topics={topics
          .filter((topic) => !topic.parentId)
          .flatMap((root) => [
            {
              id: root.id,
              label: pickBilingualText(root.name, locale as AppLocale),
            },
            ...topics
              .filter((child) => child.parentId === root.id)
              .map((child) => ({
                id: child.id,
                label: `— ${pickBilingualText(child.name, locale as AppLocale)}`,
              })),
          ])}
      />
    </div>
  );
}
