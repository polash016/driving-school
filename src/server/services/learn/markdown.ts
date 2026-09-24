import { countWords as countScriptWords } from "@/lib/brevity";
import { schoolConfig } from "../../../../config/school.config";

/**
 * Pure markdown helpers for the Learn section (spec-23). No DB, no AI: everything here is a
 * function of the text, so it is unit-tested exhaustively and reused by the editor, the reader,
 * the translation extractor and the QA gate.
 */

export interface Section {
  index: number;
  /** The H2 heading text, or null for the preamble before the first H2. */
  heading: string | null;
  markdown: string;
}

const H2 = /^##\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

/**
 * Split a document at every H2, then at paragraph boundaries where a section would exceed
 * `maxWords` — never inside a list, a table or a blockquote, and never inside a code fence.
 * `joinSections(splitSections(md))` is the identity.
 */
export function splitSections(
  markdown: string,
  options: { maxWords?: number; locale?: string } = {},
): Section[] {
  const maxWords = options.maxWords ?? schoolConfig.learn.sectionMaxWords;
  const locale = options.locale ?? "en";
  const lines = markdown.split("\n");

  // Pass 1: H2 blocks.
  const blocks: Array<{ heading: string | null; lines: string[] }> = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const h2 = !inFence ? line.match(H2) : null;
    if (h2) {
      if (current.lines.length > 0 || current.heading !== null) blocks.push(current);
      current = { heading: h2[1]!, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);

  // Pass 2: cap by words, cutting only at a blank line that is not inside a list/table/quote/fence.
  const sections: Section[] = [];
  for (const block of blocks) {
    const text = block.lines.join("\n");
    if (countWords(text, locale) <= maxWords) {
      if (text.trim().length > 0 || block.heading !== null) {
        sections.push({ index: sections.length, heading: block.heading, markdown: text });
      }
      continue;
    }
    let piece: string[] = [];
    let pieceHeading = block.heading;
    let fence = false;
    let structural = false;
    const flush = () => {
      if (piece.length === 0) return;
      sections.push({ index: sections.length, heading: pieceHeading, markdown: piece.join("\n") });
      piece = [];
      pieceHeading = null;
    };
    for (let i = 0; i < block.lines.length; i++) {
      const line = block.lines[i]!;
      if (FENCE.test(line)) fence = !fence;
      structural = /^\s*([-*+]|\d+[.)])\s|^\s*\||^\s*>/.test(line);
      const blank = line.trim() === "";
      if (
        blank &&
        !fence &&
        !structural &&
        piece.length > 0 &&
        countWords(piece.join("\n"), locale) >= maxWords &&
        i < block.lines.length - 1 &&
        !/^\s*([-*+]|\d+[.)])\s|^\s*\||^\s*>/.test(block.lines[i + 1] ?? "")
      ) {
        // The blank line stays with the piece it closes, so joining is still the identity.
        piece.push(line);
        flush();
        continue;
      }
      piece.push(line);
    }
    flush();
  }
  return sections;
}

/** The inverse of `splitSections`: sections joined back in order. */
export function joinSections(sections: Array<Pick<Section, "markdown">>): string {
  return sections.map((section) => section.markdown).join("\n");
}

/** Markdown syntax stripped to the prose a reader actually reads. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/[*_`~]+/g, "")
    .replace(/<[^>]+>/g, " ");
}

/** Words of prose, counted per script by `src/lib/brevity.ts`. */
export function countWords(markdown: string, locale = "en"): number {
  return countScriptWords(plainText(markdown), locale);
}

/** "x min read", never less than one minute for a non-empty document. */
export function readMinutes(words: number, wpm = schoolConfig.learn.readingWpm): number {
  if (words <= 0) return 0;
  return Math.max(1, Math.round(words / wpm));
}

/** Only images served by this app are allowed inside a document. */
export const IMAGE_SRC = /^\/api\/images\/([A-Za-z0-9]+)$/;

/** Ids of the images a document embeds, in order, de-duplicated. */
export function extractImageIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const id = match[1]!.match(IMAGE_SRC)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

export interface MarkdownStructure {
  h2: number;
  h3: number;
  listItems: number;
  tableRows: number;
  images: string[];
  links: string[];
  codeFences: number;
  htmlTags: number;
}

/** The skeleton of a document — what a translation must preserve and a QA gate can compare. */
export function markdownStructure(markdown: string): MarkdownStructure {
  const lines = markdown.split("\n");
  const structure: MarkdownStructure = {
    h2: 0,
    h3: 0,
    listItems: 0,
    tableRows: 0,
    images: [],
    links: [],
    codeFences: 0,
    htmlTags: 0,
  };
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      structure.codeFences++;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s/.test(line)) structure.h2++;
    else if (/^###\s/.test(line)) structure.h3++;
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) structure.listItems++;
    if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) structure.tableRows++;
    structure.htmlTags += (line.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).length;
  }
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) structure.images.push(match[1]!);
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)/g)) structure.links.push(match[1]!);
  structure.codeFences = Math.floor(structure.codeFences / 2);
  return structure;
}
