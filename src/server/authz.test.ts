import { describe, expect, it } from "vitest";
import { AuthError, ForbiddenError } from "@/lib/errors";
import { authorize, authorizeOwner, type SessionUser } from "./authz";

/**
 * Spec-03 acceptance: role enforcement lives in exactly one place. These cases pin the
 * ladder ADMIN ⊃ INSTRUCTOR ⊃ STUDENT that every protected route depends on.
 */
const student: SessionUser = { id: "u1", role: "STUDENT", email: "s@example.no" };
const instructor: SessionUser = { id: "u2", role: "INSTRUCTOR", email: "i@example.no" };
const admin: SessionUser = { id: "u3", role: "ADMIN", email: "a@example.no" };

describe("authorize", () => {
  it("rejects an absent session", () => {
    expect(() => authorize(null)).toThrow(AuthError);
    expect(() => authorize(undefined, "ADMIN")).toThrow(AuthError);
  });

  it("lets each role reach its own level and below", () => {
    expect(authorize(student, "STUDENT")).toBe(student);
    expect(authorize(instructor, "STUDENT")).toBe(instructor);
    expect(authorize(instructor, "INSTRUCTOR")).toBe(instructor);
    expect(authorize(admin, "ADMIN")).toBe(admin);
    expect(authorize(admin, "INSTRUCTOR")).toBe(admin);
  });

  it("blocks escalation with a 403, not a 401", () => {
    expect(() => authorize(student, "INSTRUCTOR")).toThrow(ForbiddenError);
    expect(() => authorize(student, "ADMIN")).toThrow(ForbiddenError);
    expect(() => authorize(instructor, "ADMIN")).toThrow(ForbiddenError);

    try {
      authorize(student, "ADMIN");
    } catch (error) {
      expect((error as ForbiddenError).httpStatus).toBe(403);
      expect((error as ForbiddenError).meta).toEqual({
        required: "ADMIN",
        actual: "STUDENT",
      });
    }
  });
});

describe("authorizeOwner", () => {
  it("allows a student to touch only their own resource", () => {
    expect(authorizeOwner(student, "u1")).toBe(student);
    expect(() => authorizeOwner(student, "someone-else")).toThrow(ForbiddenError);
  });

  it("lets staff act on another user's resource", () => {
    expect(authorizeOwner(instructor, "u1")).toBe(instructor);
    expect(authorizeOwner(admin, "u1")).toBe(admin);
  });

  it("still requires a session", () => {
    expect(() => authorizeOwner(null, "u1")).toThrow(AuthError);
  });
});
