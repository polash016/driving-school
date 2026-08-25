import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { db } from "@/server/db";
import { localDriver } from "@/server/storage/local";
import { uploadImage } from "./upload";

/**
 * The upload path against a real database and a real filesystem (spec-06).
 *
 * The unit tests cover sniffing and hashing in isolation; what this adds is the part that can only
 * be wrong end-to-end — that the row, the bytes and the serving URL all agree, and that a rejected
 * file leaves nothing behind.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomBytes(3).toString("hex");
const EMAIL = `opplaster-${RUN}@example.no`;
let userId = "";
let root = "";
const created: string[] = [];

async function photo(
  width: number,
  height: number,
  tint: number,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: tint, g: 90, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();
}

beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(join(tmpdir(), "teoripro-upload-"));
  const user = await db.user.create({
    data: { email: EMAIL, role: "INSTRUCTOR", emailVerifiedAt: new Date() },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(async () => {
  if (!enabled) return;
  await db.imageAsset.deleteMany({ where: { id: { in: created } } });
  await db.user.deleteMany({ where: { id: userId } });
  await rm(root, { recursive: true, force: true });
  await db.$disconnect();
});

d("uploadImage", () => {
  it("stores the bytes, records the row, and serves through the authenticated route", async () => {
    const driver = localDriver();
    // The driver reads its root from config, so the test writes where config points; the storage
    // unit test covers the configured-directory case.
    const result = await uploadImage(
      db,
      driver,
      { filename: "kryss.jpg", bytes: await photo(300, 200, 10) },
      userId,
      new Date("2026-08-25T00:00:00Z"),
    );
    created.push(result.id);

    expect(result.url).toBe(`/api/images/${result.id}`);
    expect(result.duplicateOfId).toBeNull();

    const row = await db.imageAsset.findUniqueOrThrow({
      where: { id: result.id },
      select: {
        storagePath: true,
        url: true,
        exifStripped: true,
        width: true,
        height: true,
        perceptualHash: true,
      },
    });
    // Key namespacing keeps a directory listing navigable and lets a bucket lifecycle rule act on
    // a date prefix.
    expect(row.storagePath).toBe(`images/2026/08/${result.id}.jpg`);
    expect(row.url).toBe(`/api/images/${result.id}`);
    expect(row.exifStripped).toBe(true);
    expect(row.width).toBe(300);
    expect(row.height).toBe(200);
    expect(row.perceptualHash).toMatch(/^[0-9a-f]{16}$/);

    // The bytes are really there, and really outside `public/`.
    expect(await driver.exists(row.storagePath)).toBe(true);
    expect(row.storagePath.startsWith("public/")).toBe(false);
  });

  it("caps an oversized photograph instead of storing 48 megapixels", async () => {
    const driver = localDriver();
    const result = await uploadImage(
      db,
      driver,
      { filename: "stor.jpg", bytes: await photo(4000, 3000, 20) },
      userId,
    );
    created.push(result.id);
    expect(Math.max(result.width, result.height)).toBe(2048);
  });

  it("flags a re-encoded copy as a duplicate without blocking it", async () => {
    const driver = localDriver();
    const original = await sharp({
      create: { width: 400, height: 400, channels: 3, background: "white" },
    })
      .composite([{ input: await photo(160, 160, 30), top: 40, left: 40 }])
      .jpeg({ quality: 95 })
      .toBuffer();

    const first = await uploadImage(
      db,
      driver,
      { filename: "a.jpg", bytes: original },
      userId,
    );
    created.push(first.id);

    // Same photograph, saved again at a different quality and size — a checksum would miss this.
    const again = await sharp(original)
      .resize(300, 300)
      .jpeg({ quality: 60 })
      .toBuffer();
    const second = await uploadImage(
      db,
      driver,
      { filename: "b.jpg", bytes: again },
      userId,
    );
    created.push(second.id);

    expect(second.duplicateOfId).toBe(first.id);
    // A warning, never a hard block: two similar photos of the same junction are legitimate.
    expect(
      await db.imageAsset.count({
        where: { id: { in: [first.id, second.id] } },
      }),
    ).toBe(2);
  });

  it("refuses a script wearing a .png extension, and writes no row for it", async () => {
    const driver = localDriver();
    const before = await db.imageAsset.count();
    await expect(
      uploadImage(
        db,
        driver,
        { filename: "innocent.png", bytes: Buffer.from("#!/bin/sh\nrm -rf /") },
        userId,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.imageAsset.count()).toBe(before);
  });

  it("refuses an empty file", async () => {
    await expect(
      uploadImage(
        db,
        localDriver(),
        { filename: "tom.jpg", bytes: Buffer.alloc(0) },
        userId,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
