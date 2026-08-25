import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import {
  ARGON2_OPTIONS,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password";

/**
 * Spec-03 acceptance: "Argon2 params documented". The parameters are asserted against the
 * encoded hash itself, so a silent downgrade (weaker memory/time cost) fails the build.
 */
describe("password hashing", () => {
  it("uses argon2id with the OWASP baseline parameters", async () => {
    const hash = await hashPassword("correct horse battery staple");
    const [, algorithm, version, params] = hash.split("$");

    expect(algorithm).toBe("argon2id");
    expect(version).toBe("v=19");
    expect(params).toBe("m=19456,t=2,p=1");
    expect(ARGON2_OPTIONS).toMatchObject({
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(hash, "Correct horse battery staple")).resolves.toBe(false);
  });

  it("salts each hash — identical passwords never share a digest", async () => {
    const [a, b] = await Promise.all([hashPassword("samesame123"), hashPassword("samesame123")]);
    expect(a).not.toBe(b);
  });

  it("treats a malformed stored hash as a failed verification, not a crash", async () => {
    await expect(verifyPassword("not-a-hash", "whatever123")).resolves.toBe(false);
  });
});

describe("password policy", () => {
  it("accepts a reasonable password", () => {
    expect(() => assertPasswordPolicy("bratsberg-sving-42", "kari@example.no")).not.toThrow();
  });

  it.each([
    ["short12", "auth.errors.passwordTooShort"],
    ["passord123", "auth.errors.passwordTooCommon"],
  ])("rejects %s", (password, messageKey) => {
    try {
      assertPasswordPolicy(password, "kari@example.no");
      throw new Error("expected policy violation");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).messageKey).toBe(messageKey);
    }
  });

  it("rejects a password containing the email local part", () => {
    try {
      assertPasswordPolicy("kariNordmann2026", "kariNordmann@example.no");
      throw new Error("expected policy violation");
    } catch (error) {
      expect((error as ValidationError).messageKey).toBe("auth.errors.passwordSameAsEmail");
    }
  });
});
