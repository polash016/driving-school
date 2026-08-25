import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The local storage driver, and the traversal guard in particular.
 *
 * Keys are generated internally today, so the guard protects against a future caller rather than
 * a current one — which is exactly the kind of check that quietly stops being true unless a test
 * holds it in place.
 */
const root = await mkdtemp(join(tmpdir(), "teoripro-storage-"));

vi.mock("../../../config/school.config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/school.config")>();
  return {
    ...actual,
    schoolConfig: {
      ...actual.schoolConfig,
      storage: { ...actual.schoolConfig.storage, localDir: root },
    },
  };
});

const { localDriver } = await import("./local");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local storage driver", () => {
  const driver = localDriver();
  const key = "images/2026/08/abc123.png";
  const bytes = Buffer.from("not-really-a-png");

  it("round-trips an object and reports its content type from the key", async () => {
    await driver.put(key, bytes, "image/png");
    expect(await driver.exists(key)).toBe(true);

    const stored = await driver.get(key);
    expect(stored.body.equals(bytes)).toBe(true);
    expect(stored.contentType).toBe("image/png");
    expect(stored.contentLength).toBe(bytes.byteLength);
  });

  it("writes beneath the configured root, never inside public/", async () => {
    expect((await readFile(join(root, key))).equals(bytes)).toBe(true);
  });

  it("streams the same bytes it stored", async () => {
    const { body, contentLength } = await driver.stream(key);
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>)
      chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(contentLength).toBe(bytes.byteLength);
  });

  it("deletes, and reports a missing object rather than throwing", async () => {
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    await expect(driver.delete(key)).resolves.toBeUndefined();
  });

  it("refuses a key that climbs out of the storage root", async () => {
    for (const escape of [
      "../escaped.png",
      "images/../../escaped.png",
      "a/../../b.png",
    ]) {
      await expect(driver.put(escape, bytes, "image/png")).rejects.toThrow(
        /outside the storage root/,
      );
      await expect(driver.get(escape)).rejects.toThrow(
        /outside the storage root/,
      );
    }
  });

  it("allows a key that only looks like traversal but stays inside", async () => {
    await driver.put("images/a/../b.png", bytes, "image/png");
    expect(await driver.exists("images/b.png")).toBe(true);
  });
});
