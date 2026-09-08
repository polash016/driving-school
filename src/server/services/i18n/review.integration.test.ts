import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import {
  bulkApproveInputSchema,
  bulkApproveTranslations,
  flagCounts,
} from "./review";

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

/** The four rows the whole partition is argued over, by the flags they carry. */
const rowIds: {
  clean: string;
  infra: string;
  mixed: string;
  quality: string;
  master?: string;
  variant?: string;
} = { clean: "", infra: "", mixed: "", quality: "" };

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

  // Synthetic entity ids: nothing here reads the source side, and a fixture that does not depend
  // on how many topics happen to be seeded is one that cannot fail for the wrong reason.
  const make = async (
    entityId: string,
    status: "MACHINE" | "NEEDS_REVIEW",
    qaFlags: string[],
  ) =>
    (
      await db.translation.create({
        data: {
          locale: CODE,
          entity: "TOPIC",
          entityId,
          value: { name: `Row ${qaFlags.join("+") || "clean"}` },
          status,
          sourceHash: `hash-${entityId}`,
          qaFlags,
        },
        select: { id: true },
      })
    ).id;

  rowIds.clean = await make(`topic-${RUN}-clean`, "MACHINE", []);
  rowIds.infra = await make(`topic-${RUN}-infra`, "NEEDS_REVIEW", [
    "QA_UNAVAILABLE",
  ]);
  rowIds.mixed = await make(`topic-${RUN}-mixed`, "NEEDS_REVIEW", [
    "QA_UNAVAILABLE",
    "NUMBER_DRIFT",
  ]);
  rowIds.quality = await make(`topic-${RUN}-quality`, "NEEDS_REVIEW", [
    "NUMBER_DRIFT",
  ]);
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
    // Sorted worst-first, so the two-row codes lead and the tie is broken by name.
    expect(counts).toEqual([
      { code: "NUMBER_DRIFT", count: 2, quality: true },
      { code: "QA_UNAVAILABLE", count: 2, quality: false },
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
    ).toEqual({ approved: 1, skipped: 3 });

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
      skipped: 3,
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
    ).toEqual({ approved: 1, skipped: 2 });

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

d("a flagged question that gets approved", () => {
  it("still reaches the variants students are actually served", async () => {
    const master = await db.masterItem.findFirstOrThrow({
      where: { variants: { some: { isActive: true } } },
      select: {
        id: true,
        version: true,
        variants: {
          where: { isActive: true },
          select: { id: true, masterVersion: true },
        },
      },
    });
    const variant = master.variants.find(
      (candidate) => candidate.masterVersion === master.version,
    );
    expect(variant).toBeDefined();

    rowIds.master = (
      await db.translation.create({
        data: {
          locale: CODE,
          entity: "MASTER_ITEM",
          entityId: master.id,
          value: { stem: "Spørsmål", options: [], explanation: "" },
          status: "NEEDS_REVIEW",
          sourceHash: `hash-${master.id}`,
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
    ).toEqual({ approved: 1, skipped: 2 });

    // The derivation is the point: an approved question that never reaches its variants is not
    // served to anybody, so bulk approve has to do it too.
    const derived = await db.translation.findUniqueOrThrow({
      where: {
        locale_entity_entityId: {
          locale: CODE,
          entity: "ITEM_VARIANT",
          entityId: variant!.id,
        },
      },
      select: { id: true, status: true },
    });
    rowIds.variant = derived.id;
    expect(derived.status).toBe("APPROVED");

    // And the derived variant is never itself a bulk-approve candidate — it has no source of its
    // own to review, so counting it would double every number on the screen.
    expect(
      await bulkApproveTranslations(db, actor, {
        locale: CODE,
        allowFlags: [],
      }),
    ).toEqual({ approved: 0, skipped: 2 });
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
