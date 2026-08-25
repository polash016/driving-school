import { getTranslations, setRequestLocale } from "next-intl/server";
import { AiProviderPanel } from "@/components/admin/ai/provider-panel";
import { requireUser } from "@/server/auth/require-user";
import { db } from "@/server/db";
import { listProviders, listRoutes } from "@/server/services/ai/providers";

/**
 * AI providers and routing (spec-05). The school's own keys, added without a redeploy, with a
 * per-task fallback chain so a spent free-tier quota moves to the next provider instead of
 * stopping question generation.
 */
export default async function AiSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireUser("ADMIN");

  const [t, providers, routes] = await Promise.all([
    getTranslations("admin.ai"),
    listProviders(db),
    listRoutes(db),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">{t("subtitle")}</p>
      </header>
      <AiProviderPanel providers={providers} routes={routes} />
    </div>
  );
}
