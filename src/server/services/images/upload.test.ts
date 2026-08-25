import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  hammingDistance,
  isPerceptualDuplicate,
  perceptualHash,
  sniffContentType,
} from "./upload";

/**
 * The two things an uploaded image must not be allowed to be: something other than an image, and
 * a carrier for the photographer's GPS coordinates.
 */
async function png(width = 64, height = 64, tint = 0): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: tint, g: 128, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

describe("content-type sniffing", () => {
  it("recognises the formats the contract allows", async () => {
    expect(sniffContentType(await png())).toBe("image/png");
    expect(
      sniffContentType(
        await sharp({
          create: { width: 32, height: 32, channels: 3, background: "red" },
        })
          .jpeg()
          .toBuffer(),
      ),
    ).toBe("image/jpeg");
    expect(
      sniffContentType(
        await sharp({
          create: { width: 32, height: 32, channels: 3, background: "red" },
        })
          .webp()
          .toBuffer(),
      ),
    ).toBe("image/webp");
  });

  it("rejects a script that merely calls itself a png", () => {
    // The exact attack the sniff exists for: the filename and the declared multipart content type
    // are both attacker-controlled, so neither can be the thing that decides.
    expect(sniffContentType(Buffer.from("#!/bin/sh\nrm -rf /\n"))).toBeNull();
    expect(
      sniffContentType(Buffer.from("<?php system($_GET['c']); ?>")),
    ).toBeNull();
    expect(sniffContentType(Buffer.from("GIF89a" + "x".repeat(20)))).toBeNull();
  });

  it("rejects a buffer too short to identify", () => {
    expect(sniffContentType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe("EXIF stripping", () => {
  it("drops GPS metadata when the image is re-encoded", async () => {
    const withGps = await sharp(await png())
      // sharp exposes the GPS IFD as IFD3; this is a phone photo's location, the thing that must
      // never travel with a question into the student-facing library.
      .withExif({
        IFD0: { Copyright: "school" },
        IFD3: { GPSLatitudeRef: "N" },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    // This is the same operation uploadImage performs; re-encoding is what removes the metadata.
    const cleaned = await sharp(withGps)
      .rotate()
      .jpeg({ quality: 88 })
      .toBuffer();
    expect((await sharp(cleaned).metadata()).exif).toBeUndefined();
  });
});

describe("perceptual hash", () => {
  it("is a stable 16-character hex fingerprint", async () => {
    const hash = await perceptualHash(await png());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await perceptualHash(await png())).toBe(hash);
  });

  it("recognises a re-encoded, resized copy as the same picture", async () => {
    const original = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "white" },
    })
      .composite([{ input: await png(80, 80, 10), top: 20, left: 20 }])
      .png()
      .toBuffer();

    const recompressed = await sharp(original)
      .resize(150, 150)
      .jpeg({ quality: 70 })
      .toBuffer();

    // NOT bit-identical, and it is not meant to be: a couple of comparisons fall the other side
    // of the line after recompression. Proximity is the whole mechanism.
    const before = await perceptualHash(original);
    const after = await perceptualHash(recompressed);
    expect(hammingDistance(before, after)).toBeLessThanOrEqual(5);
    expect(isPerceptualDuplicate(before, after)).toBe(true);
  });

  it("differs for structurally different pictures", async () => {
    const left = await sharp({
      create: { width: 120, height: 120, channels: 3, background: "white" },
    })
      .composite([{ input: await png(40, 40, 0), top: 10, left: 5 }])
      .png()
      .toBuffer();
    const right = await sharp({
      create: { width: 120, height: 120, channels: 3, background: "white" },
    })
      .composite([{ input: await png(40, 40, 0), top: 70, left: 70 }])
      .png()
      .toBuffer();

    const a = await perceptualHash(left);
    const b = await perceptualHash(right);
    expect(a).not.toBe(b);
    expect(isPerceptualDuplicate(a, b)).toBe(false);
  });

  it("measures Hamming distance over the full 64 bits, leading zeros included", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingDistance("0000000000000000", "00000000000000ff")).toBe(8);
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });
});
