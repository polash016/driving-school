import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { PrismaVariantSource } from "@/server/services/quiz/prisma-variant-source";
import {
  attachItemsToBatch,
  createBatch,
  detachItem,
  getBatch,
  listBatches,
} from "./batches";
import { csvToItems, exportItems, importItems, itemsToCsv } from "./io";
import { deleteItem, getItem, listItems, upsertItem } from "./items";
import { accuracyStats } from "./stats";
import { bulkAction, transitionItem } from "./transitions";

/**
 * Question bank against a real Postgres (spec-04). The cases that matter are the ones where the
 * bank meets the engine: publishing on approval, versioning, and set curation.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomUUID().slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `qb-${RUN}@example.no`,
};
/** Approval needs someone other than the author (spec-04b): nobody vouches for their own work. */
const reviewer: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `qb-rev-${RUN}@example.no`,
};
const reviewer2: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `qb-rev2-${RUN}@example.no`,
};

let topicId = "";
let topicSlug = "";

function content(stem: string, options = ["Yield", "Continue", "Stop"]) {
  return {
    en: {
      stem: `${stem} [${RUN}]`,
      options: options.map((text, index) => ({ key: "abc"[index], text })),
      explanation: `Because the rule says so [${RUN}].`,
    },
    nb: {
      stem: `${stem} (nb) [${RUN}]`,
      options: options.map((text, index) => ({
        key: "abc"[index],
        text: `${text} (nb)`,
      })),
      explanation: `Fordi regelen sier det [${RUN}].`,
    },
  };
}

/**
 * Review and approve, honouring the two-person rule: an AI-drafted question needs two distinct
 * approvers, a human-authored one needs a single approver who is not its author (spec-04b).
 */
async function approve(itemId: string, provenance: "AI" | "HUMAN" = "HUMAN") {
  await transitionItem(db, actor, { id: itemId, to: "IN_REVIEW" });
  if (provenance === "AI") {
    await transitionItem(db, reviewer, { id: itemId, to: "APPROVED" }).catch(
      () => undefined,
    );
    return transitionItem(db, reviewer2, { id: itemId, to: "APPROVED" });
  }
  return transitionItem(db, reviewer, { id: itemId, to: "APPROVED" });
}

function itemInput(stem: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "TEXT" as const,
    topicId,
    licenseClassId: null,
    difficulty: 3,
    content: content(stem),
    correctOptionKey: "a",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!enabled) return;
  for (const session of [actor, reviewer, reviewer2]) {
    const user = await db.user.create({
      data: {
        email: session.email,
        role: "ADMIN",
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "QB", lastName: RUN } },
      },
      select: { id: true },
    });
    session.id = user.id;
  }

  const topic = await db.topic.findFirstOrThrow({
    where: { parentId: null, deletedAt: null },
    select: { id: true, slug: true },
  });
  topicId = topic.id;
  topicSlug = topic.slug;
});

