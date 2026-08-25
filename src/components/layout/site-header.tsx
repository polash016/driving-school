import Image from "next/image";
import { AccountMenu } from "@/components/layout/account-menu";
import { schoolConfig } from "../../../config/school.config";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { getRegistry } from "@/server/services/i18n/registry";

export async function SiteHeader({ locale }: { locale: string }) {
  const { school, branding } = schoolConfig;
  // Which languages a student may pick is runtime data — and only the finished ones are offered.
  const registry = await getRegistry(db);
  const languages = registry.visible().map((language) => ({
    code: language.code,
    nativeName: language.nativeName,
    shortLabel: language.shortLabel,
  }));

  return (
    <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-md items-center justify-between gap-2 px-4 md:max-w-5xl">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-2 rounded-md font-semibold text-foreground"
        >
          <Image
            src={branding.logoLight}
            alt=""
            width={28}
            height={28}
            className="dark:hidden"
            priority
          />
          <Image
            src={branding.logoDark}
            alt=""
            width={28}
            height={28}
            className="hidden dark:block"
            priority
          />
          <span className="text-base">{school.shortName}</span>
        </Link>
        <div className="flex items-center gap-1.5">
          <AccountMenu locale={locale} />
          <LanguageSwitcher languages={languages} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
