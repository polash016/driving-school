/**
 * Pairing sign graphics with their captions and sign class — the part of `pnpm signs:extract`
 * worth testing on its own.
 *
 * Split out of the script because the geometry rules here were each learned from a specific way
 * the naive version got a sign WRONG, and a wrong sign teaches a student the wrong thing. The
 * tests pin the four cases down; see `scripts/extract-signs.ts` for how the inputs are obtained.
 */

/** Anything set at 20pt or above is a section heading; captions are set at 10.56/11.04pt. */
export const HEADING_PT = 20;
/**
 * How far ABOVE an image's bottom edge its caption may start. The image placement rect includes
 * the printed white margin, so a caption routinely overlaps it. Too tight a value shifts every
 * caption in a group by one — which is how "Give way" ends up labelled "Stop".
 */
export const CAPTION_TOLERANCE = 15;
/** Consecutive caption lines closer than this are one wrapped caption. */
export const LINE_GAP = 6;

export type TextLine = { y: number; y2: number; text: string; size: number };
export type ImageRect = { y: number; y2: number };
export type PageInput = {
  page: number;
  images: ImageRect[];
  lines: TextLine[];
};
export type PairedSign = {
  page: number;
  indexOnPage: number;
  name: string | null;
  section: string | null;
};

/**
 * Merge wrapped caption lines, and separate captions from section headings BY FONT SIZE.
 *
 * Font size is the only reliable test. "Street sign" reads like a section name but is set at
 * caption size — it is the caption of one direction sign, not a group heading. Position cannot
 * settle it either, because a real heading often sits exactly where a caption would.
 */
export function splitLines(
  lines: TextLine[],
  isSectionName: (text: string) => boolean,
): { headings: TextLine[]; captions: TextLine[] } {
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const captions: TextLine[] = [];

  for (const line of sorted.filter((line) => line.size < HEADING_PT)) {
    const previous = captions.at(-1);
    if (previous && line.y - previous.y2 < LINE_GAP) {
      previous.text += ` ${line.text}`;
      previous.y2 = line.y2;
    } else {
      captions.push({ ...line });
    }
  }

  return {
    headings: sorted.filter(
      (line) => line.size >= HEADING_PT && isSectionName(line.text),
    ),
    captions,
  };
}

/**
 * Walk pages in order, carrying the current section, and give each image the first caption at or
 * below its bottom edge — falling through to the next page when its own has none left.
 */
export function pairSigns(
  pages: PageInput[],
  isSectionName: (text: string) => boolean,
): PairedSign[] {
  const parsed = pages.map((page) => ({
    ...page,
    ...splitLines(page.lines, isSectionName),
  }));
  const out: PairedSign[] = [];
  let section: string | null = null;

  for (const [index, page] of parsed.entries()) {
    const next = parsed[index + 1]?.captions ?? [];
    // Headings and images interleave down the page; walking them in y-order is what keeps a sign
    // in the class whose heading precedes it.
    const timeline = [
      ...page.images.map((image) => ({ y: image.y, image })),
      ...page.headings.map((heading) => ({
        y: heading.y,
        heading: heading.text,
      })),
    ].sort((a, b) => a.y - b.y);

    let indexOnPage = 0;
    for (const entry of timeline) {
      if ("heading" in entry) {
        section = entry.heading;
        continue;
      }
      const below = page.captions.filter(
        (c) => c.y >= entry.image.y2 - CAPTION_TOLERANCE,
      );
      out.push({
        page: page.page,
        indexOnPage,
        name: (below[0] ?? next[0])?.text ?? null,
        section,
      });
      indexOnPage++;
    }
  }
  return out;
}
