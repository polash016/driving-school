import { getTranslations, setRequestLocale } from "next-intl/server";
import { ItemEditor } from "@/components/admin/questions/item-editor";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listPickableImages } from "@/server/services/images/library";
import type { AppLocale } from "../../../../../../../config/school.config";

export default async function NewQuestionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const [t, topics, licenseClasses, images] = await Promise.all([
    getTranslations("admin.questions"),
    db.topic.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
    db.licenseClass.findMany({
      select: { id: true, code: true },
      orderBy: { sortOrder: "asc" },
    }),
    listPickableImages(db),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("editorTitleNew")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">
          {t("editorSubtitle")}
        </p>
      </header>
      <ItemEditor
        topics={topics.map((topic) => ({
          id: topic.id,
          label: pickBilingualText(topic.name, locale as AppLocale),
        }))}
        licenseClasses={licenseClasses}
        images={images}
      />
    </div>
  );
}
