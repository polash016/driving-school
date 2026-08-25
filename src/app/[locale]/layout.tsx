import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { schoolConfig } from "../../../config/school.config";
import { SiteHeader } from "@/components/layout/site-header";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { db } from "@/server/db";
import { getRegistry } from "@/server/services/i18n/registry";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: schoolConfig.school.shortName,
    template: `%s · ${schoolConfig.school.shortName}`,
  },
  description: schoolConfig.school.name,
};

/**
 * Deliberately gone (spec-15): the locale set is runtime data now, so it cannot be enumerated at
 * build time. It prerendered nothing anyway — `SiteHeader` reads the session, which makes this
 * layout dynamic. `dynamicParams` defaults to true, so every language renders on demand.
 *
 * DO NOT add `export const dynamicParams = false` anywhere in this tree: it would 404 every
 * language a school adds after the build.
 */

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // The registry, not a compiled list — a language added in the admin panel is a real language.
  const registry = await getRegistry(db);
  if (!registry.has(locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("nav");

  return (
    <html
      lang={locale}
      // Arabic and Hebrew read right to left; the language registry decides, not a hardcoded list.
      dir={registry.directionOf(locale)}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <NextIntlClientProvider>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
            >
              {t("skipToContent")}
            </a>
            <SiteHeader locale={locale} />
            <main id="main" className="flex flex-1 flex-col">
              {children}
            </main>
            <Toaster />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
