import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { keys, redis } from "@/server/redis";
import {
  invalidateTaxonomy,
  localizeTopicNames,
  sourceLabels,
} from "./taxonomy";

/**
 * Names on the student's screens (spec-20, delivering spec-15 D6).
 *
 * Topic names, the licence class and the legal source labels were translated, counted in
 * coverage, and read by nothing a student sees. One cached overlay per language now serves the
 * result page's per-topic bars, the setup screen, the category standing and the citation line.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const CODE = `zt-${RUN}`.slice(0, 8);
const SOURCE = `zt-src-${RUN}`;
let topic = {
  id: "",
  name: { en: "Right of way", nb: "Vikeplikt" } as unknown,
};

beforeAll(async () => {
  if (!enabled) return;
  await db.language.create({
    data: {
      code: CODE,
      englishName: "Taxon",
      nativeName: "Taxon",
      shortLabel: "ZT",
      urlPrefix: `/${CODE}`,
      requiresApproval: false,
    },
  });
  const created = await db.topic.create({
    data: {
      slug: `zt-${RUN}`,
      name: { en: "Right of way", nb: "Vikeplikt" },
      sortOrder: 960,
    },
    select: { id: true, name: true },
  });
  topic = created;
  await db.kbSource.create({
    data: { code: SOURCE, kind: "REGULATION", name: "Trafikkreglene" },
    select: { id: true },
  });
  await db.translation.createMany({
    data: [
      {
        locale: CODE,
        entity: "TOPIC",
        entityId: topic.id,
        sourceHash: "fixture",
        status: "MACHINE",
        value: { name: `[${CODE}] Right of way`, description: "" },
      },
      {
        locale: CODE,
        entity: "KB_SOURCE",
        entityId: SOURCE,
        sourceHash: "fixture",
        status: "MACHINE",
        value: { name: `[${CODE}] Trafikkreglene` },
      },
    ],
  });
});

afterAll(async () => {
  if (!enabled) return;
  await invalidateTaxonomy(CODE);
  await db.language.deleteMany({ where: { code: CODE } });
  await db.kbSource.deleteMany({ where: { code: SOURCE } });
  await db.topic.deleteMany({ where: { id: topic.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("taxonomy labels (spec-20)", () => {
  it("labels a topic in the student's language, and in the authored one for a built-in", async () => {
    const [inZt] = await localizeTopicNames(db, CODE, [topic]);
    expect(inZt.label).toBe(`[${CODE}] Right of way`);
    const [inEn] = await localizeTopicNames(db, "en", [topic]);
    expect(inEn.label).toBe("Right of way");
    const [inNb] = await localizeTopicNames(db, "nb", [topic]);
    expect(inNb.label).toBe("Vikeplikt");
  });

  it("labels a legal source, and falls back to the code for one it does not know", async () => {
    expect(await sourceLabels(db, CODE, [SOURCE, "nope"])).toEqual({
      [SOURCE]: `[${CODE}] Trafikkreglene`,
      nope: "nope",
    });
    expect(await sourceLabels(db, "en", [SOURCE])).toEqual({
      [SOURCE]: "Trafikkreglene",
    });
  });

  it("holds a flagged label back and shows the authored name instead", async () => {
    await db.translation.updateMany({
      where: { locale: CODE, entity: "TOPIC", entityId: topic.id },
      data: { status: "NEEDS_REVIEW" },
    });
    await invalidateTaxonomy(CODE);
    const [row] = await localizeTopicNames(db, CODE, [topic]);
    expect(row.label).toBe("Right of way");
    await db.translation.updateMany({
      where: { locale: CODE, entity: "TOPIC", entityId: topic.id },
      data: { status: "MACHINE" },
    });
    await invalidateTaxonomy(CODE);
  });

  it("reads a language's overlay once and caches it until invalidated", async () => {
    await invalidateTaxonomy(CODE);
    expect(await redis.get(keys.i18nTaxonomy(CODE))).toBeNull();
    await localizeTopicNames(db, CODE, [topic]);
    expect(await redis.get(keys.i18nTaxonomy(CODE))).not.toBeNull();
    await invalidateTaxonomy(CODE);
    expect(await redis.get(keys.i18nTaxonomy(CODE))).toBeNull();
  });
});
