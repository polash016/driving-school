import { describe, expect, it } from "vitest";
import { partitionBlockers } from "./languages";

/**
 * The publish-readiness partition (spec-19).
 *
 * A percentage tells an admin how far off they are; it never tells them what to do. This turns the
 * shortfall into named buckets — but only usefully if it is a real partition: every unit that is
 * not servable in exactly one bucket, and the counts summing to `total − ready`. Double-counting
 * would inflate the checklist; a gap would let it read "nothing blocks" while the publish gate
 * still refused, which is the one disagreement the feature exists to prevent.
 */
const units = ["a", "b", "c", "d", "e", "f"].map((id) => ({
  entity: "TOPIC" as const,
  entityId: id,
  sourceHash: `h-${id}`,
}));

const rows = new Map([
  ["TOPIC:a", { sourceHash: "h-a", status: "APPROVED" as const }],
  ["TOPIC:b", { sourceHash: "h-b", status: "MACHINE" as const }],
  ["TOPIC:c", { sourceHash: "h-c", status: "NEEDS_REVIEW" as const }],
  // A row whose source has moved on: neither translated nor flagged, just absent again.
  ["TOPIC:d", { sourceHash: "STALE", status: "APPROVED" as const }],
  // e: no row, and the machine gave up on it. f: no row, never attempted.
]);

describe("publish blockers", () => {
  it("partitions every not-ready unit into exactly one bucket", () => {
    const blockers = partitionBlockers(units, rows, new Set(["TOPIC:e"]), true);
    expect(blockers).toEqual([
      { kind: "UNTRANSLATED", count: 2 }, // d (stale) + f
      { kind: "FAILED", count: 1 }, // e
      { kind: "FLAGGED", count: 1 }, // c
      { kind: "AWAITING_APPROVAL", count: 1 }, // b
    ]);
    const ready = 1; // a
    expect(blockers.reduce((sum, b) => sum + b.count, 0)).toBe(
      units.length - ready,
    );
  });

  it("without approval, MACHINE is ready and the bucket disappears", () => {
    const blockers = partitionBlockers(units, rows, new Set(), false);
    expect(
      blockers.find((b) => b.kind === "AWAITING_APPROVAL"),
    ).toBeUndefined();
    expect(blockers.find((b) => b.kind === "FAILED")).toBeUndefined();
    // b became ready; d, e and f are still simply untranslated.
    expect(blockers).toEqual([
      { kind: "UNTRANSLATED", count: 3 },
      { kind: "FLAGGED", count: 1 },
    ]);
  });

  it("counts a REJECTED row as held by a check, not as untranslated", () => {
    const blockers = partitionBlockers(
      [units[0]],
      new Map([
        ["TOPIC:a", { sourceHash: "h-a", status: "REJECTED" as const }],
      ]),
      new Set(),
      false,
    );
    expect(blockers).toEqual([{ kind: "FLAGGED", count: 1 }]);
  });

  it("does not count a failed unit twice once it has been translated", () => {
    // SKIPPED in an earlier run, translated and approved in a later one. FAILED is a subset of
    // "no fresh row", so the stale membership of the failed set cannot resurrect it.
    const blockers = partitionBlockers(
      [units[0]],
      new Map([
        ["TOPIC:a", { sourceHash: "h-a", status: "APPROVED" as const }],
      ]),
      new Set(["TOPIC:a"]),
      true,
    );
    expect(blockers).toEqual([]);
  });

  it("blocks nothing when every unit is servable", () => {
    const all = new Map(
      units.map(
        (unit) =>
          [
            `${unit.entity}:${unit.entityId}`,
            { sourceHash: unit.sourceHash, status: "APPROVED" as const },
          ] as const,
      ),
    );
    expect(partitionBlockers(units, all, new Set(), true)).toEqual([]);
  });
});
