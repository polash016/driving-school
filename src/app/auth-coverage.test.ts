import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Spec-03 acceptance: "All protected server actions/routes verifiably pass through
 * authorize()". This walks the App Router tree instead of trusting review:
 *
 *  - every layout/page in a protected route group is covered by `requireUser()`
 *    (which is the only caller of `authorize()` in Next code),
 *  - every exported server action calls `requireUser()` unless its file is explicitly
 *    listed below as public (the login/registration flows — the way in),
 *  - no app-layer file calls `authorize()` directly, so the chokepoint stays single.
 *
 * Spec-12 replaces this with the full route manifest.
 */
const APP_DIR = join(process.cwd(), "src", "app");
const PROTECTED_GROUPS = ["(admin)", "(account)"];

/** Public by design: these are the unauthenticated entry points. */
const PUBLIC_ACTION_FILES = new Set([
  join("src", "app", "[locale]", "(auth)", "actions.ts"),
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return [full];
  });
}

const files = walk(APP_DIR);
const rel = (file: string) => relative(process.cwd(), file);
const read = (file: string) => readFileSync(file, "utf8");

const inProtectedGroup = (file: string) =>
  PROTECTED_GROUPS.some((group) => file.includes(`${group}/`));

describe("app router auth coverage", () => {
  it("covers every page and layout in a protected route group", () => {
    const uncovered = files
      .filter(
        (file) => /\/(page|layout)\.tsx$/.test(file) && inProtectedGroup(file),
      )
      .filter((file) => {
        if (read(file).includes("requireUser(")) return false;
        // A page may rely on its group's layout instead of repeating the call.
        const group = PROTECTED_GROUPS.find((g) => file.includes(`${g}/`))!;
        const layout = `${file.slice(0, file.indexOf(group) + group.length)}/layout.tsx`;
        return (
          !files.includes(layout) || !read(layout).includes("requireUser(")
        );
      })
      .map(rel);

    expect(uncovered).toEqual([]);
  });

  it("has at least one protected group wired up (the walk is not vacuous)", () => {
    const protectedLayouts = files.filter(
      (file) => file.endsWith("layout.tsx") && inProtectedGroup(file),
    );
    expect(protectedLayouts.length).toBeGreaterThan(0);
  });

  it("calls requireUser() in every exported server action outside the public entry points", () => {
    const offenders: string[] = [];

    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const source = read(file);
      if (!source.includes('"use server"')) continue;
      if (PUBLIC_ACTION_FILES.has(rel(file))) continue;

      for (const match of source.matchAll(/export async function (\w+)/g)) {
        const body = source.slice(match.index);
        const end = body.indexOf("\nexport async function", 1);
        const fnSource = end === -1 ? body : body.slice(0, end);
        if (!fnSource.includes("requireUser(")) {
          offenders.push(`${rel(file)}#${match[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps every public action file inside the (auth) group", () => {
    for (const file of PUBLIC_ACTION_FILES) {
      expect(file).toContain("(auth)");
      expect(files.map(rel)).toContain(file);
    }
  });

  it("never calls authorize() directly from the app layer", () => {
    const direct = files
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
      .filter((file) => /\bauthorize\(/.test(read(file)))
      .map(rel);

    expect(direct).toEqual([]);
  });
});
