import { describe, expect, it } from "vitest";
import { pairSigns, splitLines, type PageInput } from "./sign-pairing";

/**
 * Every case here is a real page from the theory book that the naive pairing got wrong. The
 * coordinates are the ones `mutool` actually reports for those pages.
 */
const SECTIONS = new Set([
  "Warning signs",
  "Give way and priority signs",
  "Prohibitory signs",
  "Direction signs",
]);
const isSectionName = (text: string) => SECTIONS.has(text);

const caption = (
  y: number,
  text: string,
  height = 14,
): { y: number; y2: number; text: string; size: number } => ({
  y,
  y2: y + height,
  text,
  size: 10.56,
});
const heading = (y: number, text: string) => ({
  y,
  y2: y + 40,
  text,
  size: 28.56,
});
const image = (y: number, y2: number) => ({ y, y2 });

describe("splitLines", () => {
  it("treats a caption-sized line as a caption even when its text names a section", () => {
    // Page 271: "Street sign" is the caption of one direction sign, not a group heading. Only the
    // font size distinguishes them, which is why block-level parsing cannot work.
    const { headings, captions } = splitLines(
      [heading(67.6, "Direction signs"), caption(595.8, "Street sign")],
      isSectionName,
    );
    expect(headings.map((h) => h.text)).toEqual(["Direction signs"]);
    expect(captions.map((c) => c.text)).toEqual(["Street sign"]);
  });

  it("rejoins a caption that wrapped onto a second line", () => {
    const { captions } = splitLines(
      [
        caption(300, "No motor vehicles with more than two wheels"),
        caption(315, "and total weight above the stated weight"),
      ],
      isSectionName,
    );
    expect(captions).toHaveLength(1);
    expect(captions[0].text).toBe(
      "No motor vehicles with more than two wheels and total weight above the stated weight",
    );
  });

  it("keeps two separate captions separate", () => {
    const { captions } = splitLines(
      [caption(290.1, "Give way"), caption(637.9, "Stop")],
      isSectionName,
    );
    expect(captions.map((c) => c.text)).toEqual(["Give way", "Stop"]);
  });
});

describe("pairSigns", () => {
  it("pairs a caption that starts ABOVE the image's bottom edge", () => {
    // Page 197, the bug that made the first give-way sign read as "Stop": the caption's top
    // (290.1) sits above the image's bottom (300.9) because the rect includes white margin.
    const pages: PageInput[] = [
      {
        page: 197,
        images: [image(103.6, 300.9), image(394.6, 619.6)],
        lines: [
          heading(67.6, "Give way and priority signs"),
          caption(290.1, "Give way"),
          caption(637.9, "Stop"),
        ],
      },
    ];
    expect(pairSigns(pages, isSectionName).map((s) => s.name)).toEqual([
      "Give way",
      "Stop",
    ]);
  });

  it("keeps every sign in the class whose heading precedes it", () => {
    const pages: PageInput[] = [
      {
        page: 176,
        images: [image(163.2, 360.4)],
        lines: [
          heading(100.8, "Warning signs"),
          caption(377.2, "Dangerous curve"),
        ],
      },
      {
        page: 197,
        images: [image(103.6, 300.9)],
        lines: [
          heading(67.6, "Give way and priority signs"),
          caption(290.1, "Give way"),
        ],
      },
      {
        page: 200,
        images: [image(70.8, 295.8)],
        lines: [
          caption(314.1, "Priority over oncoming traffic"),
          heading(400, "Prohibitory signs"),
        ],
      },
      {
        page: 201,
        images: [image(70.8, 295.8)],
        lines: [caption(314.1, "No entry")],
      },
    ];
    expect(pairSigns(pages, isSectionName)).toMatchObject([
      { name: "Dangerous curve", section: "Warning signs" },
      { name: "Give way", section: "Give way and priority signs" },
      // The "Prohibitory signs" heading sits BELOW this image, so the sign still belongs to the
      // group above it — the last sign of a group is always the one a naive walk misfiles.
      {
        name: "Priority over oncoming traffic",
        section: "Give way and priority signs",
      },
      { name: "No entry", section: "Prohibitory signs" },
    ]);
  });

  it("takes a caption from the next page when the image is the last on its own", () => {
    const pages: PageInput[] = [
      {
        page: 270,
        images: [image(507.6, 700)],
        lines: [heading(60, "Direction signs")],
      },
      {
        page: 271,
        images: [],
        lines: [caption(69.4, "Junction number on multilane roads")],
      },
    ];
    expect(pairSigns(pages, isSectionName)[0].name).toBe(
      "Junction number on multilane roads",
    );
  });

  it("reports an unpaired image rather than inventing a name", () => {
    const pages: PageInput[] = [
      {
        page: 304,
        images: [image(70.8, 295.8)],
        lines: [heading(60, "Warning signs")],
      },
    ];
    expect(pairSigns(pages, isSectionName)[0].name).toBeNull();
  });
});
