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

  it("carries AI request deadlines (spec-19 layer 0)", () => {
    expect(schoolConfig.ai.requestTimeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(schoolConfig.ai.pingTimeoutMs).toBeGreaterThanOrEqual(30_000);
    expect(schoolConfig.ai.pingTimeoutMs).toBeLessThan(
      schoolConfig.ai.requestTimeoutMs,
    );
  });

  it("translation batch fits the output cap with headroom, and slots are bounded (spec-19a)", () => {
    const { translationBatchSize, translationMaxTokens, translationParallelSlots } = schoolConfig.ai;
    // ~255 completion tokens per Spanish question at p90; 300 leaves margin for verbose models.
    expect(translationBatchSize * 300).toBeLessThanOrEqual(translationMaxTokens);
    expect(translationParallelSlots).toBeGreaterThanOrEqual(1);
    expect(translationParallelSlots).toBeLessThanOrEqual(4); // default Prisma pool is 5 on 2 vCPUs
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
