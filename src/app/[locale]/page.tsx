import { setRequestLocale } from "next-intl/server";
import { useTranslations } from "next-intl";
import { use } from "react";
import { Card, CardContent } from "@/components/ui/card";

// Placeholder shell — the real student homepage ships in spec-09
// (built around specs/assets/reference-teorimester-homepage.png).
export default function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("home");

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-balance text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Card>
        <CardContent className="text-center text-muted-foreground">
          {t("shellNote")}
        </CardContent>
      </Card>
    </div>
  );
}
