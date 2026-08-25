import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { replaceItem, upsertItem } from "@/server/services/question-bank/items";
import { transitionItem } from "@/server/services/question-bank/transitions";
import { hashAttestation, verifyAttempt } from "./attestation";
import { listAttemptHistory } from "./history";

/**
 * Spec-04b: the guarantees behind a mark that gates a student's progress toward a licence.
 *
 * These assert the things that must hold even when application code is wrong — the database
 * itself refuses to edit a served question, change a submitted result, or delete an exam.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomUUID().slice(0, 8);
const author: SessionUser = { id: "", role: "INSTRUCTOR", email: `author-${RUN}@example.no` };
const reviewer: SessionUser = { id: "", role: "INSTRUCTOR", email: `rev1-${RUN}@example.no` };
const reviewer2: SessionUser = { id: "", role: "ADMIN", email: `rev2-${RUN}@example.no` };
let topicId = "";
let studentId = "";

function itemInput(stem: string, overrides: Record<string, unknown> = {}) {
  const options = [
    { key: "a", text: `Yield ${stem}` },
    { key: "b", text: `Continue ${stem}` },
    { key: "c", text: `Stop ${stem}` },
  ];
  return {
    type: "TEXT" as const,
    topicId,
    licenseClassId: null,
    difficulty: 3,
    content: {
      en: { stem: `${stem} [${RUN}]`, options, explanation: "The rule says so." },
      nb: {
        stem: `${stem} (nb) [${RUN}]`,
        options: options.map((option) => ({ ...option, text: `${option.text} nb` })),
        explanation: "Regelen sier det.",
      },
    },
    correctOptionKey: "a",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
    ...overrides,
  };
}

async function user(session: SessionUser, role: "INSTRUCTOR" | "ADMIN" | "STUDENT") {
  const row = await db.user.create({
    data: {
      email: session.email,
      role,
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "T", lastName: RUN } },
    },
    select: { id: true },
  });
  session.id = row.id;
  return row.id;
}

/**
 * An approved, published question plus a submitted attempt that used it. Each call uses a fresh
 * stem — the duplicate gate is a feature, and reusing one here would (correctly) be refused.
 */
let examCounter = 0;
async function sitAnExam() {
  const item = await upsertItem(db, author, itemInput(`Exam question ${examCounter++}`));
  await db.masterItem.update({
    where: { id: item.id },
    data: { createdBy: "HUMAN" },
    select: { id: true },
  });
  await transitionItem(db, author, { id: item.id, to: "IN_REVIEW" });
  await transitionItem(db, reviewer, { id: item.id, to: "APPROVED" });

  const variant = await db.itemVariant.findFirstOrThrow({
    where: { masterItemId: item.id, isActive: true },
    select: { id: true },
  });
  const attempt = await db.examAttempt.create({
    data: {
      userId: studentId,
      mode: "EXAM",
      status: "IN_PROGRESS",
      seed: RUN,
      questionCountSnapshot: 1,
      passMarkSnapshot: 1,
      startedAt: new Date(),
      questions: {
        create: {
          variantId: variant.id,
          position: 1,
          topicId,
          optionOrder: ["a", "b", "c"],
          answeredOptionKey: "a",
        },
      },
    },
    select: { id: true },
  });
  return { itemId: item.id, variantId: variant.id, attemptId: attempt.id };
}

/** Closes an attempt the way the engine does: questions first, then the attempt, then attest. */
async function closeAttempt(attemptId: string, correct: number, passed: boolean) {
  const { attestAttempt } = await import("./attestation");
  await db.$transaction(async (tx) => {
    await tx.examAttemptQuestion.updateMany({
      where: { attemptId },
      data: { isCorrect: correct > 0 },
    });
    await tx.examAttempt.update({
      where: { id: attemptId },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
        correctCount: correct,
        passed,
        topicBreakdown: [],
      },
    });
    await attestAttempt(tx, attemptId);
  });
}

