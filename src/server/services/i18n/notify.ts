import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { localeSchema, type Locale } from "@/lib/locale";
import { absoluteUrl } from "@/lib/locale-url";
import { sendMail } from "@/server/email/mailer";
import {
  repairOutcomeEmail,
  runFailedEmail,
  runFinishedEmail,
} from "@/server/email/templates";
// Type-only: erased at compile time, so `worker.ts` importing `notifyRunEvent` from here at
// runtime forms no cycle. Same arrangement repair.ts uses with runs.ts.
import type { FinishedRun, RepairDecision } from "./worker";

/**
 * Who hears about a run, and what they are told (spec-19, user decision 2026-09-08): the admin who
 * started it, in their own language; if nobody did (CLI, worker-chained repair), every admin.
 *
 * A full language is hours of work that nobody sits and watches, so the run has to come and find
 * a human when it lands — and it has to find them exactly once, which is what the two early
 * returns in `notifyRunEvent` are for.
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
  // Index: User[role, isActive] — `role` alone, its leading column. `deletedAt` is in no index;
  // it filters the handful of rows that come back, which is why it is not a scan worth widening
  // the index for.
  const admins = await db.user.findMany({
    where: { role: "ADMIN", deletedAt: null },
    select: { email: true, profile: { select: { preferredLocale: true } } },
  });
  return admins.map((admin) => ({
    email: admin.email,
    locale: asLocale(admin.profile?.preferredLocale),
  }));
}

/**
 * Report a run that has reached a terminal state.
 *
 * Two runs that deliberately say nothing:
 *
 * - A SAMPLE. It is five units the admin is watching on screen right now — mailing them about it
 *   would be a notification about something they are already looking at.
 * - A run that just chained a repair. The repair is the same piece of work continuing, and it will
 *   report when IT finishes; reporting here as well would mail twice about one outcome.
 *
 * Nothing here throws: `sendMail` swallows transport failures by design, and `defaultAfterRun`'s
 * caller guards the rest. A mail outage must never make a finished run look failed.
 */
export async function notifyRunEvent(
  db: PrismaClient,
  run: FinishedRun,
  decision: RepairDecision,
): Promise<void> {
  if (run.kind === "SAMPLE" || decision.action === "planned") return;

  // Index: Language primary key (code).
  const language = await db.language.findUnique({
    where: { code: run.locale },
    select: { englishName: true },
  });
  // A language deleted while its run was in flight still has a run worth reporting; the code is
  // a worse name than "Arabic" but a far better one than nothing.
  const name = language?.englishName ?? run.locale;

  for (const recipient of await notificationRecipients(db, run.startedById)) {
    const url = absoluteUrl(
      env().APP_BASE_URL,
      recipient.locale,
      `/admin/languages/${run.locale}`,
    );
    const message =
      run.status === "FAILED"
        ? await runFailedEmail(recipient.locale, recipient.email, {
            language: name,
            url,
            error: run.error ?? "",
          })
        : decision.action === "exhausted"
          ? await repairOutcomeEmail(recipient.locale, recipient.email, {
              language: name,
              url,
              remaining: decision.remaining,
              stalled: false,
            })
          : decision.action === "stalled"
            ? await repairOutcomeEmail(recipient.locale, recipient.email, {
                language: name,
                url,
                // A stalled repair fixed nothing, so what is still held is what it went in with.
                remaining: run.flaggedUnits,
                stalled: true,
              })
            : run.status === "COMPLETED"
              ? await runFinishedEmail(recipient.locale, recipient.email, {
                  language: name,
                  url,
                  completed: run.translatedUnits,
                  flagged: run.flaggedUnits,
                  failed: run.failedUnits,
                })
              : // PAUSED or CANCELLED: an admin asked for that and is watching the board.
                null;
    if (message) await sendMail(message);
  }
}
