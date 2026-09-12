import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { ForbiddenError } from "@/lib/errors";
import { extractAll } from "./extract";
import { repairCandidates } from "./repair";
import { loadQuestionOverlay } from "./resolve";
import {
  bulkApproveInputSchema,
  bulkApproveTranslations,
  flagCounts,
  flagTranslation,
} from "./review";
import type { TranslationUnit } from "./units";

/**
 * Bulk approve, scoped to the flags a reviewer consented to (spec-19).
 *
 * `QA_UNAVAILABLE` means the semantic check could not run — no embedding route at the time — which
 * is not a statement about the translation, and in production it was holding 405 rows of one
 * language behind a one-at-a-time workflow. `NUMBER_DRIFT` on a speed limit is the opposite: it is
 * exactly what the checks exist to catch.
 *
 * So the thing that has to hold against a real database is the partition. Consent is per flag
 * CODE, but approval is decided per ROW over ALL of its flags: a unit flagged both
 * `QA_UNAVAILABLE` and `NUMBER_DRIFT` must survive a reviewer consenting to the first.
 *
 * And staleness, which only became reachable when a sweep could touch a flagged row: the resolver
 * serves on status alone, so an approved row whose English has moved is served to students against
 * text it was never translated from. Every fixture here is therefore built from a REAL extracted
 * unit and its real hash — a fixture with an invented hash would be stale, and would pass this
 * file by never being approved at all.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomBytes(3).toString("hex");
const CODE = `zr-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "INSTRUCTOR",
  email: `review-${RUN}@example.no`,
};

/** The rows the whole partition is argued over, by the flags they carry. */
const rowIds: {
  clean: string;
  infra: string;
  mixed: string;
  quality: string;
  stale: string;
  master?: string;
} = { clean: "", infra: "", mixed: "", quality: "", stale: "" };

/** Every current unit, with the hash a fresh translation would carry. */
let units: TranslationUnit[] = [];

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "INSTRUCTOR",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Review", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;

  await db.language.create({
    data: {
      code: CODE,
      englishName: "Review Language",
      nativeName: "Prøvespråk",
      shortLabel: "ZR",
      urlPrefix: `/${CODE}`,
    },
  });

  // Real units and their real hashes. UI messages, because there are hundreds of them and they do
  // not depend on how much question content happens to be seeded.
  const language = await db.language.findUniqueOrThrow({
    where: { code: CODE },
    select: { glossaryVersion: true },
  });
  units = await extractAll(db, { glossaryVersion: language.glossaryVersion });
  const messages = units.filter((unit) => unit.entity === "UI_MESSAGE");
  expect(messages.length).toBeGreaterThan(5);

  const make = async (
    unit: TranslationUnit,
    status: "MACHINE" | "NEEDS_REVIEW",
    qaFlags: string[],
    sourceHash: string = unit.sourceHash,
  ) =>
    (
      await db.translation.create({
        data: {
          locale: CODE,
          entity: unit.entity,
          entityId: unit.entityId,
          value: { text: `Row ${qaFlags.join("+") || "clean"}` },
          status,
          sourceHash,
          qaFlags,
        },
        select: { id: true },
      })
    ).id;

  rowIds.clean = await make(messages[0], "MACHINE", []);
  rowIds.infra = await make(messages[1], "NEEDS_REVIEW", ["QA_UNAVAILABLE"]);
  rowIds.mixed = await make(messages[2], "NEEDS_REVIEW", [
    "QA_UNAVAILABLE",
    "NUMBER_DRIFT",
  ]);
  rowIds.quality = await make(messages[3], "NEEDS_REVIEW", ["NUMBER_DRIFT"]);
  // Translated from English that has since moved on. Fully consented to, and still not approvable.
  rowIds.stale = await make(
    messages[4],
    "NEEDS_REVIEW",
    ["QA_UNAVAILABLE"],
    "stale",
  );
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

async function statusOf(id: string): Promise<string> {
  const row = await db.translation.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  return row.status;
}

d("what a check is currently holding back", () => {
  it("counts each code and says whether it is a statement about the translation", async () => {
    const counts = await flagCounts(db, CODE);
    // Worst first. QA_UNAVAILABLE holds three rows, one of which is stale and one of which also
    // carries a NUMBER_DRIFT — which is exactly why the screen says "held by this check" rather
    // than promising that ticking it releases three.
    expect(counts).toEqual([
      { code: "QA_UNAVAILABLE", count: 3, quality: false },
      { code: "NUMBER_DRIFT", count: 2, quality: true },
    ]);
  });
});

d("bulk approve with nothing consented to", () => {
  it("approves only the rows no check flagged — exactly as before", async () => {
    expect(
      await bulkApproveTranslations(db, actor, {
        locale: CODE,
        allowFlags: [],
      }),
    ).toEqual({ approved: 1, skipped: 4 });

    expect(await statusOf(rowIds.clean)).toBe("APPROVED");
    expect(await statusOf(rowIds.infra)).toBe("NEEDS_REVIEW");
    expect(await statusOf(rowIds.mixed)).toBe("NEEDS_REVIEW");
    expect(await statusOf(rowIds.quality)).toBe("NEEDS_REVIEW");
  });

  it("means the same thing when the caller says nothing at all", async () => {
    // The default is the safe end: an existing caller that never heard of allowFlags keeps the
    // behaviour it was written against.
    expect(await bulkApproveTranslations(db, actor, { locale: CODE })).toEqual({
      approved: 0,
      skipped: 4,
    });
  });
});

