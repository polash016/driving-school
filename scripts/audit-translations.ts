/**
 * Re-check every stored translation of a language against the gate as it is today (spec-21).
 *
 *   pnpm i18n:audit <code>                    # report only — nothing is written
 *   pnpm i18n:audit <code> --apply            # hold what the gate refuses, with a fresh repair budget
 *   pnpm i18n:audit <code> --apply --repair   # …and queue a REPAIR run for the background worker
 *
 * Exists because the gate only ever ran on the way in: production held 23 approved Bangla
 * questions in Latin letters that the gate of the day had passed. No AI call is made here.
 */
import { PrismaClient } from "@prisma/client";
import { auditTranslations } from "../src/server/services/i18n/audit";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);
const db = new PrismaClient();

async function main(): Promise<void> {
  const code = process.argv[2];
  if (!code) {
    throw new Error("Usage: pnpm i18n:audit <code> [--apply] [--repair]");
  }
  const apply = process.argv.includes("--apply");
  const repair = process.argv.includes("--repair");

  const report = await auditTranslations(db, null, code, { apply, repair });

  console.log(
    `${code}: checked ${report.checked}, ${report.flagged} refused by the current checks.`,
  );
  for (const [flag, count] of Object.entries(report.byCode)) {
    console.log(`  ${flag.padEnd(18)} ${count}`);
  }
  for (const example of report.examples) {
    console.log(
      `  - ${example.entity} ${example.entityId} "${example.label}" — ${example.detail || example.codes.join(", ")}`,
    );
  }
  if (report.flagged > report.examples.length) {
    console.log(`  … and ${report.flagged - report.examples.length} more.`);
  }

  if (!apply) {
    console.log(
      "\nReport only. Re-run with --apply to hold them for review, and --repair to queue the repair run.",
    );
    return;
  }
  console.log(
    report.repairRunId
      ? `Held for review; REPAIR run ${report.repairRunId} queued for the worker.`
      : repair
        ? "Held for review; no repair queued (a run is already live, or nothing is under the ceiling)."
        : 'Held for review. Press "Repair … in background" on the language card, or re-run with --repair.',
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
