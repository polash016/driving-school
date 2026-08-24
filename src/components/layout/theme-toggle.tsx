"use client";

import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const t = useTranslations("theme");

  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={t("toggle")}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {/* Both icons rendered; CSS picks one — avoids hydration mismatch before theme resolves */}
      <SunIcon aria-hidden className="size-5 dark:hidden" />
      <MoonIcon aria-hidden className="hidden size-5 dark:block" />
    </Button>
  );
}
