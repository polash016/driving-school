import { describe, expect, it } from "vitest";
import type { ItemStatus } from "@prisma/client";
import { canTransition } from "./transitions";

/**
 * Spec-04 acceptance: "Lifecycle transitions enforced server-side (invalid transitions
 * rejected)". The full matrix is asserted here so a future edit to the map cannot quietly open
 * an edge — the integration test then proves the service actually refuses one.
 */
const STATUSES: ItemStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "NEEDS_REVIEW",
  "RETIRED",
];

/** The contract, written out independently of the implementation's data structure. */
const LEGAL = new Set([
  "DRAFT>IN_REVIEW",
  "DRAFT>RETIRED",
  "IN_REVIEW>APPROVED",
  "IN_REVIEW>DRAFT",
  "IN_REVIEW>RETIRED",
  "APPROVED>RETIRED",
  "APPROVED>NEEDS_REVIEW",
  "NEEDS_REVIEW>IN_REVIEW",
  "NEEDS_REVIEW>RETIRED",
  "RETIRED>DRAFT",
]);

describe("item lifecycle matrix", () => {
  it.each(
    STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)),
  )("%s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(LEGAL.has(`${from}>${to}`));
  });

  it("never allows a status to transition to itself", () => {
    for (const status of STATUSES)
      expect(canTransition(status, status)).toBe(false);
  });

  it("keeps APPROVED reachable only through review", () => {
    const intoApproved = STATUSES.filter((from) =>
      canTransition(from, "APPROVED"),
    );
    expect(intoApproved).toEqual(["IN_REVIEW"]);
  });

  it("lets a retired item be revived only as a draft", () => {
    const fromRetired = STATUSES.filter((to) => canTransition("RETIRED", to));
    expect(fromRetired).toEqual(["DRAFT"]);
  });
});
