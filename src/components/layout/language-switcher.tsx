"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

const SHORT_LABELS: Record<(typeof routing.locales)[number], string> = {
  en: "EN",
  nb: "NO",
};

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("language");
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div
      role="group"
      aria-label={t("label")}
      className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
    >
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={l === locale}
          onClick={() => router.replace(pathname, { locale: l })}
          className={cn(
            "min-h-10 min-w-11 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-sm font-medium transition-colors",
            l === locale
              ? "bg-card text-foreground shadow-card"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span aria-hidden>{SHORT_LABELS[l]}</span>
          <span className="sr-only">{t(l)}</span>
        </button>
      ))}
    </div>
  );
}
