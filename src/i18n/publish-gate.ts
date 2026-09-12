import type { Role } from "@prisma/client";
import type { LanguageSnapshot } from "./builtin";

/**
 * An unfinished language is staff-only (spec-20, developer decision 2026-09-12).
 *
 * The switcher hides a language until every unit is servable, but `/xx` routed for everyone, so a
 * bookmarked or guessed URL showed a student a half-English site — the exact thing the coverage
 * gate exists to prevent. Students and anonymous visitors now land on the same page under the
 * language's fallback; the people who review the language keep the preview, because judging a
 * translation means reading it where a student would.
 *
 * Pure, so the layout that applies it stays a few lines and the rule is testable without a
 * request. Not in the proxy: deciding needs the session, and the auth config reaches Prisma.
 */
const PREVIEW_ROLES: ReadonlySet<Role> = new Set<Role>(["INSTRUCTOR", "ADMIN"]);

export function unpublishedLanguageRedirect(input: {
  language: LanguageSnapshot | undefined;
  role: Role | null;
  pathname: string | null;
}): { href: string; locale: string } | null {
  const { language } = input;
  if (!language || language.isBuiltIn || language.studentVisible) return null;
  if (input.role !== null && PREVIEW_ROLES.has(input.role)) return null;
  return {
    href: pathUnderPrefix(input.pathname, language.urlPrefix),
    locale: language.fallbackCode,
  };
}

/** The path below the language's own prefix — never below a longer prefix that merely starts with it. */
function pathUnderPrefix(pathname: string | null, prefix: string): string {
  if (!pathname || pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`))
    return pathname.slice(prefix.length) || "/";
  return "/";
}
