/**
 * Translate a language (spec-15).
 *
 *   pnpm i18n:translate <code>              # plan and show the cost, translate nothing
 *   pnpm i18n:translate <code> --apply      # plan, then run it
 *   pnpm i18n:translate <code> --apply --max 20   # a bounded slice, to try it cheaply first
 *   pnpm i18n:translate <code> --apply --only UI_MESSAGE
 *
 * Resumable by design: the work is planned into rows and claimed under a lease, so a killed
 * process loses nothing. Re-running continues where it stopped and re-translates nothing that is
 * already done.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient, type TranslatableEntity } from "@prisma/client";
import { executeRun, planRun } from "../src/server/services/i18n/runs";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");
const db = new PrismaClient();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const code = process.argv[2];
  if (!code) throw new Error("Usage: pnpm i18n:translate <code> [--apply] [--max N] [--only ENTITY]");
  const apply = process.argv.includes("--apply");
  const max = flag("max") ? Number(flag("max")) : undefined;
  const only = flag("only") ? ([flag("only")] as TranslatableEntity[]) : undefined;

  const language = await db.language.findUniqueOrThrow({
    where: { code },
    select: { englishName: true, nativeName: true, requiresApproval: true, qaSampleRate: true },
  });

  const plan = await planRun(db, code, {
    kind: only ? "SINGLE_ENTITY" : "SYNC",
    ...(only ? { only } : {}),
  });
  console.log(
    `${language.englishName} (${language.nativeName}) — ${plan.plannedUnits} unit(s) need translating.`,
  );
  for (const [entity, count] of Object.entries(plan.byEntity).sort()) {
    console.log(`  ${entity.padEnd(16)} ${count}`);
  }
  console.log(
    `Estimated ${(plan.estimatedPromptTokens / 1000).toFixed(1)}k in / ` +
      `${(plan.estimatedCompletionTokens / 1000).toFixed(1)}k out ≈ $${plan.estimatedUsd.toFixed(2)}. ` +
      `QA back-translation runs on ${Math.round(language.qaSampleRate * 100)}% of units, which roughly doubles that.`,
  );
  console.log(
    language.requiresApproval
      ? "This language requires approval: translations will land for review, not in front of students."
      : "This language does not require approval: clean translations serve as soon as they are written.",
  );

  if (plan.plannedUnits === 0) {
    console.log("\nNothing to do — everything is already translated from the current source text.");
    return;
  }
  if (!apply) {
    console.log("\nPlan only. Re-run with --apply to translate.");
    return;
  }

  console.log("");
  const progress = await executeRun(db, plan.runId, {
    leaseOwner: `cli-${randomUUID().slice(0, 8)}`,
    maxUnits: max,
    onProgress: (state) =>
      console.log(
        `  ${state.completed}/${state.planned} translated · ${state.flagged} held for review · ` +
          `${state.memoryHits} from memory · ${state.failed} failed`,
      ),
  });

  console.log(
    `\n${progress.completed}/${progress.planned} translated. ` +
      `${progress.flagged} held for review, ${progress.memoryHits} came free from memory, ${progress.failed} failed.`,
  );
  console.log(progress.done ? "Run complete." : "Run paused — re-run to continue.");
}

main()
  .catch((error) => {
    const meta = (error as { meta?: unknown }).meta;
    console.error(error instanceof Error ? error.message : error);
    if (meta) console.error(JSON.stringify(meta, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
