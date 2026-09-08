import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { capturedMail, clearCapturedMail } from "@/server/email/mailer";
import { notificationRecipients, notifyRunEvent } from "./notify";
import type { FinishedRun, RepairDecision } from "./worker";

/**
 * Who hears about a run, and what lands in their inbox (spec-19).
 *
 * The interesting cases are both about absence: a run nobody started (the CLI, or a repair the
 * worker chained on its own) still has to reach a human, and a preferred locale that no longer
 * parses — the language it named was removed — must not silence the mail.
 *
 * The mail itself goes to the in-memory sink (`MAIL_TRANSPORT: "capture"`, forced for every test
 * in vitest.config.ts), so the assertions read real rendered messages with no SMTP anywhere.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const starter = `notify-starter-${RUN}@example.no`;
const other = `notify-other-${RUN}@example.no`;
const gone = `notify-gone-${RUN}@example.no`;
const userIds: string[] = [];
const CODE = `zn-${RUN}`.slice(0, 8);

/** A finished run row, as `workerTick` reads it back before handing it to `afterRun`. */
function finishedRun(overrides: Partial<FinishedRun> = {}): FinishedRun {
  return {
    id: "run-1",
    locale: CODE,
    kind: "SYNC",
    status: "COMPLETED",
    startedById: null,
    translatedUnits: 9,
    flaggedUnits: 1,
    failedUnits: 0,
    error: null,
    ...overrides,
  };
}

const NO_REPAIR: RepairDecision = { action: "none" };

async function makeAdmin(
  email: string,
  preferredLocale: string,
  deletedAt: Date | null = null,
) {
  const user = await db.user.create({
    data: {
      email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      deletedAt,
      profile: {
        create: { firstName: "Notify", lastName: RUN, preferredLocale },
      },
    },
    select: { id: true },
  });
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  if (!enabled) return;
  await makeAdmin(starter, "nb");
  await makeAdmin(other, "en");
  await makeAdmin(gone, "en", new Date());
  await db.language.create({
    data: {
      code: CODE,
      englishName: "Notific",
      nativeName: "Notific",
      shortLabel: "ZN",
      urlPrefix: `/${CODE}`,
    },
    select: { code: true },
  });
});

