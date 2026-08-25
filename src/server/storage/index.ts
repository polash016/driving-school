import { schoolConfig } from "../../../config/school.config";
import type { StorageDriver } from "./types";
import { localDriver } from "./local";
import { s3Driver } from "./s3";

/**
 * Object storage behind one port (spec-06 amendment D3, DECISIONS 2026-08-24).
 *
 * Two rules this module exists to enforce:
 *
 *  1. **The driver is configuration, not code.** A school starts on a VPS directory and moves to
 *     S3-compatible object storage by changing `storage.driver` — no call site changes.
 *  2. **Bytes are never reachable from a public URL.** The local directory sits outside `public/`
 *     and buckets stay private; everything is served through `/api/images/[id]`, which requires a
 *     session. That route is where spec-12 hangs signed short-TTL URLs and watermarking, so there
 *     must be exactly one way in.
 *
 * Keys are namespaced `images/{yyyy}/{mm}/{id}.{ext}` so a directory listing stays navigable and a
 * bucket lifecycle rule can act on a date prefix.
 */
export type { StorageDriver, StoredObject } from "./types";

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (driver) return driver;
  driver = schoolConfig.storage.driver === "s3" ? s3Driver() : localDriver();
  return driver;
}

/** Test seam: swap the driver, e.g. for an in-memory fake. Returns the previous one. */
export function setStorageDriver(
  next: StorageDriver | null,
): StorageDriver | null {
  const previous = driver;
  driver = next;
  return previous;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extensionFor(contentType: string): string {
  const extension = EXTENSIONS[contentType];
  if (!extension) throw new Error(`Unsupported content type: ${contentType}`);
  return extension;
}

/**
 * The storage key for an image. `at` is injected rather than read from the clock so the key a test
 * asserts on is the key it asked for.
 */
export function imageKey(
  id: string,
  contentType: string,
  at: Date = new Date(),
): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `images/${year}/${month}/${id}.${extensionFor(contentType)}`;
}
