import { describe, expect, it } from "vitest";
import en from "./messages/en.json";
import nb from "./messages/nb.json";

/**
 * Mandate 4 guard: both locales must always carry the exact same message keys,
 * and no message may be empty. Adding a key to one file only fails CI.
 */
function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      return flattenKeys(value as Record<string, unknown>, path);
    }
    return [path];
  });
}

function flattenEntries(
  obj: Record<string, unknown>,
  prefix = "",
): Array<[string, unknown]> {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      return flattenEntries(value as Record<string, unknown>, path);
    }
    return [[path, value]] as Array<[string, unknown]>;
  });
}

describe("i18n messages", () => {
  it("en and nb have identical key sets", () => {
    expect(flattenKeys(nb).sort()).toEqual(flattenKeys(en).sort());
  });

  it.each([
    ["en", en],
    ["nb", nb],
  ])("%s has no empty or non-string messages", (_locale, messages) => {
    for (const [path, value] of flattenEntries(messages)) {
      expect(typeof value, path).toBe("string");
      expect((value as string).trim().length, path).toBeGreaterThan(0);
    }
  });
});
