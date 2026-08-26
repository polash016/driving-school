/**
 * Load hand-supplied translations (spec-15).
 *
 *   pnpm i18n:import <code> <file.json>
 *   pnpm i18n:import <code> <file.json> --approve
 *
 * The file is `{ "UI_MESSAGE": { "<key>": {...payload} }, "TOPIC": { "<slug>": {...} }, … }` —
 * keyed by entity, then by the natural identifier for that entity (a message key, a topic slug,
 * a licence-class code, a KB source code, or a master item id).
 *
 * Every row goes through the SAME structural gate the AI's output faces: numbers preserved, §
 * references untouched, option keys identical, ICU placeholders intact. A human — or a model
 * writing a file by hand — drops a placeholder exactly as easily as the pipeline does, and the
 * consequence in front of a student is identical.
 *
 * `--approve` marks what passes as APPROVED. Use it only when whoever produced the file is
 * standing behind it; without it, rows land as MACHINE and follow the language's own policy.
 */
import { readFileSync } from "node:fs";
import { PrismaClient, type TranslatableEntity } from "@prisma/client";
import { extractAll } from "../src/server/services/i18n/extract";
import { deriveVariantTranslations } from "../src/server/services/i18n/runs";
import { invalidateMessages } from "../src/server/services/i18n/catalogue";
import { checkTranslation, allCodes } from "../src/server/services/i18n/validation";
import type { UnitPayload } from "../src/server/services/i18n/units";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");
const db = new PrismaClient();

type FileShape = Partial<Record<TranslatableEntity, Record<string, UnitPayload>>>;

/** Natural identifiers, so a file can be written without knowing any cuid. */
async function idResolver(entity: TranslatableEntity): Promise<Map<string, string>> {
  switch (entity) {
    case "TOPIC": {
      const rows = await db.topic.findMany({ select: { id: true, slug: true } });
      return new Map(rows.map((row) => [row.slug, row.id]));
    }
    case "LICENSE_CLASS": {
      const rows = await db.licenseClass.findMany({ select: { id: true, code: true } });
      return new Map(rows.map((row) => [row.code, row.id]));
    }
    case "SIGN": {
      const rows = await db.sign.findMany({ select: { id: true, code: true } });
      return new Map(rows.map((row) => [row.code, row.id]));
    }
    default:
      // UI_MESSAGE keys, KB_SOURCE codes and MASTER_ITEM ids are already the identifier.
      return new Map();
  }
}

async function main(): Promise<void> {
  const code = process.argv[2];
  const file = process.argv[3];
  const approve = process.argv.includes("--approve");
  if (!code || !file) {
    throw new Error("Usage: pnpm i18n:import <code> <file.json> [--approve]");
  }

  const language = await db.language.findUniqueOrThrow({
    where: { code },
    select: { code: true, englishName: true, isBuiltIn: true, glossaryVersion: true },
  });
  if (language.isBuiltIn) {
    throw new Error(`${code} is authored, not translated — importing would overwrite the source`);
  }

  const payload = JSON.parse(readFileSync(file, "utf8")) as FileShape;
  const units = await extractAll(db, { glossaryVersion: language.glossaryVersion });
  const byKey = new Map(units.map((unit) => [`${unit.entity}:${unit.entityId}`, unit]));

  let written = 0;
  let flagged = 0;
  let unknown = 0;
  const masterIds: string[] = [];
  let touchedMessages = false;

  for (const [rawEntity, entries] of Object.entries(payload)) {
    const entity = rawEntity as TranslatableEntity;
    const resolver = await idResolver(entity);

    for (const [rawId, value] of Object.entries(entries ?? {})) {
      const entityId = resolver.get(rawId) ?? rawId;
      const unit = byKey.get(`${entity}:${entityId}`);
      if (!unit) {
        // Silence here would mean a typo in the file quietly translating nothing.
        console.warn(`  ? no such source: ${entity} ${rawId}`);
        unknown++;
        continue;
      }

      const check = checkTranslation({
        entity,
        locale: code,
        source: unit.en,
        translated: value,
        ...(unit.correctOptionKey ? { correctOptionKey: unit.correctOptionKey } : {}),
      });
      const flags = allCodes(check);
      if (!check.passed) {
        flagged++;
        console.warn(`  ! held for review: ${entity} ${rawId} — ${flags.join(", ")}`);
      }

      const status = !check.passed ? "NEEDS_REVIEW" : approve ? "APPROVED" : "MACHINE";
      await db.translation.upsert({
        where: { locale_entity_entityId: { locale: code, entity, entityId } },
        create: {
          locale: code,
          entity,
          entityId,
          value: value as object,
          status,
          sourceHash: unit.sourceHash,
          qaFlags: flags,
          // Honest provenance: this text did not come through the AI gateway.
          providerLabel: "import",
          qaReport: { source: "import", issues: check.issues } as object,
        },
        update: {
          value: value as object,
          status,
          sourceHash: unit.sourceHash,
          qaFlags: flags,
          providerLabel: "import",
          qaReport: { source: "import", issues: check.issues } as object,
          modelVersion: null,
          promptVersion: null,
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
        select: { id: true },
      });

      if (entity === "MASTER_ITEM" && check.passed) masterIds.push(entityId);
      if (entity === "UI_MESSAGE") touchedMessages = true;
      written++;
    }
  }

  // Approved question translations are what students are actually served, via the variant rows.
  if (masterIds.length > 0) {
    const derived = await deriveVariantTranslations(db, code, masterIds);
    console.log(`Derived ${derived} variant translation(s) at no token cost.`);
  }
  if (touchedMessages) await invalidateMessages(code);

  console.log(
    `${language.englishName}: wrote ${written}, held ${flagged} for review, ` +
      `skipped ${unknown} with no matching source.`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
