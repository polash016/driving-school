import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireUser } from "@/server/auth/require-user";

/**
 * Staff area. INSTRUCTOR is the floor for the group; individual screens raise the bar
 * (invites and bulk actions require ADMIN). Students land on the bilingual 403 boundary.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser("INSTRUCTOR");
  const t = await getTranslations("nav");

  const links = [
    { href: "/admin/questions", label: t("questions") },
    { href: "/admin/review", label: t("review") },
    { href: "/admin/sets", label: t("sets") },
    { href: "/admin/images", label: t("images") },
    { href: "/admin/signs", label: t("signs") },
    { href: "/admin/questions/accuracy", label: t("accuracy") },
    ...(user.role === "ADMIN"
      ? [
          { href: "/admin/task-sets" as const, label: t("taskSets") },
          { href: "/admin/ai" as const, label: t("ai") },
          { href: "/admin/languages" as const, label: t("languages") },
          { href: "/admin/security" as const, label: t("security") },
          { href: "/admin/invites" as const, label: t("invites") },
        ]
      : []),
  ] as const;

  return (
    // data-surface="plain" opts admin out of the Aurora glass (spec-18 §2): these screens are
    // dense with tables, where a translucent surface is noise and a blurred layer under a long
    // grid is the most expensive thing on the page for the least benefit.
    <div data-surface="plain" className="flex flex-1 flex-col bg-background">
      <nav
        aria-label={t("admin")}
        className="border-b border-border bg-card/60"
      >
        <ul className="mx-auto flex w-full max-w-5xl flex-wrap gap-1 px-4 py-1.5">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </div>
  );
}