afterAll(async () => {
  if (!enabled) return;
  const items = await db.masterItem.findMany({
    where: { content: { path: ["en", "stem"], string_contains: RUN } },
    select: { id: true },
  });
  const ids = items.map((item) => item.id);
  await db.examAttemptQuestion.deleteMany({
    where: { variant: { masterItemId: { in: ids } } },
  });
  await db.itemVariant.deleteMany({ where: { masterItemId: { in: ids } } });
  await db.masterItem.deleteMany({ where: { id: { in: ids } } });
  await db.generationBatch.deleteMany({ where: { createdById: actor.id } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("publishing (D1: approval makes an item servable)", () => {
  it("creates a variant on approval that the engine can actually serve", async () => {
    const item = await upsertItem(
      db,
      actor,
      itemInput("Who has right of way here?"),
    );
    await transitionItem(db, actor, { id: item.id, to: "IN_REVIEW" });

    // Before approval the engine sees nothing.
    const source = new PrismaVariantSource(db);
    const before = await source.candidatesByTopic({ topicSlugs: [topicSlug] });
    expect(
      (before[topicSlug] ?? []).some((c) => c.masterItemId === item.id),
    ).toBe(false);

    const result = await transitionItem(db, reviewer, {
      id: item.id,
      to: "APPROVED",
    });
    expect(result.variantsCreated).toBe(1);

    const after = await source.candidatesByTopic({ topicSlugs: [topicSlug] });
    expect(
      (after[topicSlug] ?? []).some((c) => c.masterItemId === item.id),
    ).toBe(true);

    const variant = await db.itemVariant.findFirstOrThrow({
      where: { masterItemId: item.id },
      select: {
        correctOptionKey: true,
        isActive: true,
        masterVersion: true,
        source: true,
      },
    });
    expect(variant).toMatchObject({
      correctOptionKey: "a",
      isActive: true,
      masterVersion: 1,
      source: "TEMPLATE",
    });
  });

  it("is idempotent: re-approving reuses the variant instead of duplicating it", async () => {
    const item = await upsertItem(db, actor, itemInput("Idempotent publish"));
    await approve(item.id);
    await transitionItem(db, reviewer, {
      id: item.id,
      to: "RETIRED",
      reason: "DUPLICATE",
    });
    await transitionItem(db, actor, { id: item.id, to: "DRAFT" });
    await transitionItem(db, actor, { id: item.id, to: "IN_REVIEW" });
    const again = await transitionItem(db, reviewer, {
      id: item.id,
      to: "APPROVED",
    });

    expect(again.variantsCreated).toBe(1); // reused + reactivated, not a second row
    expect(
      await db.itemVariant.count({ where: { masterItemId: item.id } }),
    ).toBe(1);
  });

  it("stops serving a retired item without touching what was already served", async () => {
    const item = await upsertItem(db, actor, itemInput("Retire me"));
    await approve(item.id);

    await transitionItem(db, reviewer, {
      id: item.id,
      to: "RETIRED",
      reason: "AMBIGUOUS_DISTRACTOR",
    });

    const variants = await db.itemVariant.findMany({
      where: { masterItemId: item.id },
      select: { isActive: true },
    });
    expect(variants.every((v) => !v.isActive)).toBe(true);

    const stored = await db.masterItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { reviewReason: true, status: true },
    });
    expect(stored).toMatchObject({
      status: "RETIRED",
      reviewReason: "AMBIGUOUS_DISTRACTOR",
    });
  });

  it("refuses to approve an item whose answer key is not among its options", async () => {
    const item = await upsertItem(db, actor, itemInput("Bad key"));
    await transitionItem(db, actor, { id: item.id, to: "IN_REVIEW" });

    // Corrupt the key after the review gate, so approval is the check under test here (the
    // gate at IN_REVIEW catches the same thing earlier — see the quality-gate tests).
    await db.masterItem.update({
      where: { id: item.id },
      data: { correctOptionKey: "z" },
      select: { id: true },
    });

    await expect(
      transitionItem(db, reviewer, { id: item.id, to: "APPROVED" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await db.itemVariant.count({ where: { masterItemId: item.id } }),
    ).toBe(0);
  });
});

d("lifecycle enforcement", () => {
  it("rejects an illegal transition and a repeat of the current status", async () => {
    const item = await upsertItem(db, actor, itemInput("Illegal moves"));

    await expect(
      transitionItem(db, reviewer, { id: item.id, to: "APPROVED" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      transitionItem(db, actor, { id: item.id, to: "DRAFT" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires a reason to retire, and only the system may flag NEEDS_REVIEW", async () => {
    const item = await upsertItem(db, actor, itemInput("Reason required"));

    await expect(
      transitionItem(db, actor, { id: item.id, to: "RETIRED" }),
    ).rejects.toBeInstanceOf(ValidationError);

    await approve(item.id);
    await expect(
      transitionItem(db, reviewer, { id: item.id, to: "NEEDS_REVIEW" }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The same edge is allowed when spec-05's law-change watcher drives it.
    await expect(
      transitionItem(
        db,
        actor,
        { id: item.id, to: "NEEDS_REVIEW" },
        { systemInitiated: true },
      ),
    ).resolves.toMatchObject({ to: "NEEDS_REVIEW" });
  });
});

d("versioning and immutability", () => {
  it("versions a draft edit and voids approvals collected for the older text", async () => {
    const item = await upsertItem(db, actor, itemInput("Draft to edit"));
    const before = await getItem(db, item.id);
    expect(before.version).toBe(1);

    await upsertItem(db, actor, itemInput("Draft edited", { id: item.id }));
    const after = await getItem(db, item.id);
    expect(after.version).toBe(2);
    expect(
      await db.itemApproval.count({
        where: { masterItemId: item.id, itemVersion: 2 },
      }),
    ).toBe(0);
  });

  it("freezes an approved question and keeps a served attempt byte-identical", async () => {
    const item = await upsertItem(
      db,
      actor,
      itemInput("Frozen after approval"),
    );
    await approve(item.id);

    const variant = await db.itemVariant.findFirstOrThrow({
      where: { masterItemId: item.id },
      select: { id: true, content: true, correctOptionKey: true },
    });

    const student = await db.user.create({
      data: {
        email: `student-${RUN}@example.no`,
        profile: { create: { firstName: "S", lastName: RUN } },
      },
      select: { id: true },
    });
    const attempt = await db.examAttempt.create({
      data: {
        userId: student.id,
        mode: "PRACTICE",
        status: "IN_PROGRESS",
        seed: RUN,
        questionCountSnapshot: 1,
        startedAt: new Date(),
        questions: {
          create: {
            variantId: variant.id,
            position: 1,
            topicId,
            optionOrder: ["a", "b", "c"],
          },
        },
      },
      select: { id: true },
    });

    // Editing is refused outright (spec-04b): corrections go through retire-and-replace.
    await expect(
      upsertItem(db, actor, itemInput("Trying to edit", { id: item.id })),
    ).rejects.toMatchObject({
      messageKey: "admin.questions.errors.approvedIsFrozen",
    });

    const served = await db.examAttemptQuestion.findFirstOrThrow({
      where: { attemptId: attempt.id },
      select: {
        variant: { select: { content: true, correctOptionKey: true } },
      },
    });
    expect(served.variant.content).toEqual(variant.content);
    expect(served.variant.correctOptionKey).toBe(variant.correctOptionKey);

    await db.$executeRawUnsafe(
      'ALTER TABLE "ExamAttemptQuestion" DISABLE TRIGGER "attempt_question_immutable"',
    );
    await db.examAttemptQuestion.deleteMany({
      where: { attemptId: attempt.id },
    });
    await db.$executeRawUnsafe(
      'ALTER TABLE "ExamAttemptQuestion" ENABLE TRIGGER "attempt_question_immutable"',
    );
    await db.examAttempt.delete({ where: { id: attempt.id } });
    await db.user.delete({ where: { id: student.id } });
  });

  it("refuses to delete an item that has been served", async () => {
    const item = await upsertItem(db, actor, itemInput("Served item"));
    await approve(item.id);
    const variant = await db.itemVariant.findFirstOrThrow({
      where: { masterItemId: item.id },
      select: { id: true },
    });
    const student = await db.user.create({
      data: {
        email: `served-${RUN}@example.no`,
        profile: { create: { firstName: "S", lastName: RUN } },
      },
      select: { id: true },
    });
    const attempt = await db.examAttempt.create({
      data: {
        userId: student.id,
        mode: "PRACTICE",
        status: "IN_PROGRESS",
        seed: RUN,
        questionCountSnapshot: 1,
        startedAt: new Date(),
        questions: {
          create: {
            variantId: variant.id,
            position: 1,
            topicId,
            optionOrder: ["a"],
          },
        },
      },
      select: { id: true },
    });

    await expect(deleteItem(db, actor, item.id)).rejects.toBeInstanceOf(
      ConflictError,
    );

    await db.$executeRawUnsafe(
      'ALTER TABLE "ExamAttemptQuestion" DISABLE TRIGGER "attempt_question_immutable"',
    );
    await db.examAttemptQuestion.deleteMany({
      where: { attemptId: attempt.id },
    });
    await db.$executeRawUnsafe(
      'ALTER TABLE "ExamAttemptQuestion" ENABLE TRIGGER "attempt_question_immutable"',
    );
    await db.examAttempt.delete({ where: { id: attempt.id } });
    await db.user.delete({ where: { id: student.id } });
  });
});

d("sets", () => {
  it("scopes curation to one set and leaves its neighbour untouched", async () => {
    const [setA, setB] = await Promise.all([
      createBatch(db, actor, { kind: "MANUAL", topicId, notes: `A ${RUN}` }),
      createBatch(db, actor, { kind: "MANUAL", topicId, notes: `B ${RUN}` }),
    ]);
    const [one, two, three] = await Promise.all([
      upsertItem(db, actor, itemInput("Set item one")),
      upsertItem(db, actor, itemInput("Set item two")),
      upsertItem(db, actor, itemInput("Set item three")),
    ]);

    await attachItemsToBatch(db, actor, {
      batchId: setA.id,
      itemIds: [one.id, two.id],
    });
    await attachItemsToBatch(db, actor, {
      batchId: setB.id,
      itemIds: [three.id],
    });

    // A question belongs to the set it came from.
    await expect(
      attachItemsToBatch(db, actor, { batchId: setB.id, itemIds: [one.id] }),
    ).rejects.toBeInstanceOf(ConflictError);

    await approve(one.id);
    await transitionItem(db, actor, { id: two.id, to: "IN_REVIEW" });
    await transitionItem(db, reviewer, {
      id: two.id,
      to: "RETIRED",
      reason: "WRONG_ANSWER",
    });

    const detailA = await getBatch(db, setA.id);
    expect(detailA.counts).toMatchObject({ total: 2, approved: 1, retired: 1 });
    expect(detailA.acceptanceRate).toBe(0.5);
    expect(detailA.items.map((item) => item.id).sort()).toEqual(
      [one.id, two.id].sort(),
    );

    const detailB = await getBatch(db, setB.id);
    expect(detailB.counts).toMatchObject({ total: 1, draft: 1 });
    expect(detailB.acceptanceRate).toBeNull();

    await detachItem(db, actor, { itemId: three.id });
    expect((await getBatch(db, setB.id)).counts.total).toBe(0);

    const board = await listBatches(db, { page: 1, pageSize: 50 });
    expect(board.items.some((batch) => batch.id === setA.id)).toBe(true);
  });
});

d("accuracy stats", () => {
  it("computes acceptance per model from AI items only", async () => {
    const made: string[] = [];
    // model-x: 2 approved, 1 retired → 2/3. model-y: 0 approved, 1 retired → 0/1.
    const plan = [
      { model: "model-x", to: "APPROVED" as const },
      { model: "model-x", to: "APPROVED" as const },
      { model: "model-x", to: "RETIRED" as const },
      { model: "model-y", to: "RETIRED" as const },
    ];
    for (const [index, row] of plan.entries()) {
      const item = await upsertItem(
        db,
        actor,
        itemInput(`Stats item ${index}`),
      );
      await db.masterItem.update({
        where: { id: item.id },
        data: {
          createdBy: "AI",
          modelVersion: row.model,
          promptVersion: "p@1.0.0",
        },
        select: { id: true },
      });
      if (row.to === "APPROVED") {
        await approve(item.id, "AI");
      } else {
        await transitionItem(db, actor, { id: item.id, to: "IN_REVIEW" });
        await transitionItem(db, reviewer, {
          id: item.id,
          to: "RETIRED",
          reason: "WRONG_ANSWER",
        });
      }
      made.push(item.id);
    }
    // A human item with the same shape must not appear in the AI numbers.
    const human = await upsertItem(db, actor, itemInput("Human authored"));
    await approve(human.id);

    const stats = await accuracyStats(db, { groupBy: "model", sinceDays: 1 });
    const x = stats.rows.find((row) => row.key === "model-x");
    const y = stats.rows.find((row) => row.key === "model-y");

    expect(x).toMatchObject({ reviewed: 3, approved: 2 });
    expect(x!.rate).toBeCloseTo(2 / 3, 5);
    expect(y).toMatchObject({ reviewed: 1, approved: 0, rate: 0 });
    expect(stats.rows.some((row) => row.key === "unknown")).toBe(false);
    expect(
      stats.reasons.find((r) => r.reason === "WRONG_ANSWER")!.count,
    ).toBeGreaterThanOrEqual(2);
  });
});

d("bulk actions and search", () => {
  it("walks drafts through review, and reports each item's outcome", async () => {
    // Selecting a pile of drafts and pressing approve is the normal way to work through a
    // generated set, so bulk approve takes DRAFT → IN_REVIEW → APPROVED per item.
    const draft = await upsertItem(db, actor, itemInput("Bulk draft"));
    const ready = await upsertItem(db, actor, itemInput("Bulk ready"));
    await transitionItem(db, actor, { id: ready.id, to: "IN_REVIEW" });

    // This one cannot pass the quality gate — no legal citation.
    const broken = await upsertItem(
      db,
      actor,
      itemInput("Bulk broken", { legalCitations: [] }),
    );

    const outcomes = await bulkAction(db, reviewer, {
      ids: [draft.id, ready.id, broken.id],
      action: "APPROVE",
    });

    expect(outcomes.find((row) => row.itemId === draft.id)?.outcome).toBe(
      "approved",
    );
    expect(outcomes.find((row) => row.itemId === ready.id)?.outcome).toBe(
      "approved",
    );
    expect(outcomes.find((row) => row.itemId === broken.id)).toMatchObject({
      outcome: "failed",
      messageKey: "admin.quality.citationMissing",
    });

    expect((await getItem(db, draft.id)).status).toBe("APPROVED");
    expect((await getItem(db, broken.id)).status).toBe("DRAFT");
  });

  it("records but does not publish when one reviewer bulk-approves AI questions", async () => {
    const first = await upsertItem(db, actor, itemInput("Bulk ai one"));
    const second = await upsertItem(db, actor, itemInput("Bulk ai two"));
    for (const item of [first, second]) {
      await db.masterItem.update({
        where: { id: item.id },
        data: { createdBy: "AI", modelVersion: "m-bulk" },
        select: { id: true },
      });
    }

    const firstPass = await bulkAction(db, reviewer, {
      ids: [first.id, second.id],
      action: "APPROVE",
    });
    expect(firstPass.every((row) => row.outcome === "awaitingApproval")).toBe(
      true,
    );
    expect((await getItem(db, first.id)).status).toBe("IN_REVIEW");

    // A second reviewer bulk-approving the same set is what publishes them.
    const secondPass = await bulkAction(db, reviewer2, {
      ids: [first.id, second.id],
      action: "APPROVE",
    });
    expect(secondPass.every((row) => row.outcome === "approved")).toBe(true);
    expect((await getItem(db, second.id)).status).toBe("APPROVED");
  });

  it("finds items through the generated tsvector index", async () => {
    await upsertItem(db, actor, itemInput("Roundabout yielding rules"));
    const found = await listItems(db, { search: "Roundabout", pageSize: 20 });
    expect(
      found.items.some((item) => item.stemPreview.includes("Roundabout")),
    ).toBe(true);

    const missing = await listItems(db, {
      search: "zzzzunlikelyzzz",
      pageSize: 20,
    });
    expect(missing.items).toHaveLength(0);
    expect(missing.totalCount).toBe(0);
  });
});

d("import / export", () => {
  it("round-trips through CSV without losing a locale or a citation", async () => {
    const item = await upsertItem(db, actor, itemInput("Round trip me"));
    const exported = await exportItems(db, {});
    const mine = exported.filter((row) => row.content.en.stem.includes(RUN));
    expect(mine.length).toBeGreaterThan(0);

    const parsed = csvToItems(itemsToCsv(mine));
    expect(parsed).toEqual(mine);

    // …and importing that CSV creates drafts, never approved content.
    const before = await db.masterItem.count();
    const result = await importItems(db, actor, {
      format: "csv",
      payload: itemsToCsv([
        {
          ...mine[0],
          content: {
            ...mine[0].content,
            en: { ...mine[0].content.en, stem: `Imported ${RUN}` },
          },
        },
      ]),
    });
    expect(result.imported).toBe(1);
    expect(await db.masterItem.count()).toBe(before + 1);
    const imported = await db.masterItem.findFirstOrThrow({
      where: { content: { path: ["en", "stem"], equals: `Imported ${RUN}` } },
      select: { status: true, createdBy: true },
    });
    expect(imported).toMatchObject({ status: "DRAFT", createdBy: "HUMAN" });
    expect(item.id).toBeTruthy();
  });

  it("reports unknown topics per row instead of failing the whole file", async () => {
    const result = await importItems(db, actor, {
      format: "json",
      payload: JSON.stringify([
        {
          topicSlug: "no-such-topic",
          type: "TEXT",
          status: "DRAFT",
          difficulty: 3,
          licenseClassCode: null,
          correctOptionKey: "a",
          content: content(`Bad topic ${RUN}`),
          legalCitations: [],
        },
      ]),
    });
    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(result.rows[0].messageKey).toBe("admin.questions.rows.unknownTopic");
  });
});

d("bulk approve idempotency", () => {
  it("treats an already-approved item as done rather than failed", async () => {
    const item = await upsertItem(
      db,
      actor,
      itemInput("Already approved bulk"),
    );
    await approve(item.id);

    // A second reviewer sweeping the same list should not see a wall of failures.
    const outcomes = await bulkAction(db, reviewer2, {
      ids: [item.id],
      action: "APPROVE",
    });
    expect(outcomes[0]).toMatchObject({ outcome: "approved" });
  });
});
