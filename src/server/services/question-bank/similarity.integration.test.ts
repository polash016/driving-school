import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import {
  ALTERNATE_THRESHOLD,
  classifyAgainstPool,
  findRepeatPairs,
  regroupAlternates,
  storeStemEmbedding,
} from "./similarity";
import { buildRejectionLessons, recordRejection } from "./rejections";
import { transitionItem } from "./transitions";
import { upsertItem } from "./items";

/**
 * Similarity and the rejection ledger against real Postgres + pgvector (spec-04/05 amendment).
 *
 * Embeddings here are constructed rather than requested from a model: two orthogonal basis
 * vectors span a plane, and an angle in that plane gives an EXACT cosine. That makes the
 * thresholds testable — a model's own output would only ever be approximately similar, which
 * tests nothing about where the line sits.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const DIMENSIONS = 1536;
const RUN = randomUUID().slice(0, 8);
const actor: SessionUser = { id: "", role: "ADMIN", email: `sim-${RUN}@example.no` };
const reviewer: SessionUser = { id: "", role: "ADMIN", email: `sim-rev-${RUN}@example.no` };

let topicId = "";

/** A unit vector along one axis. */
function axis(index: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

/** A vector at `degrees` from `axis(a)` in the plane spanned by axes a and b. */
function atAngle(a: number, b: number, degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[a] = Math.cos(radians);
  vector[b] = Math.sin(radians);
  return vector;
}

function content(stem: string) {
  return {
    en: {
      stem: `${stem} [${RUN}]`,
      options: [
        { key: "a", text: "Yield" },
        { key: "b", text: "Continue" },
        { key: "c", text: "Stop" },
      ],
      explanation: `Because the rule says so [${RUN}].`,
    },
    nb: {
      stem: `${stem} (nb) [${RUN}]`,
      options: [
        { key: "a", text: "Vike" },
        { key: "b", text: "Kjøre videre" },
        { key: "c", text: "Stanse" },
      ],
      explanation: `Fordi regelen sier det [${RUN}].`,
    },
  };
}

async function makeItem(stem: string, embedding: number[]): Promise<string> {
  const item = await upsertItem(db, actor, {
    type: "TEXT",
    topicId,
    licenseClassId: null,
    difficulty: 3,
    content: content(stem),
    correctOptionKey: "a",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
  });
  await storeStemEmbedding(db, item.id, embedding, null);
  return item.id;
}

beforeAll(async () => {
  if (!enabled) return;
  for (const session of [actor, reviewer]) {
    const user = await db.user.create({
      data: {
        email: session.email,
        role: "ADMIN",
        emailVerifiedAt: new Date(),
        profile: { create: { firstName: "Sim", lastName: RUN } },
      },
      select: { id: true },
    });
    session.id = user.id;
  }
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
  await db.generationRejection.deleteMany({
    where: { OR: [{ masterItemId: { in: ids } }, { createdById: { in: [actor.id, reviewer.id] } }] },
  });
  await db.itemVariant.deleteMany({ where: { masterItemId: { in: ids } } });
  await db.masterItem.deleteMany({ where: { id: { in: ids } } });
  await db.auditLog.deleteMany({ where: { actorId: { in: [actor.id, reviewer.id] } } });
  await db.user.deleteMany({ where: { id: { in: [actor.id, reviewer.id] } } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("classifying a candidate against the bank", () => {
  it("calls a near-identical stem a repeat, a re-phrasing an alternate, and the rest distinct", async () => {
    // Axes 40/41 are this test's own plane, well away from anything a real embedding occupies.
    const anchor = await makeItem("Anchor question about yielding", axis(40));
    expect(anchor).toBeTruthy();

    const repeat = await classifyAgainstPool(db, atAngle(40, 41, 5)); // cos 5° ≈ 0.996
    expect(repeat.kind).toBe("repeat");
    expect(repeat.matchedItemId).toBe(anchor);

    const alternate = await classifyAgainstPool(db, atAngle(40, 41, 25)); // cos 25° ≈ 0.906
    expect(alternate.kind).toBe("alternate");
    expect(alternate.conceptGroupId).toBeTruthy();

    const distinct = await classifyAgainstPool(db, atAngle(40, 41, 70)); // cos 70° ≈ 0.342
    expect(distinct.kind).toBe("distinct");
  });

  it("excludes the item itself, so re-checking a saved question is not a self-match", async () => {
    const id = await makeItem("Self check question", axis(42));
    const verdict = await classifyAgainstPool(db, axis(42), id);
    expect(verdict.matchedItemId).not.toBe(id);
  });
});

d("finding repeats already in the bank", () => {
  it("surfaces a repeat pair once, not once per direction", async () => {
    const a = await makeItem("Repeat pair left", axis(44));
    const b = await makeItem("Repeat pair right", atAngle(44, 45, 3)); // cos ≈ 0.9986

    const pairs = await findRepeatPairs(db);
    const mine = pairs.filter((pair) => [a, b].includes(pair.id) && [a, b].includes(pair.matchedItemId));
    expect(mine).toHaveLength(1);
  });

  it("ignores retired questions — retiring one half is how a repeat is resolved", async () => {
    const a = await makeItem("Retire-resolves left", axis(46));
    const b = await makeItem("Retire-resolves right", atAngle(46, 47, 3));

    await transitionItem(db, actor, { id: b, to: "RETIRED", reason: "DUPLICATE" });

    const pairs = await findRepeatPairs(db);
    expect(pairs.some((pair) => [a, b].includes(pair.id) && [a, b].includes(pair.matchedItemId))).toBe(
      false,
    );
  });
});

d("grouping alternates", () => {
  it("does not chain two unrelated rules through a question that sits between them", async () => {
    // 0°, 30°, 60°: neighbours are cos 30° ≈ 0.866 (above the line), the ends cos 60° = 0.5.
    // Single linkage would merge all three; complete linkage must not.
    const left = await makeItem("Chain left", atAngle(50, 51, 0));
    const middle = await makeItem("Chain middle", atAngle(50, 51, 30));
    const right = await makeItem("Chain right", atAngle(50, 51, 60));
    expect(Math.cos((30 * Math.PI) / 180)).toBeGreaterThan(ALTERNATE_THRESHOLD);

    await regroupAlternates(db);

    const rows = await db.masterItem.findMany({
      where: { id: { in: [left, middle, right] } },
      select: { id: true, conceptGroupId: true },
    });
    const groups = new Map(rows.map((row) => [row.id, row.conceptGroupId]));
    expect(groups.get(left)).not.toBe(groups.get(right));
    // The pair that did merge shares a group, so the constraint still does its job.
    const merged =
      groups.get(left) === groups.get(middle) || groups.get(middle) === groups.get(right);
    expect(merged).toBe(true);
  });
});

d("the rejection ledger", () => {
  it("keeps a reviewer's reason and their note, and hands both back as a lesson", async () => {
    const item = await upsertItem(db, actor, {
      type: "TEXT",
      topicId,
      licenseClassId: null,
      difficulty: 3,
      content: content("Ambiguous distractor question"),
      correctOptionKey: "a",
      legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
    });
    await transitionItem(db, actor, { id: item.id, to: "IN_REVIEW" });
    await transitionItem(db, reviewer, {
      id: item.id,
      to: "RETIRED",
      reason: "AMBIGUOUS_DISTRACTOR",
      note: `Option B is defensible too [${RUN}].`,
    });

    const row = await db.generationRejection.findFirstOrThrow({
      where: { masterItemId: item.id },
      select: { source: true, reasonCodes: true, note: true, topicId: true },
    });
    expect(row.source).toBe("REVIEWER");
    expect(row.reasonCodes).toEqual(["AMBIGUOUS_DISTRACTOR"]);
    expect(row.note).toContain("Option B is defensible");
    expect(row.topicId).toBe(topicId);

    const lessons = await buildRejectionLessons(db, topicId);
    expect(lessons.block).toContain("Option B is defensible");
    expect(lessons.block).toContain("a wrong option was arguably also correct");
    expect(lessons.used).toBeGreaterThan(0);
  });

  it("records a gate refusal that never became a question, and ranks the reasons", async () => {
    await recordRejection(db, {
      source: "GATE",
      stemEn: `Uncited claim about speed [${RUN}]`,
      stemNb: `Ubelagt påstand om fart [${RUN}]`,
      reasonCodes: ["MISSING_CITATION"],
      topicId,
      createdById: actor.id,
    });

    const lessons = await buildRejectionLessons(db, topicId);
    expect(lessons.block).toContain("Uncited claim about speed");
    expect(lessons.block).toContain("it did not cite the law it was testing");
    expect(lessons.topReasons.some((reason) => reason.code === "MISSING_CITATION")).toBe(true);
  });

  it("returns an empty block for a topic nothing has been rejected on", async () => {
    const lessons = await buildRejectionLessons(db, `no-such-topic-${RUN}`);
    expect(lessons.block).toBe("");
    expect(lessons.used).toBe(0);
  });
});
