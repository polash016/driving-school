import { getTranslations, setRequestLocale } from "next-intl/server";
import { SetDetail } from "@/components/admin/questions/set-detail";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { getBatch } from "@/server/services/question-bank/batches";

/** Set detail — the screen you judge one AI generation run in (spec-04 amendment). */
export default async function SetDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireUser("INSTRUCTOR");

  const [t, set] = await Promise.all([
    getTranslations("admin.sets"),
    getBatch(db, id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("detailTitle")} · {set.notes || set.kind}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">
          {set.modelVersion
            ? t("provenance", {
                model: set.modelVersion,
                prompt: set.promptVersion ?? "—",
              })
            : t("provenanceUnknown")}
        </p>
      </header>
      <SetDetail set={set} />
    </div>
  );
}
