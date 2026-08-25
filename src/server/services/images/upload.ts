import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import { schoolConfig } from "../../../../config/school.config";
import { ValidationError } from "@/lib/errors";
import { imageKey } from "@/server/storage";
import type { StorageDriver } from "@/server/storage";

/**
 * Turning an uploaded file into an ImageAsset (spec-06).
 *
 * Everything here exists because an uploaded image is hostile input twice over — as a file, and as
 * a photograph:
 *
 *  - **Sniff, never trust the name.** `image/png` in a multipart part is whatever the client typed.
 *    The magic bytes decide, so a script renamed `.png` is refused before `sharp` touches it.
 *  - **Re-encode to strip EXIF.** Norwegian traffic photos are taken on phones, which stamp GPS
 *    coordinates into them. Publishing an instructor's home address alongside a question is a data
 *    breach, not a formatting flaw. Re-encoding drops all metadata; nothing is copied through.
 *  - **Cap the dimensions.** A 48MP phone photo is 20× the pixels a 390px question card can show
 *    and would blow the smoothness budget on every exam that served it.
 *  - **Perceptual hash.** The same sign photographed twice produces near-identical files with
 *    different checksums; a dHash catches the re-upload that a byte comparison misses.
 */

/** Magic-byte signatures for the formats the contract allows. */
const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  {
    type: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: "image/png",
    test: (b) =>
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: "image/webp",
    test: (b) =>
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

export function sniffContentType(bytes: Buffer): string | null {
  return (
    SIGNATURES.find((s) => bytes.length >= 12 && s.test(bytes))?.type ?? null
  );
}

/** Longest edge after normalisation. Well above what any student screen renders. */
const MAX_DIMENSION = 2048;
/** dHash grid: 8x8 comparisons from a 9x8 greyscale reduction → a 64-bit fingerprint. */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/**
 * Difference hash. Rows of a tiny greyscale copy are compared left-to-right, so the fingerprint
 * follows the image's structure and survives re-compression, resizing and mild colour shifts —
 * which is exactly the difference between this and a checksum.
 */
export async function perceptualHash(bytes: Buffer): Promise<string> {
  const pixels = await sharp(bytes)
    .greyscale()
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer();

  let bits = "";
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let column = 0; column < HASH_WIDTH - 1; column++) {
      const left = pixels[row * HASH_WIDTH + column];
      const right = pixels[row * HASH_WIDTH + column + 1];
      bits += left > right ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

/**
 * How many of the 64 bits may differ and the pictures still count as the same one.
 *
 * A perceptual hash is deliberately NOT stable to the bit: re-encoding a photo moves a couple of
 * comparisons either side of the line. Matching on hash equality would therefore catch only a
 * byte-identical re-upload — which a checksum already does — and miss the case this exists for,
 * the same photo saved again at a different quality. Five is the conventional dHash threshold:
 * high enough to survive recompression, low enough that different photographs do not collide.
 */
const DUPLICATE_DISTANCE = 5;

/** Set bits per hex digit, so the comparison stays in plain numbers. */
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * Number of differing bits between two 64-bit hex fingerprints.
 *
 * Compared a nibble at a time rather than as one integer: 64 bits does not fit in a JS number,
 * and BigInt literals are past this project's compile target.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error("fingerprints differ in length");
  let bits = 0;
  for (let index = 0; index < a.length; index++) {
    bits += POPCOUNT[parseInt(a[index], 16) ^ parseInt(b[index], 16)];
  }
  return bits;
}

export function isPerceptualDuplicate(a: string, b: string): boolean {
  return hammingDistance(a, b) <= DUPLICATE_DISTANCE;
}

export type UploadInput = {
  filename: string;
  bytes: Buffer;
};

export type UploadResult = {
  id: string;
  url: string;
  width: number;
  height: number;
  /** An existing asset with the same fingerprint. A warning for the admin, never a hard block. */
  duplicateOfId: string | null;
};

export async function uploadImage(
  db: PrismaClient,
  storage: StorageDriver,
  input: UploadInput,
  uploadedById: string,
  now: Date = new Date(),
): Promise<UploadResult> {
  const { maxUploadBytes } = schoolConfig.storage;
  if (input.bytes.byteLength === 0) {
    throw new ValidationError({
      reason: "empty file",
      filename: input.filename,
    });
  }
  if (input.bytes.byteLength > maxUploadBytes) {
    throw new ValidationError({
      reason: "file too large",
      filename: input.filename,
      maxUploadBytes,
    });
  }

  const contentType = sniffContentType(input.bytes);
  if (!contentType) {
    throw new ValidationError({
      reason: "not a jpeg, png or webp",
      filename: input.filename,
    });
  }

  // `rotate()` with no argument applies the EXIF orientation before that data is discarded —
  // without it, phone photos taken sideways would be stored sideways.
  const pipeline = sharp(input.bytes, { failOn: "error" })
    .rotate()
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    });

  const normalised =
    contentType === "image/png"
      ? await pipeline
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
      : contentType === "image/webp"
        ? await pipeline
            .webp({ quality: 88 })
            .toBuffer({ resolveWithObject: true })
        : await pipeline
            .jpeg({ quality: 88, mozjpeg: true })
            .toBuffer({ resolveWithObject: true });

  const { data, info } = normalised;
  const hash = await perceptualHash(data);

  // Near-duplicates cannot be found by an indexed equality lookup, so the candidate fingerprints
  // are compared in memory. That is affordable because this is ONE deployment's image library —
  // hundreds to a few thousand rows of two small columns — not a global corpus. If a school ever
  // outgrows it, the fix is a BK-tree or a bit-sliced index, not a silent downgrade to equality.
  const fingerprints = await db.imageAsset.findMany({
    where: { deletedAt: null, perceptualHash: { not: null } },
    select: { id: true, perceptualHash: true },
  });
  const duplicate = fingerprints.find(
    (candidate) =>
      candidate.perceptualHash &&
      isPerceptualDuplicate(candidate.perceptualHash, hash),
  );

  // The row is created first so its id can name the object; a failed upload then leaves an orphan
  // row rather than an unreferenced blob, and the row is the one of the two we can clean up.
  const asset = await db.imageAsset.create({
    data: {
      url: "",
      storagePath: "",
      status: "UPLOADED",
      perceptualHash: hash,
      width: info.width,
      height: info.height,
      exifStripped: true,
      uploadedById,
    },
    select: { id: true },
  });

  const key = imageKey(asset.id, contentType, now);
  await storage.put(key, data, contentType);

  await db.imageAsset.update({
    where: { id: asset.id },
    data: { storagePath: key, url: `/api/images/${asset.id}` },
    select: { id: true },
  });

  return {
    id: asset.id,
    url: `/api/images/${asset.id}`,
    width: info.width,
    height: info.height,
    duplicateOfId: duplicate?.id ?? null,
  };
}
