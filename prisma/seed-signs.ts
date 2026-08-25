/**
 * Seed the sign registry from a manifest (spec-05).
 *
 *   pnpm db:seed-signs [path/to/signs.json]
 *
 * The manifest is the source of truth for codes, classes and bilingual meanings; the image files
 * live in public/signs/. Every entry is validated against an existing file before anything is
 * written — a sign registry with a missing image produces a sign test that shows a broken box,
 * which is worse than not offering the test.
 *
 * Idempotent: re-running updates existing codes and adds new ones.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);
const db = new PrismaClient();

const PUBLIC_SIGNS_DIR = join(process.cwd(), "public", "signs");

const bilingual = z.object({ en: z.string().min(1), nb: z.string().min(1) });

const manifestSchema = z.object({
  signs: z
    .array(
      z.object({
        code: z.string().min(1).max(16),
        // Must stay in step with the SignClass enum in schema.prisma. MARKERING was missing here,
        // which silently rejected every marker sign (oppmerkingsskilt) at the manifest boundary.
        signClass: z.enum([
          "FARE",
          "VIKEPLIKT_OG_FORKJORS",
          "FORBUD",
          "PABUD",
          "OPPLYSNING",
          "SERVICE",
          "VEGVISNING",
          "UNDERSKILT",
          "MARKERING",
        ]),
        file: z.string().min(1),
        /**
         * Optional because `pnpm signs:extract` produces the English name and nothing else, and
         * `pnpm signs:enrich` fills the rest against a metered API that can stop partway. A sign
         * without complete bilingual text is SKIPPED with a count, not rejected — otherwise one
         * unfinished sign would keep the other 286 out of the registry.
         */
        name: bilingual.partial().extend({ en: z.string().min(1) }),
        meaning: bilingual.optional(),
        /** Provisional assets (not the official pack) are flagged so they can be found later. */
        provisional: z.boolean().optional(),
        sourceNote: z.string().optional(),
      }),
    )
    .min(1),
});

async function main(): Promise<void> {
  const path =
    process.argv[2] ?? join(process.cwd(), "prisma", "data", "signs.json");
  if (!existsSync(path)) {
    console.error(`No manifest at ${path}.`);
    console.error(
      "Copy prisma/data/signs.example.json to prisma/data/signs.json, add the sign",
    );
    console.error(
      "images to public/signs/, then run this again. The example file explains where",
    );
    console.error(
      "the official assets come from and why Wikimedia is not a usable source.",
    );
    process.exitCode = 1;
    return;
  }

  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );

  // Validate every file first: a partial seed leaves a registry that is broken in the middle.
  const missing = manifest.signs.filter(
    (sign) => !existsSync(join(PUBLIC_SIGNS_DIR, sign.file)),
  );
  if (missing.length > 0) {
    console.error(
      `${missing.length} sign image(s) missing from public/signs/:`,
    );
    for (const sign of missing) console.error(`  ${sign.code} → ${sign.file}`);
    process.exitCode = 1;
    return;
  }

  // A sign is servable only once it has a name AND a meaning in BOTH languages: the sign test asks
  // what a sign means, and half a translation in front of a Norwegian student is worse than the
  // sign simply not being in the pool yet.
  const ready = manifest.signs.filter(
    (
      sign,
    ): sign is typeof sign & {
      name: { en: string; nb: string };
      meaning: { en: string; nb: string };
    } => Boolean(sign.name.nb && sign.meaning?.en && sign.meaning?.nb),
  );
  const incomplete = manifest.signs.length - ready.length;

  let created = 0;
  let updated = 0;
  for (const sign of ready) {
    const existing = await db.sign.findUnique({
      where: { code: sign.code },
      select: { id: true },
    });
    await db.sign.upsert({
      where: { code: sign.code },
      create: {
        code: sign.code,
        signClass: sign.signClass,
        svgPath: `/signs/${sign.file}`,
        name: sign.name,
        meaning: sign.meaning,
        isActive: true,
        provisional: sign.provisional ?? false,
        sourceNote: sign.sourceNote ?? null,
      },
      update: {
        signClass: sign.signClass,
        svgPath: `/signs/${sign.file}`,
        name: sign.name,
        meaning: sign.meaning,
        // Deliberately NOT re-flagging: once a person has cleared `provisional` in /admin/signs,
        // a later re-seed from the same manifest must not quietly undo that review.
        ...(sign.provisional === false ? { provisional: false } : {}),
        sourceNote: sign.sourceNote ?? null,
      },
      select: { id: true },
    });
    if (existing) updated++;
    else created++;
  }

  const provisional = ready.filter((sign) => sign.provisional).length;
  console.log(`Signs: ${created} added, ${updated} updated.`);
  if (incomplete > 0) {
    console.log(
      `${incomplete} sign(s) skipped — no bilingual name and meaning yet. Run: pnpm signs:enrich`,
    );
  }
  if (provisional > 0) {
    console.log(
      `${provisional} marked provisional — review them in /admin/signs and replace the graphics with the official Statens vegvesen assets before launch.`,
    );
  }

  const byClass = await db.sign.groupBy({
    by: ["signClass"],
    _count: { _all: true },
  });
  console.log(
    "Coverage:",
    byClass.map((row) => `${row.signClass}=${row._count._all}`).join(" "),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
