import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { notificationRecipients } from "./notify";

/**
 * Who hears about a run (spec-19).
 *
 * The interesting cases are both about absence: a run nobody started (the CLI, or a repair the
 * worker chained on its own) still has to reach a human, and a preferred locale that no longer
 * parses — the language it named was removed — must not silence the mail.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const starter = `notify-starter-${RUN}@example.no`;
const other = `notify-other-${RUN}@example.no`;
const gone = `notify-gone-${RUN}@example.no`;
const userIds: string[] = [];

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
});

afterAll(async () => {
  if (!enabled) return;
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
