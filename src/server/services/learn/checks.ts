import type { PrismaClient } from "@prisma/client";
import { ValidationError } from "@/lib/errors";

/** Existence checks shared by books and documents: an id a form sends must still be live. */

export async function assertImageExists(db: PrismaClient, imageId: string): Promise<void> {
  const image = await db.imageAsset.findFirst({ where: { id: imageId, deletedAt: null }, select: { id: true } });
  if (!image) throw new ValidationError({ imageId }, "admin.learn.errors.imageMissing");
}

export async function assertImagesExist(db: PrismaClient, imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const rows = await db.imageAsset.findMany({
    where: { id: { in: imageIds }, deletedAt: null },
    select: { id: true },
  });
  const found = new Set(rows.map((row) => row.id));
  const missing = imageIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new ValidationError({ missing }, "admin.learn.errors.imageMissing");
}

export async function assertLicenseClass(db: PrismaClient, licenseClassId: string): Promise<void> {
  const row = await db.licenseClass.findUnique({ where: { id: licenseClassId }, select: { id: true } });
  if (!row) throw new ValidationError({ licenseClassId }, "admin.learn.errors.licenseClassMissing");
}

export async function assertTopic(db: PrismaClient, topicId: string): Promise<void> {
  const row = await db.topic.findFirst({ where: { id: topicId, deletedAt: null }, select: { id: true } });
  if (!row) throw new ValidationError({ topicId }, "admin.learn.errors.topicMissing");
}

export async function assertSourcesExist(db: PrismaClient, sourceCodes: string[]): Promise<void> {
  const unique = [...new Set(sourceCodes)];
  if (unique.length === 0) return;
  const rows = await db.kbSource.findMany({
    where: { code: { in: unique }, deletedAt: null },
    select: { code: true },
  });
  const found = new Set(rows.map((row) => row.code));
  const unknown = unique.filter((code) => !found.has(code));
  if (unknown.length > 0) throw new ValidationError({ unknown }, "admin.learn.errors.unknownSource");
}
