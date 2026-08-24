import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExamStateError, NotFoundError } from "@/lib/errors";
import { createAttemptService, type AttemptService } from "./attempt-service";
import { InMemorySeenStore } from "./ports";
import { PrismaVariantSource } from "./prisma-variant-source";
import type { Clock } from "./timer";

/**
 * Engine integration tests against a real Postgres (teoripro_test).
 * Run: docker compose -f docker-compose.dev.yml up -d && TEST_DATABASE_URL set in .env.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

const db = url ? new PrismaClient({ datasourceUrl: url }) : (null as never);

class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceSec(sec: number) {
    this.current = new Date(this.current.getTime() + sec * 1000);
  }
}

const T0 = new Date("2026-08-24T10:00:00Z");
let clock: FakeClock;
let seenStore: InMemorySeenStore;
let service: AttemptService;
const gradedCalls: string[] = [];

const explanation = {
  en: "You must yield here.",
  nb: "Du har vikeplikt her.",
  citations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
};

function variantContent(master: string, v: number) {
  return {
    en: {
      stem: `Question ${master} (variant ${v}): what applies?`,
      options: [
        { key: "a", text: `Yield ${master}-${v}` },
        { key: "b", text: `Continue ${master}-${v}` },
        { key: "c", text: `Stop ${master}-${v}` },
      ],
    },
    nb: {
      stem: `Spørsmål ${master} (variant ${v}): hva gjelder?`,
      options: [
        { key: "a", text: `Vik ${master}-${v}` },
        { key: "b", text: `Fortsett ${master}-${v}` },
        { key: "c", text: `Stopp ${master}-${v}` },
      ],
    },
  };
}

async function seedFixtures() {
  await db.$executeRawUnsafe(`
    TRUNCATE "ExamAttemptQuestion","ExamAttempt","ItemVariant","MasterItemCitation",
      "MasterItem","ExamBlueprint","LicenseClass","Topic","Profile","User" CASCADE
  `);

  await db.user.createMany({
    data: ["u1", "u2", "u3", "u4"].map((id) => ({
      id,
      email: `${id}@test.local`,
      role: "STUDENT",
    })),
  });

  const r1 = await db.topic.create({
    data: { slug: "r1", name: { en: "Right of way", nb: "Vikeplikt" } },
  });
  const c1 = await db.topic.create({
    data: {
      slug: "c1",
      parentId: r1.id,
      name: { en: "Right-hand rule", nb: "Høyreregelen" },
    },
  });
  const r2 = await db.topic.create({
    data: { slug: "r2", name: { en: "Speed", nb: "Fart" } },
  });

  const tb = await db.licenseClass.create({
    data: {
      code: "TB",
      name: { en: "Test class", nb: "Testklasse" },
      questionCount: 6,
      timeLimitMin: 90,
      passMark: 4,
    },
  });
  await db.examBlueprint.create({
    data: {
      licenseClassId: tb.id,
      topicDistribution: { r1: 3, r2: 3 },
      imageRatio: 0,
      isDefault: true,
    },
  });

  // r1 items live on the CHILD topic (verifies subtree gathering); r2 items direct.
  for (const [root, topicId] of [
    ["r1", c1.id],
    ["r2", r2.id],
  ] as const) {
    for (let m = 0; m < 10; m++) {
      const masterId = `${root}-m${m}`;
      await db.masterItem.create({
        data: {
          id: masterId,
          type: "TEXT",
          status: "APPROVED",
          topicId,
          difficulty: 3,
          content: variantContent(masterId, 0),
          legalCitations: [],
          createdBy: "HUMAN",
        },
      });
      await db.itemVariant.createMany({
        data: [0, 1].map((v) => ({
          id: `${masterId}-v${v}`,
          masterItemId: masterId,
          masterVersion: 1,
          contentHash: `hash-${masterId}-v${v}`,
          content: variantContent(masterId, v),
          correctOptionKey: "a",
          explanation,
          source: "TEMPLATE",
        })),
      });
    }
  }
}

function freshService() {
  clock = new FakeClock(T0);
  seenStore = new InMemorySeenStore();
  service = createAttemptService({
    db,
    variantSource: new PrismaVariantSource(db),
    seenStore,
    clock,
    onGraded: async (userId) => {
      gradedCalls.push(userId);
    },
  });
}

beforeAll(async () => {
  if (!url) return;
  await seedFixtures();
  freshService();
});

afterAll(async () => {
  if (url) await db.$disconnect();
});

d("attempt lifecycle (integration)", () => {
  it("EXAM start: snapshots class config, fills blueprint, leaks nothing", async () => {
    const attempt = await service.startQuiz("u1", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });

    expect(attempt.questionCount).toBe(6);
    expect(attempt.questions).toHaveLength(6);
    expect(attempt.timeRemainingSec).toBe(90 * 60);
    expect(attempt.currentPosition).toBe(1);
    expect(attempt.questions.filter((q) => q.topicSlug === "r1")).toHaveLength(3);

    const json = JSON.stringify(attempt);
    expect(json).not.toContain("correctOptionKey");
    expect(json).not.toContain("isCorrect");
    expect(json).not.toContain("explanation");

    const row = await db.examAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: {
        questionCountSnapshot: true,
        passMarkSnapshot: true,
        timeLimitSecSnapshot: true,
        expiresAt: true,
      },
    });
    expect(row.questionCountSnapshot).toBe(6);
    expect(row.passMarkSnapshot).toBe(4);
    expect(row.timeLimitSecSnapshot).toBe(5400);
    expect(row.expiresAt).toEqual(new Date(T0.getTime() + (5400 + 30) * 1000));
  });

  it("two users at the same second receive different exams", async () => {
    const a = await service.startQuiz("u1", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    const b = await service.startQuiz("u2", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    const sig = (x: typeof a) =>
      x.questions.map((q) => `${q.stem}|${q.options.map((o) => o.key).join("")}`);
    expect(sig(a)).not.toEqual(sig(b));
  });

  it("seen-window: a user's next exam repeats no contentHash", async () => {
    const first = await service.startQuiz("u3", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    const second = await service.startQuiz("u3", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    const stems = (x: typeof first) => new Set(x.questions.map((q) => q.stem));
    const overlap = [...stems(first)].filter((s) => stems(second).has(s));
    expect(overlap).toEqual([]); // distinct variants → distinct stems in fixtures
  });

  it("answer autosave: EXAM ack reveals nothing; resume restores state cross-device", async () => {
    freshService();
    const attempt = await service.startQuiz("u4", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    const q1 = attempt.questions[0];

    const ack = await service.answer("u4", {
      attemptId: attempt.id,
      position: 1,
      optionKey: q1.options[1].key,
      locale: "en",
    });
    expect(ack).toEqual({ position: 1, saved: true });

    // idempotent re-send
    const ack2 = await service.answer("u4", {
      attemptId: attempt.id,
      position: 1,
      optionKey: q1.options[1].key,
      locale: "en",
    });
    expect(ack2).toEqual({ position: 1, saved: true });

    clock.advanceSec(60);
    // "second device": fresh serve
    const resumed = await service.serveAttempt("u4", { attemptId: attempt.id, locale: "en" });
    expect(resumed.questions[0].answeredOptionKey).toBe(q1.options[1].key);
    expect(resumed.currentPosition).toBe(2);
    expect(resumed.timeRemainingSec).toBe(5400 - 60);
    expect(resumed.questions.map((q) => q.stem)).toEqual(attempt.questions.map((q) => q.stem));
    expect(JSON.stringify(resumed)).not.toContain("correctOptionKey");
  });

  it("submit grades server-side against the snapshot pass mark; resubmit is idempotent", async () => {
    freshService();
    gradedCalls.length = 0;
    const attempt = await service.startQuiz("u1", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });

    // 4 correct ('a' is always correct in fixtures), 2 wrong
    for (const q of attempt.questions) {
      await service.answer("u1", {
        attemptId: attempt.id,
        position: q.position,
        optionKey: q.position <= 4 ? "a" : q.options.find((o) => o.key !== "a")!.key,
        locale: "en",
      });
    }

    const result = await service.submit("u1", { attemptId: attempt.id, locale: "en" });
    expect(result.correctCount).toBe(4);
    expect(result.passMark).toBe(4);
    expect(result.passed).toBe(true);
    expect(result.review).toHaveLength(6);
    expect(result.review.filter((r) => r.correct)).toHaveLength(4);
    expect(result.topicBreakdown.reduce((s, t) => s + t.total, 0)).toBe(6);
    expect(result.review[0].explanation.citations[0].sourceCode).toBe("trafikkreglene");
    expect(gradedCalls).toEqual(["u1"]);

    const again = await service.submit("u1", { attemptId: attempt.id, locale: "en" });
    expect(again).toEqual(result);
    expect(gradedCalls).toEqual(["u1"]); // no double grading

    // post-submit answering is rejected
    await expect(
      service.answer("u1", { attemptId: attempt.id, position: 1, optionKey: "a", locale: "en" }),
    ).rejects.toBeInstanceOf(ExamStateError);
  });

  it("PRACTICE: instant per-question server grading with localized explanation", async () => {
    freshService();
    const attempt = await service.startQuiz("u2", {
      mode: "PRACTICE",
      topicSlugs: ["r1"],
      questionCount: 3,
      locale: "nb",
    });
    expect(attempt.questions.length).toBeGreaterThan(0);
    const wrongKey = attempt.questions[0].options.find((o) => o.key !== "a")!.key;
    const result = await service.answer("u2", {
      attemptId: attempt.id,
      position: 1,
      optionKey: wrongKey,
      locale: "nb",
    });
    expect(result).toMatchObject({
      position: 1,
      correct: false,
      correctOptionKey: "a",
      explanation: { text: "Du har vikeplikt her." },
    });
  });

  it("expiry: interactions after the deadline auto-submit with EXPIRED status", async () => {
    freshService();
    const attempt = await service.startQuiz("u4", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    await service.answer("u4", { attemptId: attempt.id, position: 1, optionKey: "a", locale: "en" });
    await service.answer("u4", { attemptId: attempt.id, position: 2, optionKey: "a", locale: "en" });

    clock.advanceSec(90 * 60 + 31); // past limit + grace

    await expect(
      service.answer("u4", { attemptId: attempt.id, position: 3, optionKey: "a", locale: "en" }),
    ).rejects.toBeInstanceOf(ExamStateError);

    const row = await db.examAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { status: true, correctCount: true, passed: true },
    });
    expect(row.status).toBe("EXPIRED");
    expect(row.correctCount).toBe(2);
    expect(row.passed).toBe(false);

    const served = await service.serveAttempt("u4", { attemptId: attempt.id, locale: "en" });
    expect(served.status).toBe("EXPIRED");
    expect(served.timeRemainingSec).toBe(0);
  });

  it("IDOR guard: a foreign attempt reads as NotFound, never Forbidden-with-existence", async () => {
    freshService();
    const attempt = await service.startQuiz("u1", { mode: "EXAM", licenseClassCode: "TB", locale: "en" });
    await expect(
      service.serveAttempt("u2", { attemptId: attempt.id, locale: "en" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.submit("u2", { attemptId: attempt.id, locale: "en" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
