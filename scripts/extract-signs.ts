/**
 * Build the sign registry manifest from the theory book's traffic-signs chapter.
 *
 *   pnpm signs:extract [path/to/theory-book.pdf]
 *
 * This is a ONE-OFF ingestion step. Its output — `public/signs/*.png` and
 * `prisma/data/signs.json` — is committed, so `mutool` and `pdfimages` (poppler-utils +
 * mupdf-tools) are developer-machine prerequisites and never build or deploy dependencies.
 *
 * How the pairing works. The chapter lays out one sign graphic per caption, image above caption,
 * under a section heading that names the sign class. Neither poppler nor mupdf will hand you that
 * association, so it is reconstructed from geometry:
 *
 *   - `mutool trace`            → each image's placement matrix (x, y, w, h) in page space
 *   - `mutool draw -F stext`    → each text LINE's bounding box, characters and font size
 *   - walk both in y-order      → a heading updates the current sign class; an image takes the
 *                                 first caption starting at or below `imageBottom - 15`
 *
 * Four things break naive pairing, all of them found by checking the output against the official
 * sign catalogue rather than by assuming:
 *
 *   1. Font size is the ONLY reliable heading test. "Street sign" reads like a section name but is
 *      set at caption size — it is the caption of one direction sign, not a group. Position cannot
 *      settle this: a real heading often sits exactly where a caption would. Headings are 28.56pt,
 *      captions 10.56/11.04pt, so the split is at 20pt.
 *   2. Work at LINE level, not block level. A caption and the following section heading sometimes
 *      share one block, and a block reports the union of its font sizes — which loses the very
 *      distinction point 1 depends on.
 *   3. The caption's top edge can sit slightly ABOVE the image's bottom edge, because the image
 *      placement rect includes the printed white margin. A tight tolerance silently shifts every
 *      caption in a group by one, which is how "Give way" ends up labelled "Stop". Hence -15.
 *   4. A caption can spill onto the next page, so the last image on a page falls through to it.
 *
 * Multi-line captions ("No motor vehicles with more than two wheels and…") are re-joined by
 * merging consecutive caption lines less than 6pt apart.
 *
 * PROVENANCE: these graphics are reproductions from a copyrighted third-party theory book. The
 * sign DESIGNS are defined by skiltforskriften and are not anyone's artwork, but this is not the
 * official Statens vegvesen asset pack. Every entry is written with `provisional: true` and a
 * `sourceNote` naming book and page, so the official files can be swapped in per sign later
 * (see prisma/data/signs.example.json and /admin/signs).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { CAPTION_TOLERANCE, splitLines, type TextLine } from "./sign-pairing";

const run = promisify(execFile);

const DEFAULT_PDF = join(process.cwd(), "traffic_rules", "theory book.pdf");
const SIGNS_DIR = join(process.cwd(), "public", "signs");
const MANIFEST = join(process.cwd(), "prisma", "data", "signs.json");

/** The traffic-signs chapter. Page 175 is the chapter title page and carries no sign graphic. */
const FIRST_PAGE = 176;
const LAST_PAGE = 304;

/**
 * What the book calls each group → the SignClass enum, plus the code prefix for that class.
 * These are the nine headings the chapter actually sets in heading type, and they line up
 * one-for-one with the nine SignClass values.
 */
const SECTIONS: Record<string, { signClass: string; prefix: string }> = {
  "Warning signs": { signClass: "FARE", prefix: "FA" },
  "Give way and priority signs": {
    signClass: "VIKEPLIKT_OG_FORKJORS",
    prefix: "VP",
  },
  "Prohibitory signs": { signClass: "FORBUD", prefix: "FO" },
  "Mandatory signs": { signClass: "PABUD", prefix: "PA" },
  "Informative signs": { signClass: "OPPLYSNING", prefix: "OP" },
  "Service information signs": { signClass: "SERVICE", prefix: "SE" },
  "Direction signs": { signClass: "VEGVISNING", prefix: "VV" },
  "Supplementary signs": { signClass: "UNDERSKILT", prefix: "UN" },
  "Marker signs": { signClass: "MARKERING", prefix: "MA" },
};

/** Every image in the chapter must come out named and classified, or the run is not trustworthy. */
const EXPECTED_IMAGES = 287;

type Placement = { y: number; y2: number };
type Page = { images: Placement[]; headings: TextLine[]; captions: TextLine[] };

