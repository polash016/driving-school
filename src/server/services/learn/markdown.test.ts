import { describe, expect, it } from "vitest";
import {
  countWords,
  extractImageIds,
  joinSections,
  markdownStructure,
  readMinutes,
  splitSections,
} from "./markdown";

const doc = `# Right of way

Intro paragraph before any section.

## The right-hand rule

You must yield to traffic from your right (trafikkreglene § 7 nr. 2).

- first
- second

## Priority roads

A priority road is marked with sign 206.

![Sign 206](/api/images/abc123)

| sign | meaning |
|---|---|
| 206 | priority road |
`;

describe("splitSections", () => {
  it("splits at every H2 and keeps the preamble as section 0", () => {
    const sections = splitSections(doc);
    expect(sections.map((s) => s.heading)).toEqual([null, "The right-hand rule", "Priority roads"]);
    expect(sections[0]!.markdown).toContain("Intro paragraph");
  });

  it("joins back to the identical document", () => {
    expect(joinSections(splitSections(doc))).toBe(doc);
  });

  it("splits a long section at a paragraph boundary, never inside a list or a table", () => {
    const para = "word ".repeat(60).trim();
    const long = `## Long\n\n${para}\n\n${para}\n\n- a\n- b\n\n${para}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${para}\n`;
    const sections = splitSections(long, { maxWords: 100 });
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      // a list or a table is never cut in half
      const lines = section.markdown.split("\n");
      const listLines = lines.filter((l) => /^- /.test(l)).length;
      expect([0, 2]).toContain(listLines);
      const tableLines = lines.filter((l) => /^\|/.test(l)).length;
      expect([0, 3]).toContain(tableLines);
    }
    expect(joinSections(sections)).toBe(long);
  });

  it("does not treat a '##' inside a code fence as a heading", () => {
    const md = "## A\n\n```\n## not a heading\n```\n\n## B\n";
    expect(splitSections(md).map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("returns one empty preamble for an empty document", () => {
    expect(splitSections("")).toEqual([]);
  });
});

describe("words and minutes", () => {
  it("counts prose, not syntax", () => {
    expect(countWords("## Heading\n\n- **bold** item\n\n![alt](/api/images/x)")).toBe(4);
  });
  it("rounds minutes and never says zero for real text", () => {
    expect(readMinutes(0)).toBe(0);
    expect(readMinutes(50, 200)).toBe(1);
    expect(readMinutes(1000, 200)).toBe(5);
  });
});

describe("images and structure", () => {
  it("extracts only app-served image ids", () => {
    const md = "![a](/api/images/abc) ![b](https://evil.example/x.png) ![c](/api/images/abc) ![d](/api/images/def \"t\")";
    expect(extractImageIds(md)).toEqual(["abc", "def"]);
  });

  it("counts headings, lists, table rows, images, links, fences and html", () => {
    const s = markdownStructure(doc + "\n[law](https://lovdata.no)\n<b>x</b>\n```js\ncode\n```\n");
    expect(s.h2).toBe(2);
    expect(s.h3).toBe(0);
    expect(s.listItems).toBe(2);
    expect(s.tableRows).toBe(2);
    expect(s.images).toEqual(["/api/images/abc123"]);
    expect(s.links).toEqual(["https://lovdata.no"]);
    expect(s.codeFences).toBe(1);
    expect(s.htmlTags).toBe(2);
  });
});
