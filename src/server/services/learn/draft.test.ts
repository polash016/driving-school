import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { draftDocument, stripForbidden, structureMismatch, type DraftDeps } from "./draft";

const actor = { id: "admin", role: "ADMIN" as const, email: "a@test.local" };
const topic = { id: "t1", slug: "right-of-way", name: { en: "Right of way", nb: "Vikeplikt" } };

function fakeDb() {
  return {
    topic: { findFirst: vi.fn(async () => topic) },
    learnBook: { findFirst: vi.fn(async () => ({ title: { en: "Theory", nb: "Teori" } })) },
    learnDocument: { findMany: vi.fn(async () => [{ title: { en: "Roundabouts", nb: "Rundkjøringer" } }]) },
  } as unknown as PrismaClient;
}

const hits = Array.from({ length: 4 }, (_, i) => ({
  chunkId: `c${i}`, sourceCode: "trafikkreglene", ref: `§ ${7 + i}`, text: `Rule ${7 + i} text about yielding.`,
}));
const goodBody = (lang: "en" | "nb") =>
  `## ${lang === "en" ? "The rule" : "Regelen"}\n\nYou must yield to traffic from the right (trafikkreglene § 7 nr. 2).\n\n## ${lang === "en" ? "Priority roads" : "Forkjørsveier"}\n\n- 50 km/h\n- one\n\n## ${lang === "en" ? "Key points" : "Det viktigste"}\n\n- yield\n`;
const response = (over: Partial<{ en: string; nb: string; citations: Array<{ sourceCode: string; ref: string }> }> = {}) => ({
  data: {
    title: { en: "Right of way", nb: "Vikeplikt" },
    summary: { en: "Who goes first.", nb: "Hvem kjører først." },
    body: { en: over.en ?? goodBody("en"), nb: over.nb ?? goodBody("nb") },
    citations: over.citations ?? [{ sourceCode: "trafikkreglene", ref: "§ 7 nr. 2" }],
  },
  modelVersion: "m1",
  promptVersion: "1.0.0",
  promptTokens: 10,
  completionTokens: 20,
});
const resolveAll: DraftDeps["resolve"] = async (_db, citations) => ({
  resolved: citations.map((c) => ({ ...c, kbChunkId: "c0", chunkRef: "§ 7", text: "x" })),
  unresolved: [],
});
const input = { topicId: "t1", kind: "CHAPTER" as const, bookId: "b1", sourceCodes: [], targetWords: 700 };

describe("draftDocument", () => {
  it("grounds in retrieved excerpts, returns both languages, and records provenance", async () => {
    const generate = vi.fn<DraftDeps["generate"]>(async () => response());
    const out = await draftDocument(fakeDb(), actor, input, { generate, retrieve: async () => hits, resolve: resolveAll });
    expect(out.excerptCount).toBe(4);
    expect(out.body.en).toContain("## The rule");
    expect(out.body.nb).toContain("## Regelen");
    expect(out.citations).toEqual([{ sourceCode: "trafikkreglene", ref: "§ 7 nr. 2" }]);
    expect(out.modelVersion).toBe("m1");
    expect(out.warnings).toEqual(["length"]);
    const vars = generate.mock.calls[0]![0]!;
    expect(vars.kbExcerpts).toContain("[trafikkreglene § 7]");
    expect(vars.siblingTitles).toContain("Roundabouts");
    expect(vars.kindLabel).toContain('"Theory"');
  });

  it("refuses when the knowledge base has too little material", async () => {
    await expect(
      draftDocument(fakeDb(), actor, input, { generate: vi.fn(), retrieve: async () => hits.slice(0, 2), resolve: resolveAll }),
    ).rejects.toMatchObject({ messageKey: "admin.learn.errors.aiNoMaterial" });
  });

  it("retries once with the structure finding, then refuses", async () => {
    const generate = vi
      .fn<DraftDeps["generate"]>()
      .mockResolvedValueOnce(response({ nb: "## Bare en\n\ntekst\n" }))
      .mockResolvedValueOnce(response({ nb: "## Bare en\n\ntekst\n" }));
    await expect(
      draftDocument(fakeDb(), actor, input, { generate, retrieve: async () => hits, resolve: resolveAll }),
    ).rejects.toMatchObject({ messageKey: "admin.learn.errors.aiStructure" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]!.feedback).toContain("English has 3 H2 sections, Norwegian 1");
  });

  it("refuses a number that differs between the languages", async () => {
    const generate = vi.fn<DraftDeps["generate"]>(async () => response({ nb: goodBody("nb").replace("50 km/h", "60 km/h") }));
    await expect(
      draftDocument(fakeDb(), actor, input, { generate, retrieve: async () => hits, resolve: resolveAll }),
    ).rejects.toMatchObject({ messageKey: "admin.learn.errors.aiStructure" });
    expect(generate.mock.calls[1]![0]!.feedback).toContain("NUMBER_DRIFT");
  });

  it("refuses when no citation resolves, and reports the unresolved ones otherwise", async () => {
    await expect(
      draftDocument(fakeDb(), actor, input, {
        generate: vi.fn(async () => response()),
        retrieve: async () => hits,
        resolve: async (_db, citations) => ({ resolved: [], unresolved: citations }),
      }),
    ).rejects.toMatchObject({ messageKey: "admin.learn.errors.aiNoCitations" });

    const out = await draftDocument(fakeDb(), actor, input, {
      generate: vi.fn(async () => response({ citations: [{ sourceCode: "trafikkreglene", ref: "§ 7 nr. 2" }, { sourceCode: "vegtrafikkloven", ref: "§ 3" }] })),
      retrieve: async () => hits,
      resolve: async (_db, citations) => ({
        resolved: citations.filter((c) => c.sourceCode === "trafikkreglene").map((c) => ({ ...c, kbChunkId: "c0", chunkRef: "§ 7", text: "x" })),
        unresolved: citations.filter((c) => c.sourceCode !== "trafikkreglene"),
      }),
    });
    expect(out.citations).toHaveLength(1);
    expect(out.unresolvedCitations).toEqual([{ sourceCode: "vegtrafikkloven", ref: "§ 3" }]);
  });

  it("strips images, links, html and code and says so", async () => {
    const dirty = goodBody("en") + "\n![x](/api/images/a)\n[law](https://x)\n<b>bold</b>\n```js\ncode\n```\n";
    const out = await draftDocument(fakeDb(), actor, input, {
      generate: vi.fn(async () => response({ en: dirty })),
      retrieve: async () => hits,
      resolve: resolveAll,
    });
    expect(out.body.en).not.toContain("![x]");
    expect(out.body.en).not.toContain("<b>");
    expect(out.body.en).toContain("law");
    expect(out.warnings).toEqual(expect.arrayContaining(["stripped.images", "stripped.links", "stripped.html", "stripped.code"]));
  });
});

describe("helpers", () => {
  it("structureMismatch names the first difference", () => {
    expect(structureMismatch("## a\n## b\n## c\n### x\n", "## a\n## b\n## c\n")).toBe("English has 1 H3 headings, Norwegian 0.");
    expect(structureMismatch("## a\n", "## a\n")).toBe("Only 1 H2 section(s); write 4 to 8.");
    expect(structureMismatch("## a\n## b\n", "## a\n## b\n")).toBeNull();
  });
  it("stripForbidden removes an H1 and collapses blank runs", () => {
    expect(stripForbidden("# Title\n\n\n\n## A\n\ntext").markdown).toBe("## A\n\ntext\n");
  });
});
