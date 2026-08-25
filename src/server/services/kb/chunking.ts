/**
 * Splitting a legal text into citable chunks (spec-05).
 *
 * Section boundaries first: a citation is only useful if it names the paragraph the rule actually
 * lives in ("Trafikkreglene § 7"), so chunks follow § boundaries rather than a fixed window. A
 * section longer than the window is split further, with its reference carried onto each piece.
 *
 * Pure — no database, no AI. That makes the chunking testable on its own, which matters because
 * every citation in the system inherits whatever this function decides.
 */

export interface Chunk {
  /** Section reference as cited, e.g. "§ 7-2" or "Kapittel 3" for un-numbered preamble text. */
  ref: string;
  text: string;
}

/** Roughly 800 tokens; Norwegian legal prose runs ~4 characters per token. */
const MAX_CHARS = 3200;
const OVERLAP_CHARS = 480; // ~15%

/** `§ 7`, `§ 7-2`, `§ 7 a` — the forms Norwegian regulations actually use. */
const SECTION_RE = /^\s*(§+\s*\d+[\w-]*(?:\s*[a-z])?)\.?\s*/;

export function chunkLegalText(text: string, fallbackRef = "—"): Chunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: Chunk[] = [];
  let ref = fallbackRef;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body.length > 0) sections.push({ ref, text: body });
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(SECTION_RE);
    if (match) {
      flush();
      ref = match[1].replace(/\s+/g, " ").trim();
      // Keep the heading line with its section — it is usually the rule's title.
      buffer.push(line.trim());
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections.flatMap((section) => splitLong(section));
}

/** A section too long to embed usefully becomes overlapping windows under the same reference. */
function splitLong(section: Chunk): Chunk[] {
  if (section.text.length <= MAX_CHARS) return [section];

  const pieces: Chunk[] = [];
  let start = 0;
  while (start < section.text.length) {
    const end = Math.min(start + MAX_CHARS, section.text.length);
    // Prefer a sentence boundary so a chunk does not end mid-rule.
    const slice = section.text.slice(start, end);
    const cut =
      end === section.text.length
        ? slice.length
        : Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n")) + 1 ||
          slice.length;

    pieces.push({ ref: section.ref, text: slice.slice(0, cut).trim() });
    if (end === section.text.length) break;
    start += Math.max(1, cut - OVERLAP_CHARS);
  }
  return pieces.filter((piece) => piece.text.length > 0);
}
