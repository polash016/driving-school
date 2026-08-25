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

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");
const db = new PrismaClient();

const PUBLIC_SIGNS_DIR = join(process.cwd(), "public", "signs");

const bilingual = z.object({ en: z.string().min(1), nb: z.string().min(1) });

const manifestSchema = z.object({
  signs: z
    .array(
      z.object({
        code: z.string().min(1).max(16),
        signClass: z.enum([
          "FARE",
          "VIKEPLIKT_OG_FORKJORS",
          "FORBUD",
          "PABUD",
          "OPPLYSNING",
          "SERVICE",
          "VEGVISNING",
          "UNDERSKILT",
        ]),
        file: z.string().min(1),
        name: bilingual,
        meaning: bilingual,
        /** Provisional assets (not the official pack) are flagged so they can be found later. */
        provisional: z.boolean().optional(),
        sourceNote: z.string().optional(),
      }),
    )
    .min(1),
});

async function main(): Promise<void> {
  const path = process.argv[2] ?? join(process.cwd(), "prisma", "data", "signs.json");
  if (!existsSync(path)) {
    console.error(`No manifest at ${path}.`);
    console.error("Copy prisma/data/signs.example.json to prisma/data/signs.json, add the sign");
    console.error("images to public/signs/, then run this again. The example file explains where");
    console.error("the official assets come from and why Wikimedia is not a usable source.");
    process.exitCode = 1;
    return;
  }

  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));

  // Validate every file first: a partial seed leaves a registry that is broken in the middle.
  const missing = manifest.signs.filter((sign) => !existsSync(join(PUBLIC_SIGNS_DIR, sign.file)));
  if (missing.length > 0) {
    console.error(`${missing.length} sign image(s) missing from public/signs/:`);
    for (const sign of missing) console.error(`  ${sign.code} → ${sign.file}`);
    process.exitCode = 1;
    return;
  }

  let created = 0;
  let updated = 0;
  for (const sign of manifest.signs) {
    const existing = await db.sign.findUnique({ where: { code: sign.code }, select: { id: true } });
    await db.sign.upsert({
      where: { code: sign.code },
      create: {
        code: sign.code,
        signClass: sign.signClass,
        svgPath: `/signs/${sign.file}`,
        name: sign.name,
        meaning: sign.meaning,
        isActive: true,
      },
      update: {
        signClass: sign.signClass,
        svgPath: `/signs/${sign.file}`,
        name: sign.name,
        meaning: sign.meaning,
      },
      select: { id: true },
    });
    if (existing) updated++;
    else created++;
  }

  const provisional = manifest.signs.filter((sign) => sign.provisional).length;
  console.log(`Signs: ${created} added, ${updated} updated.`);
  if (provisional > 0) {
    console.log(
      `${provisional} marked provisional — replace them with the official assets before the sign test goes live.`,
    );
  }

  const byClass = await db.sign.groupBy({ by: ["signClass"], _count: { _all: true } });
  console.log("Coverage:", byClass.map((row) => `${row.signClass}=${row._count._all}`).join(" "));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
