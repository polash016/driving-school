import { describe, expect, it } from "vitest";
import { InternalError } from "@/lib/errors";
import { schoolConfig } from "../../../config/school.config";
import { optionalProviders, vippsLoginEnabled, vippsProvider } from "./vipps-stub";

/**
 * Spec-03 in-scope item: "Vipps Login: leave a clearly-marked adapter stub + feature flag".
 * The point of these assertions is that the stub can never be mistaken for a working provider.
 */
describe("Vipps Login stub", () => {
  it("ships disabled", () => {
    expect(schoolConfig.featureFlags.vippsLogin).toBe(false);
    expect(vippsLoginEnabled).toBe(false);
  });

  it("throws instead of returning a half-configured provider", () => {
    expect(() => vippsProvider()).toThrow(InternalError);
  });

  it("contributes no providers to the Auth.js config", () => {
    expect(optionalProviders()).toEqual([]);
  });
});
