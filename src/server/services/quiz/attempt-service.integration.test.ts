import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConflictError,
  ExamStateError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import {
  categoryPerformance,
  getResumableAttempt,
  listAttemptHistory,
} from "@/server/services/assessment/history";
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
    data: [
      "u1",
      "u2",
      "u3",
      "u4",
      "u10",
      "u11",
      "u12",
      "u13",
      "u14",
      "u15",
      "u20",
      "u21",
      "u22",
    ].map((id) => ({
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
          // Spec-04 added the master's own answer key; the DB constrains every non-draft item
          // to carry one, and the variants below publish it.
          correctOptionKey: "a",
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
    expect(attempt.questions.filter((q) => q.topicSlug === "r1")).toHaveLength(
      3,
    );

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
    const a = await service.startQuiz("u1", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    const b = await service.startQuiz("u2", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    const sig = (x: typeof a) =>
      x.questions.map(
        (q) => `${q.stem}|${q.options.map((o) => o.key).join("")}`,
      );
    expect(sig(a)).not.toEqual(sig(b));
  });

  it("seen-window: a user's next exam repeats no contentHash", async () => {
    const first = await service.startQuiz("u3", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    const second = await service.startQuiz("u3", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    const stems = (x: typeof first) => new Set(x.questions.map((q) => q.stem));
    const overlap = [...stems(first)].filter((s) => stems(second).has(s));
    expect(overlap).toEqual([]); // distinct variants → distinct stems in fixtures
  });

  it("answer autosave: EXAM ack reveals nothing; resume restores state cross-device", async () => {
    freshService();
    const attempt = await service.startQuiz("u4", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
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
    const resumed = await service.serveAttempt("u4", {
      attemptId: attempt.id,
      locale: "en",
    });
    expect(resumed.questions[0].answeredOptionKey).toBe(q1.options[1].key);
    expect(resumed.currentPosition).toBe(2);
    expect(resumed.timeRemainingSec).toBe(5400 - 60);
    expect(resumed.questions.map((q) => q.stem)).toEqual(
      attempt.questions.map((q) => q.stem),
    );
    expect(JSON.stringify(resumed)).not.toContain("correctOptionKey");
  });

  it("submit grades server-side against the snapshot pass mark; resubmit is idempotent", async () => {
    freshService();
    gradedCalls.length = 0;
    const attempt = await service.startQuiz("u1", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });

    // 4 correct ('a' is always correct in fixtures), 2 wrong
    for (const q of attempt.questions) {
      await service.answer("u1", {
        attemptId: attempt.id,
        position: q.position,
        optionKey:
          q.position <= 4 ? "a" : q.options.find((o) => o.key !== "a")!.key,
        locale: "en",
      });
    }

    const result = await service.submit("u1", {
      attemptId: attempt.id,
      locale: "en",
    });
    expect(result.correctCount).toBe(4);
    expect(result.passMark).toBe(4);
    expect(result.passed).toBe(true);
    expect(result.review).toHaveLength(6);
    expect(result.review.filter((r) => r.correct)).toHaveLength(4);
    expect(result.topicBreakdown.reduce((s, t) => s + t.total, 0)).toBe(6);
    expect(result.review[0].explanation.citations[0].sourceCode).toBe(
      "trafikkreglene",
    );
    expect(gradedCalls).toEqual(["u1"]);

    const again = await service.submit("u1", {
      attemptId: attempt.id,
      locale: "en",
    });
    expect(again).toEqual(result);
    expect(gradedCalls).toEqual(["u1"]); // no double grading

    // post-submit answering is rejected
    await expect(
      service.answer("u1", {
        attemptId: attempt.id,
        position: 1,
        optionKey: "a",
        locale: "en",
      }),
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
    const wrongKey = attempt.questions[0].options.find(
      (o) => o.key !== "a",
    )!.key;
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
    const attempt = await service.startQuiz("u4", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    await service.answer("u4", {
      attemptId: attempt.id,
      position: 1,
      optionKey: "a",
      locale: "en",
    });
    await service.answer("u4", {
      attemptId: attempt.id,
      position: 2,
      optionKey: "a",
      locale: "en",
    });

    clock.advanceSec(90 * 60 + 31); // past limit + grace

    await expect(
      service.answer("u4", {
        attemptId: attempt.id,
        position: 3,
        optionKey: "a",
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(ExamStateError);

    const row = await db.examAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      select: { status: true, correctCount: true, passed: true },
    });
    expect(row.status).toBe("EXPIRED");
    expect(row.correctCount).toBe(2);
    expect(row.passed).toBe(false);

    const served = await service.serveAttempt("u4", {
      attemptId: attempt.id,
      locale: "en",
    });
    expect(served.status).toBe("EXPIRED");
    expect(served.timeRemainingSec).toBe(0);
  });

  it("IDOR guard: a foreign attempt reads as NotFound, never Forbidden-with-existence", async () => {
    freshService();
    const attempt = await service.startQuiz("u1", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    await expect(
      service.serveAttempt("u2", { attemptId: attempt.id, locale: "en" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.submit("u2", { attemptId: attempt.id, locale: "en" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

d("candidate filtering by licence class", () => {
  it("does not hide class-tagged questions from a practice quiz", async () => {
    // Regression: practice passes `licenseClassId: null`, which used to be read as "questions
    // with no class" and hid every class-B question — most of a real bank.
    const licenseClass = await db.licenseClass.findFirstOrThrow({
      select: { id: true },
    });
    const tagged = await db.masterItem.findFirst({
      where: {
        status: "APPROVED",
        deletedAt: null,
        variants: { some: { isActive: true } },
      },
      select: { id: true, licenseClassId: true },
    });
    if (!tagged) return;

    await db.masterItem.update({
      where: { id: tagged.id },
      data: { licenseClassId: licenseClass.id },
      select: { id: true },
    });

    const source = new PrismaVariantSource(db);
    const roots = await db.topic.findMany({
      where: { parentId: null, deletedAt: null },
      select: { slug: true },
    });
    const slugs = roots.map((topic) => topic.slug);

    const unfiltered = await source.candidatesByTopic({ topicSlugs: slugs });
    const practice = await source.candidatesByTopic({
      topicSlugs: slugs,
      licenseClassId: null,
    });

    const total = (pools: Record<string, unknown[]>) =>
      Object.values(pools).reduce((sum, pool) => sum + pool.length, 0);
    expect(total(practice)).toBe(total(unfiltered));

    await db.masterItem.update({
      where: { id: tagged.id },
      data: { licenseClassId: tagged.licenseClassId },
      select: { id: true },
    });
  });
});

d("an answer is written once (developer decision 2026-08-25)", () => {
  it("refuses a different answer to a question already answered", async () => {
    freshService();
    const attempt = await service.startQuiz("u10", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    const first = attempt.questions[0];
    const chosen = first.options[0].key;
    const other = first.options.find((option) => option.key !== chosen)!.key;

    await service.answer("u10", {
      attemptId: attempt.id,
      position: 1,
      optionKey: chosen,
      locale: "en",
    });

    await expect(
      service.answer("u10", {
        attemptId: attempt.id,
        position: 1,
        optionKey: other,
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const stored = await db.examAttemptQuestion.findFirstOrThrow({
      where: { attemptId: attempt.id, position: 1 },
      select: { answeredOptionKey: true },
    });
    expect(stored.answeredOptionKey).toBe(chosen);
  });

  it("the database refuses it too, even when the service is bypassed", async () => {
    freshService();
    const attempt = await service.startQuiz("u11", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    const first = attempt.questions[0];
    const chosen = first.options[0].key;
    const other = first.options.find((option) => option.key !== chosen)!.key;

    await service.answer("u11", {
      attemptId: attempt.id,
      position: 1,
      optionKey: chosen,
      locale: "en",
    });

    // Straight at the table — no service, no validation. The trigger is the actual guarantee.
    await expect(
      db.examAttemptQuestion.updateMany({
        where: { attemptId: attempt.id, position: 1 },
        data: { answeredOptionKey: other },
      }),
    ).rejects.toThrow(/already answered/i);
  });

  it("practice: the answer cannot be improved after the explanation is shown", async () => {
    freshService();
    const attempt = await service.startQuiz("u12", {
      mode: "PRACTICE",
      questionCount: 3,
      locale: "en",
    });
    const first = attempt.questions[0];
    const wrong = first.options.find((option) => option.key !== "a")!.key;

    const result = await service.answer("u12", {
      attemptId: attempt.id,
      position: 1,
      optionKey: wrong,
      locale: "en",
    });
    expect("correctOptionKey" in result).toBe(true);

    // The student now knows the answer. It must not help them.
    await expect(
      service.answer("u12", {
        attemptId: attempt.id,
        position: 1,
        optionKey: "a",
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const submitted = await service.submit("u12", {
      attemptId: attempt.id,
      locale: "en",
    });
    expect(submitted.review[0].correct).toBe(false);
  });

  it("re-sending the SAME answer stays idempotent — a retry is not a change", async () => {
    freshService();
    const attempt = await service.startQuiz("u13", {
      mode: "PRACTICE",
      questionCount: 3,
      locale: "en",
    });
    const key = attempt.questions[0].options[0].key;

    const one = await service.answer("u13", {
      attemptId: attempt.id,
      position: 1,
      optionKey: key,
      locale: "en",
    });
    const two = await service.answer("u13", {
      attemptId: attempt.id,
      position: 1,
      optionKey: key,
      locale: "en",
    });
    expect(two).toEqual(one);
  });
});

d("re-reading the feedback for an answered question", () => {
  it("returns what was already shown, so navigating back is not a blank card", async () => {
    freshService();
    const attempt = await service.startQuiz("u14", {
      mode: "PRACTICE",
      questionCount: 3,
      locale: "en",
    });
    const answered = await service.answer("u14", {
      attemptId: attempt.id,
      position: 1,
      optionKey: attempt.questions[0].options[0].key,
      locale: "en",
    });

    const reread = await service.revealAnswered("u14", {
      attemptId: attempt.id,
      position: 1,
      locale: "en",
    });
    expect(reread).toEqual(answered);
  });

  it("refuses a question that has not been answered, and refuses EXAM mode outright", async () => {
    freshService();
    const practice = await service.startQuiz("u15", {
      mode: "PRACTICE",
      questionCount: 3,
      locale: "en",
    });
    await expect(
      service.revealAnswered("u15", {
        attemptId: practice.id,
        position: 2,
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const exam = await service.startQuiz("u15", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    await service.answer("u15", {
      attemptId: exam.id,
      position: 1,
      optionKey: exam.questions[0].options[0].key,
      locale: "en",
    });
    await expect(
      service.revealAnswered("u15", {
        attemptId: exam.id,
        position: 1,
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

d("resuming a test that was walked away from", () => {
  const session = (id: string): SessionUser => ({
    id,
    role: "STUDENT",
    email: `${id}@test.local`,
  });

  it("offers the unfinished test back, with how far the student got", async () => {
    freshService();
    const attempt = await service.startQuiz("u20", {
      mode: "PRACTICE",
      questionCount: 4,
      locale: "en",
    });
    await service.answer("u20", {
      attemptId: attempt.id,
      position: 1,
      optionKey: attempt.questions[0].options[0].key,
      locale: "en",
    });
    await service.answer("u20", {
      attemptId: attempt.id,
      position: 2,
      optionKey: attempt.questions[1].options[0].key,
      locale: "en",
    });

    const resumable = await getResumableAttempt(db, session("u20"), "u20");
    expect(resumable?.id).toBe(attempt.id);
    expect(resumable?.answeredCount).toBe(2);
    expect(resumable?.questionCount).toBe(4);
    expect(resumable?.timeRemainingSec).toBeNull(); // untimed practice
  });

  it("does not offer a timed test whose clock ran out while they were away", async () => {
    freshService();
    // The fake clock sits in the past, so this EXAM's 90 minutes are long gone in real time.
    const attempt = await service.startQuiz("u21", {
      mode: "EXAM",
      licenseClassCode: "TB",
      locale: "en",
    });
    expect(attempt.timeRemainingSec).toBe(5400);

    const resumable = await getResumableAttempt(db, session("u21"), "u21");
    expect(resumable?.id).not.toBe(attempt.id);
  });

  it("offers nothing once the test is handed in", async () => {
    freshService();
    const attempt = await service.startQuiz("u22", {
      mode: "PRACTICE",
      questionCount: 3,
      locale: "en",
    });
    for (const question of attempt.questions) {
      await service.answer("u22", {
        attemptId: attempt.id,
        position: question.position,
        optionKey: "a",
        locale: "en",
      });
    }
    await service.submit("u22", { attemptId: attempt.id, locale: "en" });

    expect(await getResumableAttempt(db, session("u22"), "u22")).toBeNull();
  });

  it("the record is tests only — a mock exam is practice, and practice is not the record", async () => {
    freshService();
    const practice = await service.startQuiz("u22", {
      mode: "PRACTICE",
      questionCount: 3,
      locale: "en",
    });
    await service.submit("u22", { attemptId: practice.id, locale: "en" });

    const tests = await listAttemptHistory(db, session("u22"), "u22", {
      page: 1,
      pageSize: 20,
    });
    expect(tests.items.some((item) => item.id === practice.id)).toBe(false);

    const everything = await listAttemptHistory(db, session("u22"), "u22", {
      page: 1,
      pageSize: 20,
      onlyTests: false,
    });
    expect(everything.items.some((item) => item.id === practice.id)).toBe(true);
    expect(everything.items.find((item) => item.id === practice.id)?.kind).toBe(
      "PRACTICE",
    );
  });

  it("a configured test IS the record, and is named a test whatever its engine mode", async () => {
    freshService();
    const configured = await service.startQuiz(
      "u22",
      // One category only, so the other stays untested — the "not tested yet" case.
      {
        mode: "TOPIC",
        questionCount: 3,
        topicSlugs: ["r1"],
        timed: false,
        locale: "en",
      },
      {
        countsTowardGuarantee: false,
        setupSnapshot: { timed: false, questionCount: 3, topicSlugs: ["r1"] },
      },
    );
    for (const question of configured.questions) {
      await service.answer("u22", {
        attemptId: configured.id,
        position: question.position,
        // "a" is always the correct key in the fixtures; option ORDER is shuffled per attempt,
        // so a wrong answer has to be chosen by key, not by position.
        optionKey:
          question.position === 1
            ? "a"
            : question.options.find((option) => option.key !== "a")!.key,
        locale: "en",
      });
    }
    await service.submit("u22", { attemptId: configured.id, locale: "en" });

    const history = await listAttemptHistory(db, session("u22"), "u22", {
      page: 1,
      pageSize: 20,
    });
    const row = history.items.find((item) => item.id === configured.id);
    expect(row?.kind).toBe("TEST");
    expect(row?.status).toBe("SUBMITTED");
    expect(row?.durationSec).not.toBeNull();

    // …and it is what the category panel counts. Only answered questions are counted, so a
    // percentage means "of what you attempted", which is what makes it useful from question one.
    const categories = await categoryPerformance(
      db,
      session("u22"),
      "u22",
      "en",
    );
    const tested = categories.filter((category) => category.answered > 0);
    expect(tested.length).toBeGreaterThan(0);
    expect(tested.reduce((sum, category) => sum + category.answered, 0)).toBe(
      3,
    );
    expect(tested.reduce((sum, category) => sum + category.correct, 0)).toBe(1);
    for (const category of categories) {
      expect(category.percent).toBe(
        category.answered === 0
          ? null
          : Math.round((category.correct / category.answered) * 100),
      );
    }
    // Every root category is listed, including ones never tested — the gaps are the useful part.
    expect(tested.map((category) => category.topicSlug)).toEqual(["r1"]);
    const untested = categories.find((category) => category.topicSlug === "r2");
    expect(untested?.answered).toBe(0);
    expect(untested?.percent).toBeNull();
  });
});
