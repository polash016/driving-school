import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECURITY_POLICY,
  securityPolicySchema,
} from "./security-policy";

/**
 * Turning admin 2FA off is a deliberate, recorded choice. The one thing that must never happen is
 * it becoming off by accident — through a default, a typo, or an unreadable stored value.
 */
describe("security policy", () => {
  it("defaults to requiring two-factor for admins", () => {
    expect(DEFAULT_SECURITY_POLICY.adminTwoFactorRequired).toBe(true);
  });

  it("accepts only an explicit boolean", () => {
    // The reviewer count has a safe default; the 2FA switch deliberately does not.
    expect(
      securityPolicySchema.parse({ adminTwoFactorRequired: false }),
    ).toEqual({
      adminTwoFactorRequired: false,
      aiApprovalsRequired: 2,
    });
    // No coercion: "false", 0 and undefined must not quietly become a policy.
    expect(() =>
      securityPolicySchema.parse({ adminTwoFactorRequired: "false" }),
    ).toThrow();
    expect(() =>
      securityPolicySchema.parse({ adminTwoFactorRequired: 0 }),
    ).toThrow();
    expect(() => securityPolicySchema.parse({})).toThrow();
  });

  it("keeps the reviewer count within a sane range", () => {
    expect(
      securityPolicySchema.parse({
        adminTwoFactorRequired: true,
        aiApprovalsRequired: 1,
      }).aiApprovalsRequired,
    ).toBe(1);
    // Zero reviewers would mean AI questions publishing themselves.
    expect(() =>
      securityPolicySchema.parse({
        adminTwoFactorRequired: true,
        aiApprovalsRequired: 0,
      }),
    ).toThrow();
    expect(() =>
      securityPolicySchema.parse({
        adminTwoFactorRequired: true,
        aiApprovalsRequired: 4,
      }),
    ).toThrow();
  });

  it("rejects unknown keys rather than storing them", () => {
    expect(() =>
      securityPolicySchema.parse({
        adminTwoFactorRequired: true,
        somethingElse: true,
      }),
    ).toThrow();
  });
});
