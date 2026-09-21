import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { upsertItem } from "./items";
import { transitionItem } from "./transitions";
import {
  contentFingerprint,
  rewriteApprovedItemInPlace,
  rollbackRewrite,
} from "./rewrite";

/**
 * The in-place rewrite against a real Postgres (spec-22).
 *
 * Every claim the campaign rests on is proved here rather than asserted: the freeze still holds
 * without the GUC, the answer key cannot move even with it, a sat paper still renders its own
 * text, translations land in the same transaction as the content, and a rollback revives the
 * original variant instead of creating a third one.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomUUID().slice(0, 8);
/** A throwaway language: Translation.locale is a FK, and the real ones must not be touched. */
const TEST_LOCALE = `zz${RUN.slice(0, 2)}`;
const author: SessionUser = { id: "", role: "ADMIN", email: `rw-${RUN}@example.no` };
const rev1: SessionUser = { id: "", role: "ADMIN", email: `rw-r1-${RUN}@example.no` };
const rev2: SessionUser = { id: "", role: "ADMIN", email: `rw-r2-${RUN}@example.no` };

let topicId = "";
let licenseClassId = "";

const content = (stem: string, a = "Yes, always") => ({
  en: {
    stem,
    options: [
      { key: "a", text: a },
      { key: "b", text: "Traffic from the right" },
      { key: "c", text: "Traffic from the left" },
    ],
    explanation: "Give way to the right when nothing says otherwise.",
  },
  nb: {
    stem: "Hvem har forkjorsrett?",
    options: [
      { key: "a", text: "Ja" },
      { key: "b", text: "Trafikk fra hoyre" },
      { key: "c", text: "Trafikk fra venstre" },
    ],
    explanation: "Vikeplikt for trafikk fra hoyre.",
  },
});

async function makeApprovedItem(stem: string): Promise<string> {
  const created = await upsertItem(db, author, {
    type: "TEXT",
    topicId,
    licenseClassId,
    difficulty: 3,
    content: content(stem),
    correctOptionKey: "b",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
  });
  await transitionItem(db, author, { id: created.id, to: "IN_REVIEW" });
  // A HUMAN-authored item needs one approver who is not its author (spec-04b); only an
  // AI-authored one needs two.
  await transitionItem(db, rev1, { id: created.id, to: "APPROVED" });
  const item = await db.masterItem.findUniqueOrThrow({
    where: { id: created.id },
    select: { status: true },
  });
  expect(item.status).toBe("APPROVED");
  return created.id;
}

beforeAll(async () => {
  for (const user of [author, rev1, rev2]) {
    const row = await db.user.create({
      data: { email: user.email, role: "ADMIN" },
      select: { id: true },
    });
    user.id = row.id;
  }
  const topic = await db.topic.create({
    data: { slug: `rw-${RUN}`, name: { en: "Rewrite", nb: "Rewrite" }, sortOrder: 900 },
    select: { id: true },
  });
  topicId = topic.id;
  const lc = await db.licenseClass.findFirst({ select: { id: true } });
  licenseClassId = lc!.id;
  // Translation.locale is a foreign key to Language.
  await db.language.upsert({
    where: { code: TEST_LOCALE },
    create: {
      code: TEST_LOCALE,
      urlPrefix: TEST_LOCALE,
      englishName: "Rewrite Probe",
      nativeName: "Rewrite Probe",
      shortLabel: "ZZ",
    },
    update: {},
    select: { code: true },
  });
});

afterAll(async () => {
  await db.masterItem.deleteMany({ where: { topicId } });
  await db.topic.deleteMany({ where: { id: topicId } });
  await db.user.deleteMany({ where: { email: { contains: `-${RUN}@` } } });
  await db.language.deleteMany({ where: { code: TEST_LOCALE } });
  await redis.quit().catch(() => undefined);
});