d("bulk approve scoped to a flag", () => {
  it("clears the code consented to and leaves every row carrying anything else", async () => {
    expect(
      await bulkApproveTranslations(db, actor, {
        locale: CODE,
        allowFlags: ["QA_UNAVAILABLE"],
      }),
    ).toEqual({ approved: 1, skipped: 3 });

    expect(await statusOf(rowIds.infra)).toBe("APPROVED");
    // The row that matters: consenting to "the check could not run" must not carry a changed
    // number through on the same row.
    expect(await statusOf(rowIds.mixed)).toBe("NEEDS_REVIEW");
    expect(await statusOf(rowIds.quality)).toBe("NEEDS_REVIEW");

    const approved = await db.translation.findUniqueOrThrow({
      where: { id: rowIds.infra },
      select: { reviewedById: true, reviewedAt: true, qaFlags: true },
    });
    // Approved by a person, on the record — and the flag is not erased, because the reviewer
    // consented to it rather than disproving it.
    expect(approved.reviewedById).toBe(actor.id);
    expect(approved.reviewedAt).not.toBeNull();
    expect(approved.qaFlags).toEqual(["QA_UNAVAILABLE"]);
  });

  it("records what was consented to, not only how many moved", async () => {
    const entry = await db.auditLog.findFirst({
      where: { actorId: actor.id, entityType: "Language", entityId: CODE },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    expect(entry?.meta).toMatchObject({
      bulk: true,
      allowFlags: ["QA_UNAVAILABLE"],
    });
  });
});

d("a row whose English has moved on", () => {
  it("is never approved, however completely its flags were consented to", async () => {
    // The reviewer ticked the only code this row carries, so nothing about the consent rule is
    // holding it back — the source hash is.
    expect(
      await bulkApproveTranslations(db, actor, {
        locale: CODE,
        allowFlags: ["QA_UNAVAILABLE", "NUMBER_DRIFT"],
      }),
    ).toEqual({ approved: 2, skipped: 1 });

    expect(await statusOf(rowIds.mixed)).toBe("APPROVED");
    expect(await statusOf(rowIds.quality)).toBe("APPROVED");
    // Coverage already treats it as untranslated, but the resolver serves on status alone: an
    // APPROVED stale row would be shown to a student against English it was not translated from.
    expect(await statusOf(rowIds.stale)).toBe("NEEDS_REVIEW");

    const row = await db.translation.findUniqueOrThrow({
      where: { id: rowIds.stale },
      select: { reviewedById: true, reviewedAt: true, sourceHash: true },
    });
    expect(row).toMatchObject({
      reviewedById: null,
      reviewedAt: null,
      sourceHash: "stale",
    });
  });
});

d("a flagged question that gets approved", () => {
  it("still reaches the variants students are actually served", async () => {
    const masterUnits = units.filter((unit) => unit.entity === "MASTER_ITEM");
    expect(masterUnits.length).toBeGreaterThan(0);
    const master = await db.masterItem.findFirstOrThrow({
      where: {
        id: { in: masterUnits.map((unit) => unit.entityId) },
        variants: { some: { isActive: true } },
      },
      select: {
        id: true,
        version: true,
        variants: {
          where: { isActive: true },
          select: { id: true, masterVersion: true, source: true },
        },
      },
    });
    const variant = master.variants.find(
      (candidate) => candidate.masterVersion === master.version,
    );
    expect(variant).toBeDefined();
    const masterUnit = masterUnits.find((unit) => unit.entityId === master.id)!;

    rowIds.master = (
      await db.translation.create({
        data: {
          locale: CODE,
          entity: "MASTER_ITEM",
          entityId: master.id,
          value: { stem: "Spørsmål", options: [], explanation: "" },
          status: "NEEDS_REVIEW",
          sourceHash: masterUnit.sourceHash,
          qaFlags: ["QA_UNAVAILABLE"],
        },
        select: { id: true },
      })
    ).id;

    expect(
      await bulkApproveTranslations(db, actor, {
        locale: CODE,
        allowFlags: ["QA_UNAVAILABLE"],
      }),
    ).toEqual({ approved: 1, skipped: 1 });

    // Serving is the point (spec-20): the approved master translation is what the student's
    // variant reads, straight from the master row — there is no copy in between to forget.
    const overlay = await loadQuestionOverlay(db, CODE, [
      {
        variantId: variant!.id,
        masterItemId: master.id,
        masterVersion: variant!.masterVersion,
        source: variant!.source,
        currentMasterVersion: master.version,
      },
    ]);
    expect(overlay.get(variant!.id)).toEqual({
      stem: "Spørsmål",
      options: [],
      explanation: "",
    });
    expect(
      await db.translation.findUnique({
        where: {
          locale_entity_entityId: {
            locale: CODE,
            entity: "ITEM_VARIANT",
            entityId: variant!.id,
          },
        },
        select: { id: true },
      }),
    ).toBeNull();

    // A served variant is not a review unit of its own, so nothing new is left to approve.
    expect(
      await bulkApproveTranslations(db, actor, {
        locale: CODE,
        allowFlags: [],
      }),
    ).toEqual({ approved: 0, skipped: 1 });
  });
});

/**
 * Spec-21: an admin can declare any translation broken — approved or not — and hand it to the
 * repair run with a note the model will read. Production shipped Bengali in Latin letters that
 * every check had passed; a human eye has to be able to overrule the checks.
 */
d("marking a translation broken (spec-21)", () => {
  const admin: SessionUser = {
    id: "",
    role: "ADMIN",
    email: `review-admin-${RUN}@example.no`,
  };

  beforeAll(async () => {
    const user = await db.user.create({
      data: {
        email: admin.email,
        role: "ADMIN",
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Admin", lastName: RUN } },
      },
      select: { id: true },
    });
    admin.id = user.id;
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { actorId: admin.id } });
    await db.user.deleteMany({ where: { id: admin.id } });
  });

  it("only an admin may mark a translation broken", async () => {
    await expect(
      flagTranslation(db, actor, {
        id: rowIds.clean,
        note: "Romanised Bengali, not Bengali script",
        repair: false,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await statusOf(rowIds.clean)).toBe("APPROVED");
  });

  it("takes an approved row out of service, keeps the note for the model, and resets the repair budget", async () => {
    await db.translation.update({
      where: { id: rowIds.clean },
      data: { repairAttempts: 3 },
    });
    const outcome = await flagTranslation(db, admin, {
      id: rowIds.clean,
      note: "Romanised Bengali, not Bengali script",
      repair: false,
    });
    expect(outcome).toMatchObject({
      id: rowIds.clean,
      locale: CODE,
      repairQueued: false,
    });

    const row = await db.translation.findUniqueOrThrow({
      where: { id: rowIds.clean },
      select: {
        status: true,
        qaFlags: true,
        qaReport: true,
        reviewNote: true,
        reviewedById: true,
        repairAttempts: true,
      },
    });
    expect(row.status).toBe("NEEDS_REVIEW");
    expect(row.qaFlags).toContain("ADMIN_FLAGGED");
    expect(row.reviewNote).toBe("Romanised Bengali, not Bengali script");
    expect(row.reviewedById).toBe(admin.id);
    expect(row.repairAttempts).toBe(0);
    // The note rides in the report as a problem detail: `storeRepairs` nulls `reviewNote`, but
    // `repairProblems` reads `qaReport.issues`, which is what reaches the prompt.
    const report = row.qaReport as {
      source?: string;
      issues?: Array<{ code: string; detail?: string }>;
    };
    expect(report.source).toBe("admin");
    expect(report.issues).toContainEqual({
      code: "ADMIN_FLAGGED",
      blocking: true,
      detail: "Romanised Bengali, not Bengali script",
    });

    // It is now a repair candidate.
    const messages = units.filter((unit) => unit.entity === "UI_MESSAGE");
    const candidates = await repairCandidates(db, CODE);
    expect(
      candidates.map((unit) => `${unit.entity}:${unit.entityId}`),
    ).toContain(`UI_MESSAGE:${messages[0].entityId}`);
  });

  it("queues a repair run in the same act when asked", async () => {
    const outcome = await flagTranslation(db, admin, {
      id: rowIds.infra,
      note: "Wrong script",
    });
    expect(outcome.repairQueued).toBe(true);
    const run = await db.translationRun.findFirst({
      where: { locale: CODE, kind: "REPAIR" },
      orderBy: { createdAt: "desc" },
      select: { enqueuedAt: true, plannedUnits: true, status: true },
    });
    expect(run?.enqueuedAt).not.toBeNull();
    expect(run?.plannedUnits ?? 0).toBeGreaterThan(0);
  });
});

/**
 * The contract, stated where a future caller will hit it: consent is a list of codes, it is
 * bounded, and it defaults to the empty list — the safe end.
 */
describe("the bulk approve contract", () => {
  it("defaults to consenting to nothing", () => {
    expect(bulkApproveInputSchema.parse({ locale: "es" })).toEqual({
      locale: "es",
      allowFlags: [],
    });
  });

  it("has no way to say 'approve everything regardless'", () => {
    // The old boolean escape hatch is gone rather than renamed: `.strict()` refuses it, so a form
    // or a well-meaning caller cannot reopen it.
    expect(() =>
      bulkApproveInputSchema.parse({ locale: "es", includeFlagged: true }),
    ).toThrow();
    const refused = bulkApproveInputSchema.safeParse({
      locale: "es",
      allowFlags: Array.from({ length: 33 }, (_, index) => `CODE_${index}`),
    });
    expect(refused.success).toBe(false);
  });
});
