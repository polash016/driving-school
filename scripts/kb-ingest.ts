/**
 * Load a legal source into the knowledge base (spec-05).
 *
 *   pnpm kb:ingest <sourceCode> <file-or-url> [--name "Trafikkreglene"] [--kind REGULATION]
 *
 * Norwegian statutes and regulations are not covered by copyright (åndsverkloven § 14), so their
 * text may be used freely. What a publisher adds around them — navigation, notes, formatting — is
 * theirs, which is why this strips everything down to the regulation's own text.
 *
 * Re-running for the same source code REPLACES its chunks and flags every approved question
 * citing the old ones for re-review. That is the law-change safety mechanism, not a side effect.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { ingestSource } from "../src/server/services/kb/ingest";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);
const db = new PrismaClient();

/**
 * Reduce a regulation page to "§ N. Title" followed by that section's own text.
 *
 * Segmenting on the `PARAGRAF_n` anchors is what makes this reliable: the table of contents
 * repeats every heading, so a naive pass over `<h2>` elements ingests each section twice — once
 * as a heading with no body. Only the real section divs carry that id.
 */
function htmlToLegalText(html: string): string {
  const strip = (fragment: string) =>
    fragment
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<br[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&(?:#167|sect);/g, "§")
      .replace(/&(?:#8212|mdash);/g, "—")
      .replace(/&(?:#8211|ndash);/g, "–")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/[ \t]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");

  const segments = html.split(/id="PARAGRAF_/).slice(1);
  if (segments.length === 0) return strip(html);

  const sections: string[] = [];
  for (const segment of segments) {
    const number = segment.match(
      /paragrafValue[^>]*>\s*§?\s*([\w-]+)\.?\s*</,
    )?.[1];
    const title = segment
      .match(/paragrafTittel[^>]*>\s*(?:<em[^>]*>)?\s*([^<]+)/)?.[1]
      ?.trim();
    const header = `§ ${number}. ${title ?? ""}`.trim();

    // The body is everything after the heading. Three bits of Lovdata markup have to come off
    // first, or every chunk carries them into the prompts that ground a legal citation:
    //   - the tail of the anchor we just split on (`3">`), which reads as content once tags go,
    //   - the heading, which Lovdata repeats inside the section body, and
    //   - "Del paragraf", its share-this-section control.
    const afterAnchor = segment.replace(/^[^>]*>/, "");
    const headingEnd = afterAnchor.search(/<\/h[1-6]>/i);
    const body = strip(headingEnd >= 0 ? afterAnchor.slice(headingEnd) : afterAnchor)
      .split("\n")
      .filter((line) => line.trim() !== header && line.trim() !== "Del paragraf")
      .map((line) => line.replace(/\s*Del paragraf\s*$/, "").trim())
      .filter(Boolean)
      .join("\n");
    if (!number || body.length < 20) continue;

    sections.push(header + "\n" + body);
  }

  return sections.join("\n\n");
}

async function main(): Promise<void> {
  const [code, location, ...rest] = process.argv.slice(2);
  if (!code || !location) {
    throw new Error(
      'Usage: pnpm kb:ingest <sourceCode> <file-or-url> [--name "..."] [--kind LAW|REGULATION|CURRICULUM|TEMALISTE|NOTE]',
    );
  }
  const flag = (name: string, fallback: string) => {
    const index = rest.indexOf(`--${name}`);
    return index >= 0 ? (rest[index + 1] ?? fallback) : fallback;
  };

  const isUrl = /^https?:\/\//.test(location);
  const raw = isUrl
    ? await fetch(location, { headers: { "user-agent": "TeoriPro/0.1" } }).then(
        (res) => {
          if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
          return res.text();
        },
      )
    : await readFile(location, "utf8");

  const text = isUrl || /<html/i.test(raw) ? htmlToLegalText(raw) : raw;
  const sections = (text.match(/^§/gm) ?? []).length;
  console.log(`Read ${text.length} characters, ${sections} sections.`);
  if (text.length < 200)
    throw new Error("Extracted text is implausibly short — check the source.");

  const result = await ingestSource(db, null, {
    code,
    kind: flag("kind", "REGULATION"),
    name: flag("name", code),
    ...(isUrl ? { url: location } : {}),
    text,
  });

  console.log(
    `Ingested ${result.chunksCreated} chunks into "${result.sourceCode}"` +
      (result.chunksReplaced > 0
        ? ` (replaced ${result.chunksReplaced}; ${result.itemsFlagged} approved question(s) flagged for re-review)`
        : ""),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Both handles keep a CLI process alive: the route cache opens Redis on the first AI call.
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
