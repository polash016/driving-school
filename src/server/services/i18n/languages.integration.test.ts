import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { createLanguage, languageCoverage, updateLanguage } from "./languages";
import { MAX_REPAIR_ATTEMPTS } from "./repair";
import {
  bulkApproveInputSchema,
  bulkApproveTranslations,
  reviewTranslation,
} from "./review";

/**
 * The rules that must hold against a real database (spec-15): a runtime language is always served
 * at `/<code>`, and a language reaches students only when it is finished.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomBytes(3).toString("hex");
const CODE = `zx-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `lang-${RUN}@example.no`,
};

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Lang", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
});

afterAll(async () => {
  if (!enabled) return;
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("adding a language", () => {
  it("always serves it at /<code>, whatever anyone would prefer", async () => {
    const language = await createLanguage(db, actor, {
      code: CODE,
      englishName: "Test Language",
      nativeName: "Prøvespråk",
      shortLabel: "zx",
      direction: "RTL",
      requiresApproval: true,
    });
    expect(language.code).toBe(CODE);

    const row = await db.language.findUniqueOrThrow({
      where: { code: CODE },
      select: {
        urlPrefix: true,
        shortLabel: true,
        studentVisible: true,
        direction: true,
      },
    });
    // The prefix map is compiled into the client bundle, so a custom prefix would make <Link>
    // and the proxy disagree — a redirect loop rather than an error message.
    expect(row.urlPrefix).toBe(`/${CODE}`);
    expect(row.shortLabel).toBe("ZX");
    expect(row.direction).toBe("RTL");
    // A brand-new language has nothing translated, so it starts hidden.
    expect(row.studentVisible).toBe(false);
  });

  it("refuses a language that already exists", async () => {
    await expect(
      createLanguage(db, actor, {
        code: CODE,
        englishName: "Again",
        nativeName: "Igjen",
        shortLabel: "ZY",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to re-add a built-in language", async () => {
    await expect(
      createLanguage(db, actor, {
        code: "nb",
        englishName: "Norwegian",
        nativeName: "Norsk",
        shortLabel: "NO",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a code that is not a language tag", async () => {
    await expect(
      createLanguage(db, actor, {
        code: "../admin",
        englishName: "Bad",
        nativeName: "Bad",
        shortLabel: "XX",
      }),
    ).rejects.toThrow();
  });
});

d("the coverage gate", () => {
  it("reports how much a student would actually read in their language", async () => {
    const coverage = await languageCoverage(db, CODE);
    expect(coverage.ready).toBe(0);
    expect(coverage.percent).toBe(0);
    expect(coverage.complete).toBe(false);
    expect(
      coverage.byEntity.some((entry) => entry.entity === "UI_MESSAGE"),
    ).toBe(true);
  });

  it("counts only what a student can actually see", async () => {
    // Admin and instructor screens stay English/Norwegian by design. Leaving them in the
    // denominator would mean no language could ever reach the coverage a school needs to switch
    // it on, and would spend most of a translation budget on screens nobody in that language
    // will ever open.
    const { extractMessages } = await import("./extract");
    const keys = extractMessages(1).map((unit) => unit.entityId);
    expect(keys.length).toBeGreaterThan(200);
    expect(keys.some((key) => key.startsWith("admin."))).toBe(false);
    expect(keys).toContain("quiz.answerLocked");
    expect(keys).toContain("home.title");
  });

  it("refuses to show an unfinished language to students", async () => {
    await expect(
      updateLanguage(db, actor, { code: CODE, studentVisible: true }),
    ).rejects.toBeInstanceOf(ValidationError);

    const row = await db.language.findUniqueOrThrow({
      where: { code: CODE },
      select: { studentVisible: true },
    });
    expect(row.studentVisible).toBe(false);
  });

  it("counts a translation only while it still matches its source", async () => {
    const topic = await db.topic.findFirstOrThrow({
      where: { deletedAt: null },
      select: { id: true },
    });

    // A translation stamped with a hash that does not match the current source is stale, and
    // stale is not coverage — otherwise editing a question would silently un-translate it while
    // the dashboard kept claiming 100%.
    const stale = await db.translation.create({
      data: {
        locale: CODE,
        entity: "TOPIC",
        entityId: topic.id,
        value: { name: "Stale" },
        status: "APPROVED",
        sourceHash: "definitely-not-the-current-hash",
      },
      select: { id: true },
    });
    expect((await languageCoverage(db, CODE)).ready).toBe(0);

    await db.translation.delete({ where: { id: stale.id } });
  });

  it("counts machine output only when the language does not require approval", async () => {
    const topic = await db.topic.findFirstOrThrow({
      where: { deletedAt: null },
      select: { id: true },
    });
    // Borrow the real hash the extractor would compute, so the row is genuinely fresh.
    const { extractAll } = await import("./extract");
    const language = await db.language.findUniqueOrThrow({
      where: { code: CODE },
      select: { glossaryVersion: true },
    });
    const units = await extractAll(db, {
      glossaryVersion: language.glossaryVersion,
    });
    const unit = units.find((candidate) => candidate.entityId === topic.id);
    expect(unit).toBeDefined();

    const row = await db.translation.create({
      data: {
        locale: CODE,
        entity: "TOPIC",
        entityId: topic.id,
        value: { name: "Máquina" },
        status: "MACHINE",
        sourceHash: unit!.sourceHash,
      },
      select: { id: true },
    });

    // Approval required: nobody vouched for it, so it does not count and is not served.
    expect((await languageCoverage(db, CODE)).ready).toBe(0);

    await updateLanguage(db, actor, { code: CODE, requiresApproval: false });
    expect((await languageCoverage(db, CODE)).ready).toBe(1);

    // Approving it makes it count under either policy.
    await updateLanguage(db, actor, { code: CODE, requiresApproval: true });
    await reviewTranslation(db, actor, { id: row.id, action: "APPROVE" });
    expect((await languageCoverage(db, CODE)).ready).toBe(1);

    await db.translation.delete({ where: { id: row.id } });
  });

  it("never counts something a check flagged or a reviewer refused", async () => {
    const topic = await db.topic.findFirstOrThrow({
      where: { deletedAt: null },
      select: { id: true },
    });
    const { extractAll } = await import("./extract");
    const language = await db.language.findUniqueOrThrow({
      where: { code: CODE },
      select: { glossaryVersion: true },
    });
    const units = await extractAll(db, {
      glossaryVersion: language.glossaryVersion,
    });
    const unit = units.find((candidate) => candidate.entityId === topic.id)!;

    const row = await db.translation.create({
      data: {
        locale: CODE,
        entity: "TOPIC",
        entityId: topic.id,
        value: { name: "Marcado" },
        status: "NEEDS_REVIEW",
        sourceHash: unit.sourceHash,
        qaFlags: ["NUMBER_DRIFT"],
      },
      select: { id: true },
    });

    await updateLanguage(db, actor, { code: CODE, requiresApproval: false });
    const coverage = await languageCoverage(db, CODE);
    expect(coverage.ready).toBe(0);
    expect(coverage.flagged).toBe(1);

    await updateLanguage(db, actor, { code: CODE, requiresApproval: true });
    await db.translation.delete({ where: { id: row.id } });
  });
});

/**
 * The invariant the whole of spec-19 is built to protect.
 *
 * Auto-repair exists to clear the flagged pile by making the machine fix its own mistakes — never
 * by lowering the bar. So the one thing that must NOT have moved while phase 2 was built is this:
 * bulk approve still refuses anything a check flagged, including a unit the machine has already
 * spent its whole repair budget on. A row at the ceiling is the strongest possible temptation to
 * wave through, and it is exactly the row a human has to read.
 */
