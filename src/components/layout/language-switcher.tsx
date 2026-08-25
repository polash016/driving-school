"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export interface SwitchableLanguage {
  code: string;
  nativeName: string;
  shortLabel: string;
}

/**
 * Language switcher.
 *
 * Two languages get a segmented control — both visible, one tap to change. Beyond two that stops
 * scaling on a 390px phone, so it becomes a dropdown listing each language in its OWN name
 * ("Español", "العربية"): someone looking for their language is not helped by reading its English
 * name in a language they are trying to leave.
 *
 * The list is a prop rather than a compiled constant, because which languages exist is decided at
 * runtime by the school.
 */
export function LanguageSwitcher({ languages }: { languages: SwitchableLanguage[] }) {
  const locale = useLocale();
  const t = useTranslations("language");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState(false);

  if (languages.length < 2) return null;

  function switchTo(code: string) {
    if (code === locale) return;
    setPending(true);
    router.replace(pathname, { locale: code });
  }

  if (languages.length === 2) {
    return (
      <div
        role="group"
        aria-label={t("label")}
        className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
      >
        {languages.map((language) => (
          <button
            key={language.code}
            type="button"
            aria-pressed={language.code === locale}
            disabled={pending}
            onClick={() => switchTo(language.code)}
            className={cn(
              "min-h-10 min-w-11 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-sm font-medium transition-colors",
              language.code === locale
                ? "bg-card text-foreground shadow-card"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span aria-hidden>{language.shortLabel}</span>
            {/* `lang` so a screen reader pronounces the name in its own language rather than
                reading "Norsk bokmål" with English phonetics. */}
            <span className="sr-only" lang={language.code}>
              {language.nativeName}
            </span>
          </button>
        ))}
      </div>
    );
  }

  const current = languages.find((language) => language.code === locale);

  return (
    <select
      aria-label={t("label")}
      value={locale}
      disabled={pending}
      onChange={(event) => switchTo(event.target.value)}
      className="min-h-10 rounded-md border border-input bg-transparent px-2 text-sm font-medium text-foreground"
    >
      {/* A locale that is not offered to students (an admin previewing one) still has to render. */}
      {current ? null : (
        <option value={locale}>{locale.toUpperCase()}</option>
      )}
      {languages.map((language) => (
        <option key={language.code} value={language.code} lang={language.code}>
          {language.nativeName}
        </option>
      ))}
    </select>
  );
}
