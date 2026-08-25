import { describe, expect, it } from "vitest";
import { BASE_MESSAGES } from "@/i18n/builtin";
import {
  BUILTIN_PREFIXES,
  isBuiltinLocale,
  localeSchema,
  prefixForLocale,
} from "@/lib/locale";
import { absoluteUrl, localePath, primeLocalePrefixes } from "@/lib/locale-url";
import {
  contentSideFor,
  pickBilingualText,
  pickLocale,
  resolveText,
} from "@/lib/i18n-content";
import {
  baseMessageKeys,
  expandMessages,
  flattenMessages,
  mergeMessages,
} from "./catalogue";
import { BUILTIN_REGISTRY, resolveLocale } from "./registry";

/**
 * The language layer, unit level (spec-15). The parts that must hold with no database, no Redis
 * and no network — because that is precisely when a school still needs the site to work.
 */

describe("locale codes", () => {
  it.each(["en", "nb", "es", "ar", "pt-BR", "zh-Hans"])(
    "accepts %s",
    (code) => {
      expect(localeSchema.safeParse(code).success).toBe(true);
    },
  );

  it.each(["", "e", "EN", "english!", "en_US", "../etc/passwd"])(
    "rejects %s",
    (code) => {
      expect(localeSchema.safeParse(code).success).toBe(false);
    },
  );

  it("serves a runtime language at /<code>, and Norwegian at its grandfathered /no", () => {
    expect(prefixForLocale("es")).toBe("/es");
    expect(prefixForLocale("nb")).toBe("/no");
    expect(prefixForLocale("en")).toBe("/en");
  });

  it("knows which languages are compiled in", () => {
    expect(isBuiltinLocale("en")).toBe(true);
    expect(isBuiltinLocale("nb")).toBe(true);
    expect(isBuiltinLocale("es")).toBe(false);
  });
});

describe("the compiled registry — what survives a total outage", () => {
  it("still routes English and Norwegian", () => {
    expect(BUILTIN_REGISTRY.has("en")).toBe(true);
    expect(BUILTIN_REGISTRY.has("nb")).toBe(true);
    expect(BUILTIN_REGISTRY.defaultLocale).toBe("en");
    expect(BUILTIN_REGISTRY.prefixes).toMatchObject(BUILTIN_PREFIXES);
  });

  it("does not know about runtime languages", () => {
    expect(BUILTIN_REGISTRY.has("es")).toBe(false);
  });

  it("falls back rather than throwing on an unknown locale", () => {
    expect(resolveLocale(BUILTIN_REGISTRY, "es")).toBe("en");
    expect(resolveLocale(BUILTIN_REGISTRY, undefined)).toBe("en");
    expect(resolveLocale(BUILTIN_REGISTRY, "../admin")).toBe("en");
    expect(resolveLocale(BUILTIN_REGISTRY, "nb")).toBe("nb");
  });

  it("reports text direction, defaulting to left-to-right", () => {
    expect(BUILTIN_REGISTRY.directionOf("en")).toBe("ltr");
    expect(BUILTIN_REGISTRY.directionOf("es")).toBe("ltr");
  });
});

describe("URL prefixes stay synchronous", () => {
  it("builds links for a language the registry learned about later", () => {
    expect(localePath("es", "/login")).toBe("/es/login");
    primeLocalePrefixes({ es: "/es", ar: "/ar" });
    expect(localePath("ar", "/login")).toBe("/ar/login");
    expect(absoluteUrl("https://x.no/", "nb", "/login")).toBe(
      "https://x.no/no/login",
    );
  });
});

describe("message catalogues", () => {
  it("round-trips between nested and flat form", () => {
    const flat = flattenMessages(BASE_MESSAGES as Record<string, unknown>);
    expect(flat["auth.errors.invalidCredentials"]).toBeTypeOf("string");
    expect(expandMessages(flat)).toEqual(BASE_MESSAGES);
  });

  it("merges a partial translation over English without losing a key", () => {
    const base = { a: { b: "english b", c: "english c" }, d: "english d" };
    const merged = mergeMessages(base, { a: { b: "spansk b" } });
    expect(merged).toEqual({
      a: { b: "spansk b", c: "english c" },
      d: "english d",
    });
  });

  it("never mutates the English catalogue it merges onto", () => {
    const base = { a: { b: "english" } };
    mergeMessages(base, { a: { b: "otro" } });
    expect(base).toEqual({ a: { b: "english" } });
  });

  it("counts every key the UI can ask for — the coverage denominator", () => {
    const count = baseMessageKeys().length;
    expect(count).toBeGreaterThan(400);
    expect(baseMessageKeys()).toContain("quiz.errors.answerLocked");
  });
});

describe("content fallback", () => {
  it("falls back to English, never to Norwegian, for a language nobody chose", () => {
    // The old behaviour flipped en↔nb. A student reading Arabic is not helped by Norwegian.
    expect(contentSideFor("ar")).toBe("en");
    expect(contentSideFor("es")).toBe("en");
    expect(contentSideFor("nb")).toBe("nb");
    expect(pickLocale({ en: "yield", nb: "vikeplikt" }, "ar")).toBe("yield");
    expect(pickLocale({ en: "yield", nb: "vikeplikt" }, "nb")).toBe(
      "vikeplikt",
    );
  });

  it("prefers a translation, and reads through to English when there is none", () => {
    const authored = { en: "Give way", nb: "Vikeplikt" };
    expect(resolveText("Ceder el paso", authored, "es")).toBe("Ceder el paso");
    expect(resolveText(null, authored, "es")).toBe("Give way");
    expect(resolveText("", authored, "es")).toBe("Give way");
    expect(resolveText(undefined, authored, "nb")).toBe("Vikeplikt");
  });

  it("returns an empty string rather than throwing on absent content", () => {
    expect(pickBilingualText(null, "es")).toBe("");
    expect(pickBilingualText({}, "es")).toBe("");
  });
});