afterAll(async () => {
  if (!enabled) return;
  await db.language.deleteMany({ where: { code: CODE } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

d("notificationRecipients (spec-19)", () => {
  it("tells the admin who started the run, in their own language", async () => {
    const starterId = userIds[0];
    expect(await notificationRecipients(db, starterId)).toEqual([
      { email: starter, locale: "nb" },
    ]);
  });

  it("falls back to every live admin when nobody started it", async () => {
    const recipients = await notificationRecipients(db, null);
    const emails = recipients.map((recipient) => recipient.email);
    expect(emails).toContain(starter);
    expect(emails).toContain(other);
    // A GDPR-erased account is not a mailbox.
    expect(emails).not.toContain(gone);
  });

  it("falls back to every live admin when the starter's account is gone", async () => {
    const emails = (await notificationRecipients(db, "no-such-user-id")).map(
      (recipient) => recipient.email,
    );
    expect(emails).toContain(starter);
    expect(emails).toContain(other);
  });

  it("reads a preferred locale that no longer parses as English", async () => {
    const id = await makeAdmin(`notify-junk-${RUN}@example.no`, "x");
    expect(await notificationRecipients(db, id)).toEqual([
      { email: `notify-junk-${RUN}@example.no`, locale: "en" },
    ]);
  });
});

d("notifyRunEvent (spec-19)", () => {
  it("mails the admin who started the run, in their own language, with a link to the language", async () => {
    clearCapturedMail();
    await notifyRunEvent(
      db,
      finishedRun({ startedById: userIds[0] }),
      NO_REPAIR,
    );

    expect(capturedMail()).toHaveLength(1);
    const mail = capturedMail()[0];
    expect(mail.to).toBe(starter);
    // The starter reads Norwegian, so the whole message does — subject included.
    expect(mail.subject).toBe("Oversettelsen av Notific er ferdig");
    expect(mail.text).toContain("9 enheter oversatt");
    // Every follow-up action lives on the language page, so the mail has to hand it over. `nb`
    // is served at its grandfathered /no prefix, which is the recipient's, not the run's.
    expect(mail.text).toContain(`/no/admin/languages/${CODE}`);
    expect(mail.html).toContain(`/no/admin/languages/${CODE}`);
  });

  it("falls back to every live admin when nobody started it", async () => {
    clearCapturedMail();
    await notifyRunEvent(db, finishedRun(), NO_REPAIR);

    const recipients = capturedMail().map((mail) => mail.to);
    expect(recipients).toContain(starter);
    expect(recipients).toContain(other);
    expect(recipients).not.toContain(gone);
    // English for the admin who reads English, Norwegian for the one who does not.
    expect(capturedMail().find((mail) => mail.to === other)?.subject).toBe(
      "Notific translation finished",
    );
  });

  it("reports a failed run with the worker's error, not a finished one", async () => {
    clearCapturedMail();
    await notifyRunEvent(
      db,
      finishedRun({
        startedById: userIds[1],
        status: "FAILED",
        error: "provider returned 503",
      }),
      NO_REPAIR,
    );

    expect(capturedMail()).toHaveLength(1);
    expect(capturedMail()[0].subject).toBe("Notific translation run failed");
    expect(capturedMail()[0].text).toContain("provider returned 503");
  });

  it("tells a reviewer when auto-repair has spent its three attempts", async () => {
    clearCapturedMail();
    await notifyRunEvent(
      db,
      finishedRun({ startedById: userIds[1], kind: "REPAIR" }),
      { action: "exhausted", remaining: 2 },
    );

    expect(capturedMail()).toHaveLength(1);
    expect(capturedMail()[0].subject).toBe(
      "Notific: 2 translations need a reviewer",
    );
    expect(capturedMail()[0].text).toContain("waiting in the review queue");
  });

  it("says a stalled repair fixed nothing, and counts what is still held", async () => {
    clearCapturedMail();
    await notifyRunEvent(
      db,
      finishedRun({ startedById: userIds[1], kind: "REPAIR", flaggedUnits: 7 }),
      { action: "stalled" },
    );

    expect(capturedMail()).toHaveLength(1);
    expect(capturedMail()[0].subject).toBe(
      "Notific: 7 translations need a reviewer",
    );
    // The distinction that matters: try again, rather than go and review seven rows by hand.
    expect(capturedMail()[0].text).toContain("could not fix anything");
  });

  it("stays quiet for a sample, and for a run that just chained a repair", async () => {
    clearCapturedMail();
    // Five units the admin is watching on screen — a mail about it is noise.
    await notifyRunEvent(
      db,
      finishedRun({ startedById: userIds[1], kind: "SAMPLE" }),
      NO_REPAIR,
    );
    // The repair IS this run continuing, and it will report when it finishes. Reporting here too
    // would mail twice about one outcome, once per link in the chain.
    await notifyRunEvent(db, finishedRun({ startedById: userIds[1] }), {
      action: "planned",
      runId: "chained",
      planned: 4,
    });

    expect(capturedMail()).toHaveLength(0);
  });

  it("says nothing about a run an admin paused or cancelled — they are watching the board", async () => {
    clearCapturedMail();
    for (const status of ["PAUSED", "CANCELLED"]) {
      await notifyRunEvent(
        db,
        finishedRun({ startedById: userIds[1], status }),
        NO_REPAIR,
      );
    }
    expect(capturedMail()).toHaveLength(0);
  });

  it("names the locale when the language row is gone, rather than sending nothing", async () => {
    clearCapturedMail();
    await notifyRunEvent(
      db,
      finishedRun({ startedById: userIds[1], locale: "zz-nolang" }),
      NO_REPAIR,
    );
    expect(capturedMail()).toHaveLength(1);
    expect(capturedMail()[0].subject).toContain("zz-nolang");
  });
});