type ExtractedSign = {
  code: string;
  signClass: string;
  file: string;
  name: { en: string };
  provisional: true;
  sourceNote: string;
  page: number;
  indexOnPage: number;
};

async function mutool(args: string[]): Promise<string> {
  const { stdout } = await run("mutool", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Image placement rectangles, in page order.
 *
 * `transform="a b c d e f"` is the matrix that maps the unit square onto the page, so for the
 * upright images this chapter uses, width is |a|, height is |d| and (e, f) is the top-left corner.
 */
async function placements(page: number): Promise<Placement[]> {
  const trace = await mutool(["trace", PDF, String(page)]);
  const out: Placement[] = [];
  for (const match of trace.matchAll(/<fill_image[^>]*transform="([^"]+)"/g)) {
    const [, , , d, , f] = match[1].split(/\s+/).map(Number);
    out.push({ y: f, y2: f + Math.abs(d) });
  }
  return out.sort((a, b) => a.y - b.y);
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Text lines split into section headings and captions by font size, with page-footer numbers and
 * the Symbol-font bullet (U+F0B7) the book prints before each caption dropped.
 */
async function text(
  page: number,
): Promise<{ headings: TextLine[]; captions: TextLine[] }> {
  const stext = await mutool([
    "draw",
    "-F",
    "stext",
    "-o",
    "-",
    PDF,
    String(page),
  ]);
  const lines: TextLine[] = [];
  for (const match of stext.matchAll(
    /<line bbox="([^"]+)"[^>]*>([\s\S]*?)<\/line>/g,
  )) {
    const [, y, , y2] = match[1].split(/\s+/).map(Number);
    const value = [...match[2].matchAll(/\sc="([^"]*)"/g)]
      .map((c) => decode(c[1]))
      .join("")
      .replace(/\uf0b7/g, "")
      .trim();
    if (!value || /^\d+$/.test(value)) continue; // page footer
    const sizes = [...match[2].matchAll(/<font [^>]*size="([\d.]+)"/g)].map(
      (s) => Number(s[1]),
    );
    lines.push({ y, y2, text: value, size: Math.max(0, ...sizes) });
  }
  // Shared with scripts/sign-pairing.test.ts, which pins down the four cases these rules exist for.
  return splitLines(lines, (value) => value in SECTIONS);
}

/** Raw image bytes for one page, in the same order `mutool trace` reports their placements. */
async function pageImages(page: number, dir: string): Promise<string[]> {
  const prefix = join(dir, `p${page}`);
  await run("pdfimages", [
    "-png",
    "-f",
    String(page),
    "-l",
    String(page),
    PDF,
    prefix,
  ]);
  return (await readdir(dir))
    .filter((f) => f.startsWith(`p${page}-`))
    .sort()
    .map((f) => join(dir, f));
}

const PDF = process.argv[2] ?? DEFAULT_PDF;

