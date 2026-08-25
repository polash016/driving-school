import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { NotFoundError } from "@/lib/errors";
import { ItemEditor } from "@/components/admin/questions/item-editor";
import { ItemStatusBar } from "@/components/admin/questions/item-status-bar";
import { QuestionLanguages } from "@/components/admin/languages/question-languages";
import { pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { listPickableImages } from "@/server/services/images/library";
import { db } from "@/server/db";
import { getItem } from "@/server/services/question-bank/items";
import type { AppLocale } from "../../../../../../../config/school.config";

/** Item editor + the lifecycle controls for one question (spec-04). */
export default async function EditQuestionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requireUser("INSTRUCTOR");

  const [t, item, topics, licenseClasses, images] = await Promise.all([
    getTranslations("admin.questions"),
    // A deleted question is gone, not broken: show the not-found page rather than an error.
    getItem(db, id).catch((error) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }),
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

  const content = item.content as {
    en: {
      stem: string;
      options: { key: string; text: string }[];
      explanation?: string;
    };
    nb: {
      stem: string;
      options: { key: string; text: string }[];
      explanation?: string;
    };
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("editorTitleEdit")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">
          {t("version", { version: item.version })} · {item.status}
        </p>
      </header>

      {/* A teacher who reads the language checks it here, against the English (spec-15). */}
      <QuestionLanguages
        masterItemId={item.id}
        source={{ stem: content.en.stem, options: content.en.options }}
      />

      <ItemStatusBar
        itemId={item.id}
        status={item.status}
        canDelete={user.role === "ADMIN"}
      />

      <ItemEditor
        topics={topics.map((topic) => ({
          id: topic.id,
          label: pickBilingualText(topic.name, locale as AppLocale),
        }))}
        licenseClasses={licenseClasses}
        images={images}
        item={{
          id: item.id,
          topicId: item.topicId,
          licenseClassId: item.licenseClassId,
          difficulty: item.difficulty,
          type: item.type,
          sourceImageId: item.sourceImageId ?? null,
          version: item.version,
          correctOptionKey: item.correctOptionKey,
          content,
          legalCitations: (item.legalCitations ?? []) as {
            sourceCode: string;
            ref: string;
          }[],
        }}
      />
    </div>
  );
}
