import { describe, expect, it } from "vitest";
import { schoolConfig, schoolConfigSchema } from "./school.config";

describe("school.config", () => {
  it("parses against its own schema (fails the build on invalid config)", () => {
    expect(() => schoolConfigSchema.parse(schoolConfig)).not.toThrow();
  });

  it("is frozen — components cannot mutate school identity at runtime", () => {
    expect(Object.isFrozen(schoolConfig)).toBe(true);
  });

  it("default locale is among supported locales", () => {
    expect(schoolConfig.locales.supported).toContain(
      schoolConfig.locales.default,
    );
  });

  it("every license class seed has a pass mark within question count", () => {
    for (const lc of schoolConfig.licenseClassSeeds) {
      expect(lc.passMark).toBeLessThanOrEqual(lc.questionCount);
    }
  });
});

describe("locale formatting", () => {
  it("pins an IANA time zone so dates never follow the host's clock", () => {
    expect(schoolConfig.locales.timeZone).toBe("Europe/Oslo");
    expect(Intl.supportedValuesOf("timeZone")).toContain(
      schoolConfig.locales.timeZone,
    );
  });

  it("rejects a config without a valid zone", () => {
    const broken = {
      ...schoolConfig,
      locales: { ...schoolConfig.locales, timeZone: "Mars/Olympus" },
    };
    expect(() => schoolConfigSchema.parse(broken)).toThrow();
  });
});