beforeAll(async () => {
  if (!enabled) return;
  await Promise.all([
    user(author, "INSTRUCTOR"),
    user(reviewer, "INSTRUCTOR"),
    user(reviewer2, "ADMIN"),
  ]);
  studentId = await user(
    { id: "", role: "STUDENT", email: `student-${RUN}@example.no` },
    "STUDENT",
  );
  const topic = await db.topic.findFirstOrThrow({
    where: { parentId: null, deletedAt: null },
    select: { id: true },
  });
  topicId = topic.id;
});

afterAll(async () => {
  if (!enabled) return;
  const items = await db.masterItem.findMany({
    where: { content: { path: ["en", "stem"], string_contains: RUN } },
    select: { id: true },
  });
  const ids = items.map((item) => item.id);
  const attempts = await db.examAttempt.findMany({
    where: { seed: RUN },
    select: { id: true },
  });
  // The trigger refuses to delete a submitted attempt — that is the guarantee under test, so
  // cleanup lifts it explicitly rather than pretending the rule does not exist.
  await db.$executeRawUnsafe('ALTER TABLE "ExamAttempt" DISABLE TRIGGER "attempt_result_final"');
  await db.$executeRawUnsafe(
    'ALTER TABLE "ExamAttemptQuestion" DISABLE TRIGGER "attempt_question_immutable"',
  );
  await db.examAttemptQuestion.deleteMany({
    where: { attemptId: { in: attempts.map((a) => a.id) } },
  });
  await db.examAttempt.deleteMany({ where: { id: { in: attempts.map((a) => a.id) } } });
  await db.$executeRawUnsafe('ALTER TABLE "ExamAttempt" ENABLE TRIGGER "attempt_result_final"');
  await db.$executeRawUnsafe(
    'ALTER TABLE "ExamAttemptQuestion" ENABLE TRIGGER "attempt_question_immutable"',
  );
  await db.itemApproval.deleteMany({ where: { masterItemId: { in: ids } } });
  await db.itemVariant.deleteMany({ where: { masterItemId: { in: ids } } });
  await db.masterItem.deleteMany({ where: { id: { in: ids } } });
  const users = await db.user.findMany({
    where: { email: { contains: RUN } },
    select: { id: true },
  });
  await db.auditLog.deleteMany({ where: { actorId: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("two-person sign-off", () => {
  it("refuses to let an author approve their own question", async () => {
    const item = await upsertItem(db, author, itemInput("Self approval"));
    await transitionItem(db, author, { id: item.id, to: "IN_REVIEW" });

    await expect(
      transitionItem(db, author, { id: item.id, to: "APPROVED" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await db.masterItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      "IN_REVIEW",
    );
  });

  it("requires two different reviewers for an AI-drafted question", async () => {
    const item = await upsertItem(db, author, itemInput("AI drafted"));
    await db.masterItem.update({
      where: { id: item.id },
      data: { createdBy: "AI", modelVersion: "m1", promptVersion: "p@1" },
      select: { id: true },
    });
    await transitionItem(db, author, { id: item.id, to: "IN_REVIEW" });

    // First reviewer: their approval is recorded — a success for them — but nothing goes live.
    const first = await transitionItem(db, reviewer, { id: item.id, to: "APPROVED" });
    expect(first).toMatchObject({
      applied: false,
      approvals: { recorded: 1, required: 2 },
    });
    expect((await db.masterItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      "IN_REVIEW",
    );

    // The same reviewer clicking again is not a second pair of eyes.
    const repeat = await transitionItem(db, reviewer, { id: item.id, to: "APPROVED" });
    expect(repeat.applied).toBe(false);
    expect(await db.itemApproval.count({ where: { masterItemId: item.id } })).toBe(1);

    // A different reviewer completes it.
    await transitionItem(db, reviewer2, { id: item.id, to: "APPROVED" });
    const approved = await db.masterItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { status: true, variants: { where: { isActive: true }, select: { id: true } } },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.variants).toHaveLength(1);
  });

  it("voids collected approvals when the draft text changes", async () => {
    const item = await upsertItem(db, author, itemInput("Version void"));
    await db.masterItem.update({
      where: { id: item.id },
      data: { createdBy: "AI" },
      select: { id: true },
    });
    await transitionItem(db, author, { id: item.id, to: "IN_REVIEW" });
    expect(
      (await transitionItem(db, reviewer, { id: item.id, to: "APPROVED" })).applied,
    ).toBe(false);

    // Author edits: the approval was for text that no longer exists.
    await transitionItem(db, author, { id: item.id, to: "DRAFT" });
    await upsertItem(db, author, itemInput("Version void edited", { id: item.id }));
    await transitionItem(db, author, { id: item.id, to: "IN_REVIEW" });

    const version = (await db.masterItem.findUniqueOrThrow({ where: { id: item.id } })).version;
    expect(
      await db.itemApproval.count({ where: { masterItemId: item.id, itemVersion: version } }),
    ).toBe(0);
  });
});

d("quality gate at the lifecycle boundary", () => {
  it("refuses to send a question without a legal reference to review", async () => {
    const item = await upsertItem(db, author, itemInput("No citation", { legalCitations: [] }));
    await expect(
      transitionItem(db, author, { id: item.id, to: "IN_REVIEW" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a duplicate of a question already in the pool", async () => {
    const first = await upsertItem(db, author, itemInput("Duplicate me"));
    await transitionItem(db, author, { id: first.id, to: "IN_REVIEW" });

    const second = await upsertItem(db, author, itemInput("Duplicate me"));
    await expect(
      transitionItem(db, author, { id: second.id, to: "IN_REVIEW" }),
    ).rejects.toMatchObject({ messageKey: "admin.quality.duplicateItem" });
  });
});

d("approved questions are frozen", () => {
  it("refuses an edit, in the service and in the database", async () => {
    const { itemId } = await sitAnExam();

    await expect(
      upsertItem(db, author, itemInput("Trying to edit", { id: itemId })),
    ).rejects.toMatchObject({ messageKey: "admin.questions.errors.approvedIsFrozen" });

    // Even reaching past the service: the database refuses too.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "MasterItem" SET "correctOptionKey" = 'b' WHERE "id" = '${itemId}'`,
      ),
    ).rejects.toThrow(/frozen/i);
  });

  it("corrects a question by retiring it and creating a linked replacement", async () => {
    const item = await upsertItem(db, author, itemInput("Needs correcting"));
    await transitionItem(db, author, { id: item.id, to: "IN_REVIEW" });
    await transitionItem(db, reviewer, { id: item.id, to: "APPROVED" });

    const replacement = await replaceItem(
      db,
      reviewer,
      item.id,
      itemInput("Corrected version", { correctOptionKey: "b" }),
      "WRONG_ANSWER",
    );

    const [original, fixed] = await Promise.all([
      db.masterItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { status: true, reviewReason: true, correctOptionKey: true },
      }),
      db.masterItem.findUniqueOrThrow({
        where: { id: replacement.id },
        select: { status: true, replacesId: true, correctOptionKey: true },
      }),
    ]);

    expect(original).toMatchObject({
      status: "RETIRED",
      reviewReason: "WRONG_ANSWER",
      correctOptionKey: "a", // untouched: the question that was asked stays as it was asked
    });
    expect(fixed).toMatchObject({
      status: "DRAFT",
      replacesId: item.id,
      correctOptionKey: "b",
    });
  });
});

d("a served question and a submitted result cannot be altered", () => {
  it("refuses to change a published variant's text or answer", async () => {
    const { variantId } = await sitAnExam();

    await expect(
      db.$executeRawUnsafe(
        `UPDATE "ItemVariant" SET "correctOptionKey" = 'c' WHERE "id" = '${variantId}'`,
      ),
    ).rejects.toThrow(/immutable/i);

    // Retiring is still allowed — that is a serving decision, not a rewrite of history.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "ItemVariant" SET "isActive" = false WHERE "id" = '${variantId}'`,
      ),
    ).resolves.toBeGreaterThan(0);
  });

  it("seals the result at submission and refuses any later change or deletion", async () => {
    const { attemptId } = await sitAnExam();
    await closeAttempt(attemptId, 1, true);

    const sealed = await db.examAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { resultHash: true, attestedAt: true },
    });
    expect(sealed.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.attestedAt).not.toBeNull();

    await expect(
      db.$executeRawUnsafe(
        `UPDATE "ExamAttempt" SET "correctCount" = 45, "passed" = true WHERE "id" = '${attemptId}'`,
      ),
    ).rejects.toThrow(/final/i);

    await expect(
      db.$executeRawUnsafe(
        `UPDATE "ExamAttemptQuestion" SET "answeredOptionKey" = 'b' WHERE "attemptId" = '${attemptId}'`,
      ),
    ).rejects.toThrow(/closed/i);

    await expect(
      db.$executeRawUnsafe(`DELETE FROM "ExamAttempt" WHERE "id" = '${attemptId}'`),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it("verifies a sealed result by recomputing both the digest and the grade", async () => {
    const { attemptId } = await sitAnExam();
    await closeAttempt(attemptId, 1, true);

    const verification = await verifyAttempt(db, attemptId);
    expect(verification).toMatchObject({
      hashMatches: true,
      gradeReproduces: true,
      intact: true,
      storedCorrectCount: 1,
      recomputedCorrectCount: 1,
    });
  });

  it("detects tampering that bypasses the triggers", async () => {
    const { attemptId } = await sitAnExam();
    await closeAttempt(attemptId, 0, false);

    // Simulate someone with database access disabling the guard and rewriting the answer.
    await db.$executeRawUnsafe(
      'ALTER TABLE "ExamAttemptQuestion" DISABLE TRIGGER "attempt_question_immutable"',
    );
    await db.$executeRawUnsafe(
      `UPDATE "ExamAttemptQuestion" SET "isCorrect" = true WHERE "attemptId" = '${attemptId}'`,
    );
    await db.$executeRawUnsafe(
      'ALTER TABLE "ExamAttemptQuestion" ENABLE TRIGGER "attempt_question_immutable"',
    );

    const verification = await verifyAttempt(db, attemptId);
    expect(verification.hashMatches).toBe(false); // the seal no longer matches the record
    expect(verification.intact).toBe(false);
  });

  it("produces a stable digest for the same record", () => {
    const record = {
      version: "v1",
      attemptId: "a1",
      userId: "u1",
      mode: "EXAM",
      seed: "s",
      passMark: 38,
      questionCount: 1,
      submittedAt: "2026-08-25T10:00:00.000Z",
      correctCount: 1,
      passed: true,
      questions: [
        {
          position: 1,
          variantId: "v1",
          contentHash: "h",
          optionOrder: ["a", "b"],
          answered: "a",
          correct: true,
        },
      ],
    };
    expect(hashAttestation(record)).toBe(hashAttestation({ ...record }));
    expect(hashAttestation(record)).not.toBe(
      hashAttestation({ ...record, correctCount: 0, passed: false }),
    );
  });
});

d("student record", () => {
  it("lists the student's own attempts, newest first, with the seal flagged", async () => {
    const { attemptId } = await sitAnExam();
    await closeAttempt(attemptId, 1, true);

    const student: SessionUser = {
      id: studentId,
      role: "STUDENT",
      email: `student-${RUN}@example.no`,
    };
    const history = await listAttemptHistory(db, student, studentId, { page: 1, pageSize: 10 });

    expect(history.items.length).toBeGreaterThan(0);
    expect(history.items[0]).toMatchObject({ attested: true });
    expect(history.items.every((attempt) => attempt.id !== undefined)).toBe(true);
  });

  it("refuses to show one student another student's record", async () => {
    const intruder: SessionUser = { id: "someone-else", role: "STUDENT", email: "x@example.no" };
    await expect(
      listAttemptHistory(db, intruder, studentId, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