d("the freeze, and its one exception", () => {
  it("still refuses an ordinary update of an approved item", async () => {
    const id = await makeApprovedItem(`Frozen probe ${RUN}`);
    await expect(
      db.masterItem.update({
        where: { id },
        data: { content: content("Changed behind the gate") },
      }),
    ).rejects.toThrow(/approved and frozen/i);
  });

  it("refuses an answer-key change even inside the rewrite path", async () => {
    const id = await makeApprovedItem(`Key probe ${RUN}`);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL teoripro.inplace_rewrite = 'on'`);
        await tx.masterItem.update({
          where: { id },
          data: { correctOptionKey: "c" },
        });
      }),
    ).rejects.toThrow(/text and version only/i);
  });
});

d("rewriteApprovedItemInPlace", () => {
  it("swaps content, variant and translations together", async () => {
    const id = await makeApprovedItem(`Swap probe ${RUN}`);
    const before = await db.masterItem.findUniqueOrThrow({
      where: { id },
      select: { version: true, content: true, correctOptionKey: true },
    });
    const oldVariant = await db.itemVariant.findFirstOrThrow({
      where: { masterItemId: id, isActive: true },
      select: { id: true, content: true, contentHash: true },
    });

    // A stale translation that would be served over the new text if the swap did not replace it.
    await db.translation.create({
      data: {
        locale: TEST_LOCALE,
        entity: "MASTER_ITEM",
        entityId: id,
        value: { stem: "OLD BANGLA", options: [], explanation: "" },
        status: "APPROVED",
        sourceHash: "stale",
      },
    });

    const next = content(`Who gives way here? ${RUN}`);
    const result = await rewriteApprovedItemInPlace(db, {
      itemId: id,
      newContent: next,
      expectedVersion: before.version,
      expectedFingerprint: contentFingerprint(before.content),
      runId: `run-${RUN}`,
      actorId: author.id,
      translations: [
        {
          locale: TEST_LOCALE,
          value: { stem: "NEW BANGLA", options: [], explanation: "" },
          status: "MACHINE",
          sourceHash: "fresh",
        },
      ],
    });

    expect(result.versionTo).toBe(before.version + 1);

    const after = await db.masterItem.findUniqueOrThrow({
      where: { id },
      select: { version: true, correctOptionKey: true, content: true },
    });
    // The answer key never moves.
    expect(after.correctOptionKey).toBe(before.correctOptionKey);
    expect((after.content as { en: { stem: string } }).en.stem).toContain("Who gives way");

    // Old variant deactivated but intact — a sat paper still renders its own text.
    const old = await db.itemVariant.findUniqueOrThrow({
      where: { id: oldVariant.id },
      select: { isActive: true, content: true },
    });
    expect(old.isActive).toBe(false);
    expect(old.content).toEqual(oldVariant.content);

    const active = await db.itemVariant.findMany({
      where: { masterItemId: id, isActive: true },
      select: { masterVersion: true },
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.masterVersion).toBe(after.version);

    // The translation was replaced, not left stale — this is the no-gap guarantee.
    const bn = await db.translation.findFirstOrThrow({
      where: { entity: "MASTER_ITEM", entityId: id, locale: TEST_LOCALE },
      select: { value: true, sourceHash: true, status: true },
    });
    expect((bn.value as { stem: string }).stem).toBe("NEW BANGLA");
    expect(bn.sourceHash).toBe("fresh");

    // The rollback record exists.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "item.simplified", entityId: id },
      select: { meta: true },
    });
    expect((audit.meta as { previousContent: unknown }).previousContent).toEqual(before.content);
  });

  it("refuses a proposal built against a version that has since moved", async () => {
    const id = await makeApprovedItem(`Stale probe ${RUN}`);
    const before = await db.masterItem.findUniqueOrThrow({
      where: { id },
      select: { version: true, content: true },
    });
    await expect(
      rewriteApprovedItemInPlace(db, {
        itemId: id,
        newContent: content("Never applied"),
        expectedVersion: before.version + 5,
        expectedFingerprint: contentFingerprint(before.content),
        runId: `run-${RUN}`,
        actorId: author.id,
        translations: [],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const after = await db.masterItem.findUniqueOrThrow({
      where: { id },
      select: { version: true, content: true },
    });
    expect(after.version).toBe(before.version);
    expect(after.content).toEqual(before.content);
  });
});

d("rollbackRewrite", () => {
  it("restores the text and REVIVES the original variant rather than making a third", async () => {
    const id = await makeApprovedItem(`Rollback probe ${RUN}`);
    const before = await db.masterItem.findUniqueOrThrow({
      where: { id },
      select: { version: true, content: true },
    });
    const originalVariantId = (
      await db.itemVariant.findFirstOrThrow({
        where: { masterItemId: id, isActive: true },
        select: { id: true },
      })
    ).id;

    await rewriteApprovedItemInPlace(db, {
      itemId: id,
      newContent: content(`Shortened ${RUN}`),
      expectedVersion: before.version,
      expectedFingerprint: contentFingerprint(before.content),
      runId: `run-${RUN}`,
      actorId: author.id,
      translations: [],
    });
    const afterRewrite = await db.itemVariant.count({ where: { masterItemId: id } });

    await rollbackRewrite(db, {
      itemId: id,
      previousContent: before.content as object,
      versionFrom: before.version,
      translations: [],
      actorId: author.id,
      runId: `run-${RUN}`,
    });

    const restored = await db.masterItem.findUniqueOrThrow({
      where: { id },
      select: { version: true, content: true },
    });
    expect(restored.version).toBe(before.version);
    expect(restored.content).toEqual(before.content);

    // No third row: the original contentHash matched, so publishItem revived the original.
    expect(await db.itemVariant.count({ where: { masterItemId: id } })).toBe(afterRewrite);
    const original = await db.itemVariant.findUniqueOrThrow({
      where: { id: originalVariantId },
      select: { isActive: true },
    });
    expect(original.isActive).toBe(true);
  });
});
