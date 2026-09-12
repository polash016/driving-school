import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { keys, redis } from "@/server/redis";
import { auditTranslations } from "./audit";
import { extractAll } from "./extract";
import { payloadStrings, type TranslationUnit } from "./units";

/**
 * Re-checking what is already stored (spec-21).
 *
 * The gate only ever ran on the way in. Production held 23 approved Bangla questions in Latin
 * letters because, at the time, the gate did not know Bengali; making the gate stricter helps
 * nothing already stored unless something runs it again. The audit does, reports before it
 * touches anything, and hands what it flags to the repair run.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomBytes(3).toString("hex");
// A Bengali-script locale, so SCRIPT_MISMATCH is reachable; a region subtag keeps it unique.
const CODE = `bn-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `audit-${RUN}@example.no`,
};

const ids = {
  bengali: "",
  banglishApproved: "",
  banglishMachine: "",
  stale: "",
};
let units: TranslationUnit[] = [];

/**
 * Message units with nothing the gate would compare beyond the text itself: no numbers,
 * placeholders or § to drift, and short enough that the length check stays quiet.
 */
function plainMessages(all: TranslationUnit[]): TranslationUnit[] {
  return all.filter((unit) => {
    const text = payloadStrings(unit.en).join(" ");
    return (
      unit.entity === "UI_MESSAGE" &&
      !/[{}\d§]/.test(text) &&
      text.replace(/[^\p{L}]/gu, "").length >= 8 &&
      text.length <= 60
    );
  });
}