async function main(): Promise<void> {
  if (!existsSync(PDF)) {
    console.error(`No PDF at ${PDF}`);
    console.error("Usage: pnpm signs:extract [path/to/theory-book.pdf]");
    process.exitCode = 1;
    return;
  }

  const scratch = join(tmpdir(), `teoripro-signs-${process.pid}`);
  await mkdir(scratch, { recursive: true });
  await mkdir(SIGNS_DIR, { recursive: true });

  // A re-run replaces the whole registry: a stale file left behind from a previous extraction
  // would seed a sign whose image no longer matches its name.
  for (const file of await readdir(SIGNS_DIR)) {
    if (file.endsWith(".png")) await rm(join(SIGNS_DIR, file));
  }

  const signs: ExtractedSign[] = [];
  const counters = new Map<string, number>();
  const unpaired: string[] = [];
  let signClass: string | null = null;
  let prefix = "";

  // Captions can run onto the next page, so every page is parsed before any is paired.
  const pages = new Map<number, Page>();
  for (let page = FIRST_PAGE; page <= LAST_PAGE; page++) {
    pages.set(page, { images: await placements(page), ...(await text(page)) });
  }

  for (let page = FIRST_PAGE; page <= LAST_PAGE; page++) {
    const { images, headings, captions } = pages.get(page)!;
    const next = pages.get(page + 1)?.captions ?? [];

    // Headings and images interleave down the page; walking them in y-order is what keeps a sign
    // in the class whose heading precedes it.
    const timeline = [
      ...images.map((image) => ({ y: image.y, image })),
      ...headings.map((h) => ({ y: h.y, heading: h.text })),
    ].sort((a, b) => a.y - b.y);

    const files = images.length > 0 ? await pageImages(page, scratch) : [];
    if (files.length !== images.length) {
      console.error(
        `Page ${page}: ${images.length} placements but ${files.length} extracted images — ` +
          "draw order cannot be trusted, refusing to guess.",
      );
      process.exitCode = 1;
      return;
    }

    let indexOnPage = 0;
    for (const entry of timeline) {
      if ("heading" in entry) {
        signClass = SECTIONS[entry.heading].signClass;
        prefix = SECTIONS[entry.heading].prefix;
        continue;
      }
      const image = entry.image;
      const below = captions.filter((c) => c.y >= image.y2 - CAPTION_TOLERANCE);
      const caption = (below[0] ?? next[0])?.text;

      if (!caption || !signClass) {
        unpaired.push(`page ${page} image ${indexOnPage}`);
        indexOnPage++;
        continue;
      }

      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      const code = `X${prefix}${String(n).padStart(3, "0")}`;

      // Trim the printed white margin, pad back to square so signs of different aspect ratios sit
      // consistently in a quiz card, and normalise the size. The source tiles are ~300px, so 320
      // is the most detail actually present — upscaling past it only inflates the payload. A
      // palette PNG is a large win on flat-colour artwork like this and is visually lossless here.
      await sharp(files[indexOnPage])
        .trim()
        .resize(320, 320, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255, alpha: 0 },
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9, palette: true })
        .toFile(join(SIGNS_DIR, `${code}.png`));

      signs.push({
        code,
        signClass,
        file: `${code}.png`,
        name: { en: caption },
        provisional: true,
        sourceNote: `Norwegian Driving Licence Theory, chapter 10, page ${page} — "${caption}". Replace with the official Statens vegvesen asset.`,
        page,
        indexOnPage,
      });
      indexOnPage++;
    }
  }

  await rm(scratch, { recursive: true, force: true });

  if (unpaired.length > 0) {
    console.error(
      `${unpaired.length} image(s) could not be paired with a name and class:`,
    );
    for (const u of unpaired.slice(0, 20)) console.error(`  ${u}`);
    process.exitCode = 1;
    return;
  }
  if (signs.length !== EXPECTED_IMAGES) {
    console.error(
      `Extracted ${signs.length} signs but expected ${EXPECTED_IMAGES}. The source PDF changed — ` +
        "check the chapter page range before accepting this.",
    );
    process.exitCode = 1;
    return;
  }

  const existing = existsSync(MANIFEST)
    ? JSON.parse(await readFile(MANIFEST, "utf8"))
    : { signs: [] };
  // Enrichment (meanings, Norwegian) is written back into this same file; a re-extract must not
  // silently discard it. Codes are stable across runs, so previous text is carried forward.
  const enriched = new Map<string, Record<string, unknown>>(
    (existing.signs ?? []).map((s: { code: string }) => [s.code, s]),
  );

  await writeFile(
    MANIFEST,
    `${JSON.stringify(
      {
        _readme: [
          "GENERATED by `pnpm signs:extract` from the theory book, then filled in by",
          "`pnpm signs:enrich`. Seed it with `pnpm db:seed-signs`.",
          "",
          "Every entry is provisional: the graphics are reproductions from a copyrighted",
          "third-party book, not the official Statens vegvesen asset pack, and the codes are",
          "internal placeholders (X<class><nnn>) rather than skiltforskriften codes. Both are",
          "correctable per sign in /admin/signs.",
        ],
        signs: signs.map((sign) => {
          const prior = enriched.get(sign.code);
          return {
            ...sign,
            name: { ...sign.name, ...(prior?.name as object | undefined) },
            ...(prior?.meaning ? { meaning: prior.meaning } : {}),
          };
        }),
      },
      null,
      2,
    )}\n`,
  );

  const byClass = signs.reduce<Record<string, number>>((acc, s) => {
    acc[s.signClass] = (acc[s.signClass] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Extracted ${signs.length} signs to ${SIGNS_DIR}`);
  console.log(
    "By class:",
    Object.entries(byClass)
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );
  console.log(`Manifest: ${MANIFEST}`);
  console.log("Next: pnpm signs:enrich  (adds meanings and Norwegian)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
