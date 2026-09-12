import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  loadQuestionOverlay,
  type QuestionOverlayRow,
} from "@/server/services/i18n/resolve";

/**
 * How a served variant finds its translation (spec-20).
 *
 * A student is served an `ItemVariant`; the unit a translator works on is the `MasterItem`. The
 * two used to be joined by a derived copy that could be skipped, forgotten or left stale — and
 * coverage never counted it. Now the lookup goes through the master, guarded on the version the
 * variant was published from, so "translated" and "served" are one fact.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomBytes(3).toString("hex");
const CODE = `zq-${RUN}`.slice(0, 8);
const ids = { topic: "", master: "", current: "", stale: "", variation: "" };
const payload = {
  stem: "[zq] What applies?",
  options: [
    { key: "a", text: "[zq] Yield" },
    { key: "b", text: "[zq] Stop" },
  ],
  explanation: "[zq] because",
};

const content = {
  en: {
    stem: "What applies?",
    options: [
      { key: "a", text: "Yield" },
      { key: "b", text: "Stop" },
    ],
  },
  nb: {
    stem: "Hva gjelder?",
    options: [
      { key: "a", text: "Vik" },
      { key: "b", text: "Stopp" },
    ],
  },
};

function row(
  variantId: string,
  overrides: Partial<QuestionOverlayRow> = {},
): QuestionOverlayRow {
  return {
    variantId,
    masterItemId: ids.master,
    masterVersion: 2,
    source: "TEMPLATE",
    currentMasterVersion: 2,
    ...overrides,
  };
}

async function setStatus(
  status: "MACHINE" | "APPROVED" | "NEEDS_REVIEW" | "REJECTED",
) {
  await db.translation.update({
    where: {
      locale_entity_entityId: {
        locale: CODE,
        entity: "MASTER_ITEM",
        entityId: ids.master,
      },
    },
    data: { status },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  await db.language.create({
    data: {
      code: CODE,
      englishName: "Overlay",
      nativeName: "Overlay",
      shortLabel: "ZQ",
      urlPrefix: `/${CODE}`,
      requiresApproval: false,
    },
  });
  ids.topic = (
    await db.topic.create({
      data: { slug: `zq-${RUN}`, name: { en: "Zq", nb: "Zq" }, sortOrder: 900 },
      select: { id: true },
    })
  ).id;
  ids.master = (
    await db.masterItem.create({
      data: {
        type: "TEXT",
        status: "APPROVED",
        topicId: ids.topic,
        difficulty: 3,
        version: 2,
        content,
        correctOptionKey: "a",
        legalCitations: [],
        createdBy: "HUMAN",
      },
      select: { id: true },
    })
  ).id;
  const variant = async (
    tag: string,
    masterVersion: number,
    source: "TEMPLATE" | "AI_VARIATION",
  ) =>
    (
      await db.itemVariant.create({
        data: {
          masterItemId: ids.master,
          masterVersion,
          contentHash: `hash-${CODE}-${tag}`,
          content,
          correctOptionKey: "a",
          explanation: { en: "because", nb: "fordi", citations: [] },
          source,
        },
        select: { id: true },
      })
    ).id;
  ids.current = await variant("current", 2, "TEMPLATE");
  ids.stale = await variant("stale", 1, "TEMPLATE");
  ids.variation = await variant("variation", 2, "AI_VARIATION");
  await db.translation.create({
    data: {
      locale: CODE,
      entity: "MASTER_ITEM",
      entityId: ids.master,
      value: payload,
      status: "MACHINE",
      sourceHash: "fixture",
    },
  });
});

afterAll(async () => {
  if (!enabled) return;
  await db.language.deleteMany({ where: { code: CODE } });
  await db.itemVariant.deleteMany({ where: { masterItemId: ids.master } });
  await db.masterItem.deleteMany({ where: { id: ids.master } });
  await db.topic.deleteMany({ where: { id: ids.topic } });
  await db.$disconnect();
});

d("loadQuestionOverlay (spec-20)", () => {
  it("serves the master's translation on its current TEMPLATE variant, keyed by variant id", async () => {
    const overlay = await loadQuestionOverlay(db, CODE, [row(ids.current)]);
    expect(overlay.get(ids.current)).toEqual(payload);
  });

  it("leaves a variant published from an older master version untranslated", async () => {
    const overlay = await loadQuestionOverlay(db, CODE, [
      row(ids.stale, { masterVersion: 1 }),
    ]);
    expect(overlay.has(ids.stale)).toBe(false);
  });

  it("leaves an AI_VARIATION variant untranslated until it has a unit of its own", async () => {
    const overlay = await loadQuestionOverlay(db, CODE, [
      row(ids.variation, { source: "AI_VARIATION" }),
    ]);
    expect(overlay.has(ids.variation)).toBe(false);
  });

  it("serves machine output only where the language allows it", async () => {
    await db.language.update({
      where: { code: CODE },
      data: { requiresApproval: true },
    });
    expect(
      (await loadQuestionOverlay(db, CODE, [row(ids.current)])).has(
        ids.current,
      ),
    ).toBe(false);
    await setStatus("APPROVED");
    expect(
      (await loadQuestionOverlay(db, CODE, [row(ids.current)])).get(
        ids.current,
      ),
    ).toEqual(payload);
    await db.language.update({
      where: { code: CODE },
      data: { requiresApproval: false },
    });
    await setStatus("MACHINE");
  });

  it("never serves a flagged or rejected translation under either policy", async () => {
    for (const status of ["NEEDS_REVIEW", "REJECTED"] as const) {
      await setStatus(status);
      expect(
        (await loadQuestionOverlay(db, CODE, [row(ids.current)])).has(
          ids.current,
        ),
      ).toBe(false);
    }
    await setStatus("MACHINE");
  });

  it("costs a built-in language nothing", async () => {
    expect((await loadQuestionOverlay(db, "en", [row(ids.current)])).size).toBe(
      0,
    );
  });
});
