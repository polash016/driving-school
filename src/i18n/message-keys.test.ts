import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./messages/en.json";
import nb from "./messages/nb.json";

/**
 * Message keys that travel as data (typed errors, CSV row outcomes) escape next-intl's
 * compile-time key checking — the UI renders them with `t(state.messageKey)` at runtime.
 * This resolves every such literal in the server tree against BOTH catalogues, so a typo or a
 * pruned key surfaces here instead of as raw "auth.errors.x" text in front of a student.
 */
const SEARCH_ROOTS = [join(process.cwd(), "src", "server")];
const KEY_PATTERN = /"((?:errors|auth\.errors|admin\.invites)\.[a-zA-Z0-9.]+)"/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function resolve(messages: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      messages,
    );
}

const references = new Map<string, string[]>();
for (const root of SEARCH_ROOTS) {
  for (const file of walk(root).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
    const source = readFileSync(file, "utf8");
    for (const [, key] of source.matchAll(KEY_PATTERN)) {
      references.set(key, [...(references.get(key) ?? []), relative(process.cwd(), file)]);
    }
  }
}

describe("runtime message keys", () => {
  it("finds the keys that services hand to the UI (the scan is not vacuous)", () => {
    expect(references.size).toBeGreaterThan(10);
    expect([...references.keys()]).toContain("auth.errors.invalidCredentials");
  });

  it.each([
    ["en", en],
    ["nb", nb],
  ])("resolves every referenced key in %s", (_locale, messages) => {
    const missing = [...references.entries()]
      .filter(([key]) => typeof resolve(messages as Record<string, unknown>, key) !== "string")
      .map(([key, files]) => `${key} (${files.join(", ")})`);

    expect(missing).toEqual([]);
  });
});