d("bulk approve after auto-repair", () => {
  it("still refuses a flagged unit, even one the machine has given up on", async () => {
    const topics = await db.topic.findMany({
      where: { deletedAt: null },
      take: 2,
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(topics.length).toBe(2);

    const clean = await db.translation.create({
      data: {
        locale: CODE,
        entity: "TOPIC",
        entityId: topics[0].id,
        value: { name: "Limpio" },
        status: "MACHINE",
        sourceHash: "clean-hash",
        qaFlags: [],
      },
      select: { id: true },
    });
    // Three repair attempts spent and still wrong: the machine is out of road, and this is where
    // a reviewer takes over — not where the bar drops.
    const flagged = await db.translation.create({
      data: {
        locale: CODE,
        entity: "TOPIC",
        entityId: topics[1].id,
        value: { name: "Marcado" },
        status: "NEEDS_REVIEW",
        sourceHash: "flagged-hash",
        qaFlags: ["NUMBER_DRIFT"],
        repairAttempts: MAX_REPAIR_ATTEMPTS,
      },
      select: { id: true },
    });

    expect(await bulkApproveTranslations(db, actor, { locale: CODE })).toEqual({
      approved: 1,
      skipped: 1,
    });

    const after = await db.translation.findMany({
      where: { id: { in: [clean.id, flagged.id] } },
      select: {
        id: true,
        status: true,
        qaFlags: true,
        repairAttempts: true,
        reviewedById: true,
        reviewedAt: true,
      },
    });
    const byId = new Map(after.map((row) => [row.id, row]));

    expect(byId.get(clean.id)).toMatchObject({
      status: "APPROVED",
      reviewedById: actor.id,
    });
    // Untouched in every respect — not the status, not the flag, not the attempt count, and no
    // reviewer stamped onto it.
    expect(byId.get(flagged.id)).toMatchObject({
      status: "NEEDS_REVIEW",
      qaFlags: ["NUMBER_DRIFT"],
      repairAttempts: MAX_REPAIR_ATTEMPTS,
      reviewedById: null,
      reviewedAt: null,
    });

    await db.translation.deleteMany({
      where: { id: { in: [clean.id, flagged.id] } },
    });
  });
});

/**
 * And there is no way to ask for the other behaviour: `includeFlagged` is `z.literal(false)`, so
 * the escape hatch cannot be opened from a form, a fetch, or a future caller who means well.
 */
describe("the bulk approve contract", () => {
  it("has no opt-out from refusing flagged units", () => {
    expect(() =>
      bulkApproveInputSchema.parse({ locale: "es", includeFlagged: true }),
    ).toThrow();
    // And it is refused *because of* includeFlagged, not incidentally by some other rule.
    const refused = bulkApproveInputSchema.safeParse({
      locale: "es",
      includeFlagged: true,
    });
    expect(refused.success).toBe(false);
    expect(
      refused.error?.issues.map((issue) => issue.path.join(".")),
    ).toContain("includeFlagged");
    expect(bulkApproveInputSchema.parse({ locale: "es" })).toEqual({
      locale: "es",
      includeFlagged: false,
    });
  });
});
