import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { lookupChunksForCitations, sectionHead, usableCitations } from "./citations";

function fakeDb(rowsByRef: Record<string, Array<{ id: string; ref: string; text: string }>>) {
  const findMany = vi.fn(async ({ where }: { where: { ref: string } }) => rowsByRef[where.ref] ?? []);
  return { db: { kbChunk: { findMany } } as unknown as PrismaClient, findMany };
}

describe("citation lookup", () => {
  it("keeps only citations with both halves present", () => {
    expect(
      usableCitations([{ sourceCode: "a", ref: "§ 1" }, { sourceCode: " ", ref: "§ 2" }, { ref: "§ 3" }, null, "x"]),
    ).toEqual([{ sourceCode: "a", ref: "§ 1" }]);
    expect(usableCitations(undefined)).toEqual([]);
  });

  it("names the section head of a subsection reference", () => {
    expect(sectionHead("§ 7 nr. 3")).toBe("§ 7");
    expect(sectionHead("§ 13-3")).toBe("§ 13");
    expect(sectionHead("§7")).toBe("§ 7");
    expect(sectionHead("chapter 4")).toBeNull();
  });

  it("resolves exactly first, then falls back to the section head, and reports the rest", async () => {
    const { db, findMany } = fakeDb({
      "§ 7": [{ id: "c7", ref: "§ 7", text: "section seven" }],
      "§ 12 nr. 2": [{ id: "c12", ref: "§ 12 nr. 2", text: "exact" }],
    });
    const out = await lookupChunksForCitations(db, [
      { sourceCode: "trafikkreglene", ref: "§ 7 nr. 3" },
      { sourceCode: "trafikkreglene", ref: "§ 12 nr. 2" },
      { sourceCode: "vegtrafikkloven", ref: "§ 3" },
    ]);
    expect(out.resolved.map((r) => [r.ref, r.chunkRef, r.kbChunkId])).toEqual([
      ["§ 7 nr. 3", "§ 7", "c7"],
      ["§ 12 nr. 2", "§ 12 nr. 2", "c12"],
    ]);
    expect(out.unresolved).toEqual([{ sourceCode: "vegtrafikkloven", ref: "§ 3" }]);
    // the exact miss for "§ 7 nr. 3" cost one extra query, the exact hit none
    expect(findMany).toHaveBeenCalledTimes(4);
  });
});
