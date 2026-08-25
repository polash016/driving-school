import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { schoolConfig } from "../../../config/school.config";
import type { StorageDriver, StoredObject } from "./types";

/**
 * Filesystem driver — the default, and what a single-school VPS deployment runs.
 *
 * The directory lives OUTSIDE `public/` on purpose: anything under `public/` is served by Next as a
 * static asset with no auth, which would hand every exam image to anyone who guessed a filename.
 *
 * Spec-14 must back this directory up alongside Postgres; the rows and the bytes are one dataset.
 */

/** Content type is not stored on disk, so it is recovered from the extension the key carries. */
const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function root(): string {
  const configured = schoolConfig.storage.localDir;
  if (isAbsolute(configured)) return configured;
  // turbopackIgnore: the directory is chosen at RUNTIME from config and is not a build input.
  // Without this, static analysis treats it as one and traces the entire project — `public/`
  // included, which is several megabytes of sign graphics — into the server bundle.
  return resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

/**
 * Resolve a key to a path, refusing anything that escapes the root.
 *
 * Keys are generated internally today, but this is the one place a traversal would turn into
 * arbitrary filesystem read/write, so it is checked here rather than trusted upstream.
 */
function pathFor(key: string): string {
  const base = root();
  const full = normalize(join(base, key));
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Refusing storage key outside the storage root: ${key}`);
  }
  return full;
}

function contentTypeFor(key: string): string {
  return (
    TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ??
    "application/octet-stream"
  );
}

export function localDriver(): StorageDriver {
  return {
    name: "local",

    // Content type is recovered from the key's extension on read, so it is not stored separately.
    async put(key, body) {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
    },

    async get(key): Promise<StoredObject> {
      const full = pathFor(key);
      const body = await readFile(full);
      return {
        body,
        contentType: contentTypeFor(key),
        contentLength: body.byteLength,
      };
    },

    async stream(key) {
      const full = pathFor(key);
      const { size } = await stat(full);
      return {
        body: Readable.toWeb(
          createReadStream(full),
        ) as ReadableStream<Uint8Array>,
        contentType: contentTypeFor(key),
        contentLength: size,
      };
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },

    async exists(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}
