/**
 * One-off cleanup: embed every question written before similarity existed, delete the repeats,
 * and group what is left into alternates.
 *
 *   pnpm qb:dedupe            # report only
 *   pnpm qb:dedupe --apply    # retire + delete the repeats (audited, kept as a lesson for the AI)
 *
 * Which of a pair survives is deliberate: an APPROVED question outranks a draft, and among equals
 * the older one wins.
 *
 * A duplicate is retired first (so it leaves the serving pool and is filed in the rejection ledger
 * the next generation run learns from), then deleted. A question a student has actually sat is NOT
 * deleted — `deleteItem` refuses it, and that refusal is the point: an exam record must keep
 * pointing at the question that was asked. Those stay retired, which already removes them from
 * every future test.
 *
 * Removing one half of a pair changes who everyone's nearest neighbour is, so this runs in rounds
 * until nothing is left above the repeat threshold.
 */
import { PrismaClient } from "@prisma/client";
import type { SessionUser } from "../src/server/authz";
import {
  backfillEmbeddings,
  findRepeatPairs,
  regroupAlternates,
} from "../src/server/services/question-bank/similarity";
import { transitionItem } from "../src/server/services/question-bank/transitions";
import { deleteItem } from "../src/server/services/question-bank/items";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");
const db = new PrismaClient();

/** A stronger status wins; among equals the older question wins. */
const RANK: Record<string, number> = {
  APPROVED: 3,
  IN_REVIEW: 2,
  NEEDS_REVIEW: 2,
  DRAFT: 1,
  RETIRED: 0,
};
const MAX_ROUNDS = 10;

interface Totals {
  retired: number;
  deleted: number;
  keptForRecord: number;
}

async function resolveRound(admin: SessionUser, apply: boolean, totals: Totals): Promise<number> {
  const repeats = await findRepeatPairs(db);
  if (repeats.length === 0) return 0;

  for (const repeat of repeats) {
    const [candidate, match] = await Promise.all([
      db.masterItem.findUnique({
        where: { id: repeat.id },
        select: { id: true, status: true, createdAt: true, deletedAt: true, content: true },
      }),
      db.masterItem.findUnique({
        where: { id: repeat.matchedItemId },
        select: { id: true, status: true, createdAt: true, deletedAt: true },
      }),
    ]);
    // An earlier pair in this same round may already have removed one of them.
    if (!candidate || !match || candidate.deletedAt || match.deletedAt) continue;

    const keepMatch =
      (RANK[match.status] ?? 0) > (RANK[candidate.status] ?? 0) ||
      ((RANK[match.status] ?? 0) === (RANK[candidate.status] ?? 0) &&
        match.createdAt <= candidate.createdAt);
    const loser = keepMatch ? candidate : match;
    const winner = keepMatch ? match : candidate;

    const stem = (candidate.content as { en?: { stem?: string } })?.en?.stem ?? "";
    console.log(
      `  ${repeat.similarity.toFixed(3)}  drop ${loser.id} (${loser.status}) ` +
        `keep ${winner.id} (${winner.status})  — ${stem.slice(0, 90)}`,
    );
    if (!apply) continue;

    if (loser.status !== "RETIRED") {
      try {
        await transitionItem(db, admin, {
          id: loser.id,
          to: "RETIRED",
          reason: "DUPLICATE",
          note: `Same question as ${winner.id} (cosine ${repeat.similarity.toFixed(3)}).`,
        });
        totals.retired++;
      } catch (error) {
        console.error(
          `    could not retire ${loser.id}:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
    }

    try {
      await deleteItem(db, admin, loser.id);
      totals.deleted++;
    } catch {
      // Served questions are kept on purpose — a sat exam must still explain itself.
      totals.keptForRecord++;
      console.log(`    kept (already sat by a student) — retired only: ${loser.id}`);
    }
  }
  return repeats.length;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const { embedded } = await backfillEmbeddings(db);
  console.log(`Embedded ${embedded} question(s).`);

  const admin = await db.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true, role: true, email: true },
  });
  const totals: Totals = { retired: 0, deleted: 0, keptForRecord: 0 };

  let round = 0;
  let found = 0;
  do {
    round++;
    console.log(`\nRound ${round}:`);
    found = await resolveRound(admin, apply, totals);
    if (found === 0) console.log("  nothing above the repeat threshold.");
  } while (apply && found > 0 && round < MAX_ROUNDS);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to remove the repeats.");
    return;
  }

  // Grouping runs last: it depends on who is still in the bank.
  const { groups, items } = await regroupAlternates(db);
  console.log(
    `\n${items} question(s) in ${groups} concept group(s) — alternates, never served to one student together.`,
  );
  console.log(
    `Retired ${totals.retired}, deleted ${totals.deleted}, ` +
      `kept-but-retired because a student sat them ${totals.keptForRecord}.`,
  );

  const left = await findRepeatPairs(db);
  console.log(`${left.length} repeat pair(s) remaining.`);
  const servable = await db.masterItem.count({ where: { status: "APPROVED", deletedAt: null } });
  console.log(`${servable} question(s) still servable.`);
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
