import { getTranslations, setRequestLocale } from "next-intl/server";
import { TaskSetBoard } from "@/components/admin/task-sets/task-set-board";
import { requireUser } from "@/server/auth/require-user";
import { taskSetService } from "@/server/services/task-sets";
import { schoolConfig } from "../../../../../../config/school.config";

/**
 * The task set build board (spec-16) — one row per partitioning run.
 *
 * This screen exists so that no student ever sits a slice a person has not looked at: a build
 * proposes, an admin reads the composition and warnings, and only then publishes.
 */
export default async function TaskSetsAdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("ADMIN");

  const [t, builds] = await Promise.all([
    getTranslations("admin.taskSets"),
    taskSetService.listBuilds(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>
      <TaskSetBoard
        builds={builds}
        licenseClassCode={schoolConfig.licenseClassSeeds[0].code}
      />
    </div>
  );
}
