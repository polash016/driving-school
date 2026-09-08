import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { extractAll, extractMessages } from "./extract";

/**
 * `extractAll` with `ids` — O(batch), not O(bank) (spec-19a).
 *
 * `unitsFor` in `runs.ts` wants 5-20 ids out of a bank that can run to hundreds or thousands of
 * rows; without a WHERE clause every batch re-reads and re-hashes the whole approved bank just to
 * keep a handful. These tests pin the id filter at the query boundary, per entity.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomBytes(3).toString("hex");
const topicIds: string[] = [];
let signId = "";

beforeAll(async () => {
  if (!enabled) return;
  for (let i = 0; i < 3; i++) {
    const topic = await db.topic.create({
      data: {
        slug: `ex-${RUN}-${i}`,
        name: { en: `Extract Topic ${i}`, nb: `Extract Emne ${i}` },
        sortOrder: 950 + i,
      },
      select: { id: true },
    });
    topicIds.push(topic.id);
  }
  const sign = await db.sign.create({
    data: {
      code: `ex-${RUN}`,
      signClass: "FORBUD",
      svgPath: `/signs/ex-${RUN}.svg`,
      name: { en: `Extract Sign ${RUN}`, nb: `Extract Skilt ${RUN}` },
      meaning: { en: "No entry", nb: "Forbudt" },
    },
    select: { id: true },
  });
  signId = sign.id;
});

afterAll(async () => {
  if (!enabled) return;
  await db.topic.deleteMany({ where: { id: { in: topicIds } } });
  await db.sign.delete({ where: { id: signId } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("extractAll with ids", () => {
  it("returns only those units", async () => {
    const [id1, id2] = topicIds;
    const units = await extractAll(db, {
      glossaryVersion: 1,
      only: ["TOPIC"],
      ids: [id1, id2],
    });
    expect(units.map((unit) => unit.entityId).sort()).toEqual(
      [id1, id2].sort(),
    );
    for (const unit of units) {
      expect(unit.sourceHash).toBeTruthy();
    }
  });

  it("returns nothing for another entity even if the id exists elsewhere", async () => {
    const units = await extractAll(db, {
      glossaryVersion: 1,
      only: ["SIGN"],
      ids: [topicIds[0]],
    });
    expect(units).toEqual([]);
  });

  it("returns the sign when its own id is asked for", async () => {
    const units = await extractAll(db, {
      glossaryVersion: 1,
      only: ["SIGN"],
      ids: [signId],
    });
    expect(units.map((unit) => unit.entityId)).toEqual([signId]);
  });

  it("extractSigns issues a WHERE id IN", async () => {
    const spy = vi.spyOn(db.sign, "findMany");
    try {
      const units = await extractAll(db, {
        glossaryVersion: 1,
        only: ["SIGN"],
        ids: ["nope"],
      });
      expect(units).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as {
        where?: { id?: { in?: string[] } };
      };
      expect(arg.where?.id?.in).toEqual(["nope"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("extractKbSources issues a WHERE code IN", async () => {
    const spy = vi.spyOn(db.kbSource, "findMany");
    try {
      const units = await extractAll(db, {
        glossaryVersion: 1,
        only: ["KB_SOURCE"],
        ids: ["nope"],
      });
      expect(units).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as {
        where?: { code?: { in?: string[] }; id?: unknown };
      };
      expect(arg.where?.code?.in).toEqual(["nope"]);
      expect(arg.where?.id).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("extractMasterItems issues a WHERE id IN and keeps the status/deletedAt guard", async () => {
    const spy = vi.spyOn(db.masterItem, "findMany");
    try {
      const units = await extractAll(db, {
        glossaryVersion: 1,
        only: ["MASTER_ITEM"],
        ids: ["nope"],
      });
      expect(units).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as {
        where?: {
          id?: { in?: string[] };
          status?: unknown;
          deletedAt?: unknown;
        };
      };
      expect(arg.where?.id?.in).toEqual(["nope"]);
      expect(arg.where?.status).toBe("APPROVED");
      expect(arg.where?.deletedAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("extractLicenseClasses issues a WHERE id IN", async () => {
    const spy = vi.spyOn(db.licenseClass, "findMany");
    try {
      const units = await extractAll(db, {
        glossaryVersion: 1,
        only: ["LICENSE_CLASS"],
        ids: ["nope"],
      });
      expect(units).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as {
        where?: { id?: { in?: string[] } };
      };
      expect(arg.where?.id?.in).toEqual(["nope"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("extractMessages honours ids", async () => {
    const all = await extractAll(db, {
      glossaryVersion: 1,
      only: ["UI_MESSAGE"],
    });
    expect(all.length).toBeGreaterThanOrEqual(2);
    const [k1, k2] = all.map((unit) => unit.entityId);
    const filtered = await extractAll(db, {
      glossaryVersion: 1,
      only: ["UI_MESSAGE"],
      ids: [k1, k2],
    });
    expect(filtered.map((unit) => unit.entityId).sort()).toEqual(
      [k1, k2].sort(),
    );
  });

  it("without ids is unchanged (superset of the fixtures)", async () => {
    const units = await extractAll(db, { glossaryVersion: 1, only: ["TOPIC"] });
    const ids = new Set(units.map((unit) => unit.entityId));
    for (const id of topicIds) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

// No DB needed — runs even without TEST_DATABASE_URL.
describe("extractMessages", () => {
  it("filters keys in-process when called directly", () => {
    const all = extractMessages(1);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const [k1, k2] = all.map((unit) => unit.entityId);
    const filtered = extractMessages(1, [k1, k2]);
    expect(filtered.map((unit) => unit.entityId).sort()).toEqual(
      [k1, k2].sort(),
    );
  });
});
