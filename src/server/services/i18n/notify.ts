import type { PrismaClient } from "@prisma/client";
import { localeSchema, type Locale } from "@/lib/locale";

/**
 * Who hears about a run (spec-19, user decision 2026-09-08): the admin who started it, in their
 * own language; if nobody did (CLI, worker-chained repair), every admin.
 *
 * Recipients only. The templates and the sending live in Task 21 — a run that finishes at 03:00
 * has to reach somebody, and deciding *who* is the part that belongs next to the run rows.
 */
export interface Recipient {
  email: string;
  locale: Locale;
}

/**
 * `Profile.preferredLocale` is an open string (languages are runtime data since spec-15), so a
 * removed language or a hand-edited row can leave a code that no longer parses. English is the
 * fallback: a mail in the wrong language beats no mail at all.
 */
function asLocale(value: string | null | undefined): Locale {
  const parsed = localeSchema.safeParse(value ?? "en");
  return parsed.success ? parsed.data : "en";
}

export async function notificationRecipients(
  db: PrismaClient,
  startedById: string | null,
): Promise<Recipient[]> {
  if (startedById) {
    // Index: User primary key.
    const starter = await db.user.findUnique({
      where: { id: startedById },
      select: { email: true, profile: { select: { preferredLocale: true } } },
    });
    if (starter)
      return [
        {
          email: starter.email,
          locale: asLocale(starter.profile?.preferredLocale),
        },
      ];
  }
  // Index: User[role, isActive] — the leading column; admins are a handful.
  const admins = await db.user.findMany({
    where: { role: "ADMIN", deletedAt: null },
    select: { email: true, profile: { select: { preferredLocale: true } } },
  });
  return admins.map((admin) => ({
    email: admin.email,
    locale: asLocale(admin.profile?.preferredLocale),
  }));
}