async function make(
  unit: TranslationUnit,
  status: "APPROVED" | "MACHINE",
  text: string,
  sourceHash = unit.sourceHash,
) {
  return (
    await db.translation.create({
      data: {
        locale: CODE,
        entity: unit.entity,
        entityId: unit.entityId,
        value: { text },
        status,
        sourceHash,
        qaFlags: [],
        repairAttempts: 2,
        reviewedById: actor.id,
        reviewedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Audit", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
  await db.language.create({
    data: {
      code: CODE,
      englishName: "Bengali test",
      nativeName: "বাংলা",
      shortLabel: "BN",
      urlPrefix: `/${CODE}`,
      requiresApproval: false,
      autoTranslate: false,
    },
  });
  const language = await db.language.findUniqueOrThrow({
    where: { code: CODE },
    select: { glossaryVersion: true },
  });
  units = plainMessages(
    await extractAll(db, { glossaryVersion: language.glossaryVersion }),
  );
  expect(units.length).toBeGreaterThan(4);

  ids.bengali = await make(
    units[0],
    "APPROVED",
    "তত্ত্ব পরীক্ষার জন্য প্রস্তুত?",
  );
  ids.banglishApproved = await make(
    units[1],
    "APPROVED",
    "Theory test er jonno prostut?",
  );
  ids.banglishMachine = await make(units[2], "MACHINE", "Shuru korun ekhon");
  // Translated from text that has since moved: the sync's job, never the audit's.
  ids.stale = await make(units[3], "APPROVED", "Purono lekha", "stale");
});

afterAll(async () => {
  if (!enabled) return;
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

async function statusOf(id: string) {
  return await db.translation.findUniqueOrThrow({
    where: { id },
    select: { status: true, qaFlags: true, repairAttempts: true },
  });
}

d("re-checking stored translations (spec-21)", () => {
  it("reports what the current gate refuses without touching a row", async () => {
    const report = await auditTranslations(db, actor, CODE, {});
    expect(report.applied).toBe(false);
    expect(report.checked).toBe(3); // the stale row is not the audit's to judge
    expect(report.flagged).toBe(2);
    expect(report.byCode).toEqual({ SCRIPT_MISMATCH: 2 });
    expect(report.examples.map((example) => example.entityId).sort()).toEqual(
      [units[1].entityId, units[2].entityId].sort(),
    );
    expect((await statusOf(ids.banglishApproved)).status).toBe("APPROVED");
    expect((await statusOf(ids.banglishMachine)).status).toBe("MACHINE");
  });

  it("on apply, flags them for repair with a fresh budget and leaves the good row alone", async () => {
    await redis.set(keys.i18nMessages(CODE), JSON.stringify({ stale: true }));
    const report = await auditTranslations(db, actor, CODE, { apply: true });
    expect(report.applied).toBe(true);
    expect(report.flagged).toBe(2);

    for (const id of [ids.banglishApproved, ids.banglishMachine]) {
      const row = await statusOf(id);
      expect(row.status).toBe("NEEDS_REVIEW");
      expect(row.qaFlags).toEqual(["SCRIPT_MISMATCH"]);
      expect(row.repairAttempts).toBe(0);
    }
    expect((await statusOf(ids.bengali)).status).toBe("APPROVED");
    expect((await statusOf(ids.stale)).status).toBe("APPROVED");
    // A flagged interface string must stop serving at once.
    expect(await redis.get(keys.i18nMessages(CODE))).toBeNull();
    // Running it again finds the same rows already held and flags nothing new.
    const again = await auditTranslations(db, actor, CODE, { apply: true });
    expect(again.flagged).toBe(0);
  });

  it("does not raise a finding a reviewer already consented to, but does raise a new one beside it", async () => {
    // A row bulk-approved with NUMBER_DRIFT ticked keeps the flag on it — that consent is recorded
    // on the row itself. Re-check must not drag it back for the same finding.
    const language = await db.language.findUniqueOrThrow({
      where: { code: CODE },
      select: { glossaryVersion: true },
    });
    const numbered = (
      await extractAll(db, { glossaryVersion: language.glossaryVersion })
    ).filter(
      (unit) =>
        unit.entity === "UI_MESSAGE" &&
        /\d/.test(payloadStrings(unit.en).join(" ")) &&
        !/[{}§]/.test(payloadStrings(unit.en).join(" ")),
    );
    expect(numbered.length).toBeGreaterThan(1);
    const consented = await db.translation.create({
      data: {
        locale: CODE,
        entity: "UI_MESSAGE",
        entityId: numbered[0].entityId,
        value: { text: "সংখ্যা ছাড়া বাংলা লেখা" }, // Bengali, but the number is gone
        status: "APPROVED",
        sourceHash: numbered[0].sourceHash,
        qaFlags: ["NUMBER_DRIFT"],
      },
      select: { id: true },
    });
    const consentedButRomanised = await db.translation.create({
      data: {
        locale: CODE,
        entity: "UI_MESSAGE",
        entityId: numbered[1].entityId,
        value: { text: "Shongkha chhara Banglish lekha" },
        status: "APPROVED",
        sourceHash: numbered[1].sourceHash,
        qaFlags: ["NUMBER_DRIFT"],
      },
      select: { id: true },
    });

    const report = await auditTranslations(db, actor, CODE, { apply: true });
    expect(report.flagged).toBe(1);
    expect(report.byCode).toEqual({ SCRIPT_MISMATCH: 1, NUMBER_DRIFT: 1 });
    expect((await statusOf(consented.id)).status).toBe("APPROVED");
    const raised = await statusOf(consentedButRomanised.id);
    expect(raised.status).toBe("NEEDS_REVIEW");
    expect(raised.qaFlags.sort()).toEqual(["NUMBER_DRIFT", "SCRIPT_MISMATCH"]);
  });

  it("queues one repair run for what it flagged when asked", async () => {
    const report = await auditTranslations(db, actor, CODE, {
      apply: true,
      repair: true,
    });
    expect(report.repairRunId).not.toBeNull();
    const run = await db.translationRun.findUniqueOrThrow({
      where: { id: report.repairRunId! },
      select: { kind: true, enqueuedAt: true, plannedUnits: true },
    });
    expect(run.kind).toBe("REPAIR");
    expect(run.enqueuedAt).not.toBeNull();
    // The two Banglish rows plus the consented-but-romanised one raised above.
    expect(run.plannedUnits).toBe(3);
  });
});
