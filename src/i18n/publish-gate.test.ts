import { describe, expect, it } from "vitest";
import type { LanguageSnapshot } from "./builtin";
import { unpublishedLanguageRedirect } from "./publish-gate";

/**
 * An unfinished language is staff-only (spec-20, developer decision 2026-09-12).
 *
 * The switcher already hides a language until it is 100% translated, but `/xx` routed for
 * everyone, so a bookmarked or guessed URL showed a student a half-English site. Students and
 * anonymous visitors now land on the same path under the language's fallback; the people who
 * review the language keep the preview.
 */
function language(overrides: Partial<LanguageSnapshot> = {}): LanguageSnapshot {
  return {
    code: "qa",
    englishName: "QA",
    nativeName: "QA",
    shortLabel: "QA",
    urlPrefix: "/qa",
    direction: "LTR",
    isBuiltIn: false,
    requiresApproval: false,
    studentVisible: false,
    fallbackCode: "en",
    sortOrder: 5,
    ...overrides,
  };
}

describe("unpublishedLanguageRedirect", () => {
  it("sends a student to the same page under the fallback language", () => {
    expect(
      unpublishedLanguageRedirect({
        language: language(),
        role: "STUDENT",
        pathname: "/qa/quiz/new",
      }),
    ).toEqual({ href: "/quiz/new", locale: "en" });
  });

  it("sends an anonymous visitor there too, and to the home page when the path is unknown", () => {
    expect(
      unpublishedLanguageRedirect({
        language: language(),
        role: null,
        pathname: "/qa",
      }),
    ).toEqual({ href: "/", locale: "en" });
    expect(
      unpublishedLanguageRedirect({
        language: language(),
        role: null,
        pathname: null,
      }),
    ).toEqual({ href: "/", locale: "en" });
  });

  it("keeps the preview for the people who review the language", () => {
    for (const role of ["INSTRUCTOR", "ADMIN"] as const) {
      expect(
        unpublishedLanguageRedirect({
          language: language(),
          role,
          pathname: "/qa/admin",
        }),
      ).toBeNull();
    }
  });

  it("never touches a published or built-in language, or one the registry does not know", () => {
    expect(
      unpublishedLanguageRedirect({
        language: language({ studentVisible: true }),
        role: null,
        pathname: "/qa",
      }),
    ).toBeNull();
    expect(
      unpublishedLanguageRedirect({
        language: language({ code: "en", urlPrefix: "/en", isBuiltIn: true }),
        role: null,
        pathname: "/en",
      }),
    ).toBeNull();
    expect(
      unpublishedLanguageRedirect({
        language: undefined,
        role: null,
        pathname: "/zz",
      }),
    ).toBeNull();
  });

  it("strips only the language's own prefix, never a longer one that merely starts with it", () => {
    expect(
      unpublishedLanguageRedirect({
        language: language(),
        role: null,
        pathname: "/qa-old/quiz",
      }),
    ).toEqual({ href: "/", locale: "en" });
  });

  it("follows the language's configured fallback", () => {
    expect(
      unpublishedLanguageRedirect({
        language: language({ fallbackCode: "nb" }),
        role: "STUDENT",
        pathname: "/qa/account/history",
      }),
    ).toEqual({ href: "/account/history", locale: "nb" });
  });
});
