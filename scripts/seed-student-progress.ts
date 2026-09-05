import { attemptService } from "@/server/services/assessment";
import { db } from "@/server/db";

/**
 * Give a student a believable history — `pnpm dev:seed-progress <email>`.
 *
 * It **sits real attempts through the real engine**: start → answer every question → submit. Nothing
 * is hand-inserted, so what comes out is production-shaped by construction — graded rows, topic
 * breakdowns, per-set progress, attestation digests, and the pass-guarantee flag — and the numbers
 * on the dashboard are computed the same way they will be for a real student.
 *
 * Hand-writing `TaskSetProgress` rows would have been ten lines, and would have produced a screen
 * that looks right and proves nothing.
 *
 * Accuracy is steered PER TOPIC so the category bars land in different colour bands and the design
 * can be shown with something other than a row of identical greens.
 *
 *   pnpm dev:seed-progress elev@example.no
 *   pnpm dev:seed-progress elev@example.no --sets 5 --reset
 */

/** Target accuracy per ROOT topic slug. Anything unlisted gets DEFAULT_ACCURACY. */
const ACCURACY: Record<string, number> = {
  "traffic-participants": 0.86,
  "right-of-way": 0.64,
  "the-vehicle": 0.45,
  "speed-positioning": 0.72,
  "signs-markings": 0.91,
  responsibility: 0.38,
  "laws-rules": 0.55,
};
const DEFAULT_ACCURACY = 0.6;

/** Deterministic per (attempt, position) — a reseed reproduces the same dashboard. */
function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

async function rootSlugByTopicId(): Promise<Map<string, string>> {
  const topics = await db.topic.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, parentId: true },
  });
  const byId = new Map(topics.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const topic of topics) {
    let node = topic;
    while (node.parentId && byId.has(node.parentId))
      node = byId.get(node.parentId)!;
    out.set(topic.id, node.slug);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"));
  if (!email)
    throw new Error(
      "usage: pnpm dev:seed-progress <email> [--sets N] [--reset]",
    );

  const setsFlag = args.indexOf("--sets");
  const howMany = setsFlag >= 0 ? Number(args[setsFlag + 1]) : 4;
  const reset = args.includes("--reset");

  const user = await db.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });

  if (reset) {
    const attempts = await db.examAttempt.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    // Submitted attempts are trigger-protected — that is the point of them (spec-04b). Suspend the
    // triggers for THIS transaction only, so a concurrent process is never left without them.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = 'replica'",
      );
      await tx.examAttemptQuestion.deleteMany({
        where: { attemptId: { in: attempts.map((a) => a.id) } },
      });
      await tx.taskSetProgress.deleteMany({ where: { userId: user.id } });
      await tx.examAttempt.deleteMany({ where: { userId: user.id } });
    });
    console.log(`reset: removed ${attempts.length} attempts`);
  }

  const rootSlug = await rootSlugByTopicId();
  const sets = await db.taskSet.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { number: "asc" },
    take: howMany,
    select: { id: true, number: true },
  });
  if (sets.length === 0)
    throw new Error(
      "no published task sets — run `pnpm tasksets:build --publish` first",
    );

  for (const set of sets) {
    const attempt = await attemptService.startQuiz(user.id, {
      mode: "TASK_SET",
      taskSetId: set.id,
      locale: "en",
    });

    // The correct key never reaches a client, so the seeder reads it from the database directly —
    // exactly the boundary the engine is designed to keep closed.
    const rows = await db.examAttemptQuestion.findMany({
      where: { attemptId: attempt.id },
      select: {
        position: true,
        topicId: true,
        optionOrder: true,
        variant: { select: { correctOptionKey: true } },
      },
    });

    for (const row of rows) {
      const slug = rootSlug.get(row.topicId) ?? "";
      const target = ACCURACY[slug] ?? DEFAULT_ACCURACY;
      const answerCorrectly =
        hashUnit(`${attempt.id}:${row.position}`) < target;
      const options = row.optionOrder as string[];
      const wrong = options.find((k) => k !== row.variant.correctOptionKey);
      const key = answerCorrectly
        ? row.variant.correctOptionKey
        : (wrong ?? options[0]);

      await attemptService.answer(user.id, {
        attemptId: attempt.id,
        position: row.position,
        optionKey: key,
        locale: "en",
      });
    }

    const result = await attemptService.submit(user.id, {
      attemptId: attempt.id,
      locale: "en",
    });
    console.log(
      `  task set #${set.number}: ${result.correctCount}/${rows.length}` +
        ` — ${result.passed ? "PASSED" : "not passed"} (pass mark ${result.passMark})`,
    );
  }

  // One sign test as well, so "My previous tests" is not a single-kind list.
  try {
    const sign = await attemptService.startQuiz(user.id, {
      mode: "SIGN",
      itemType: "SIGN",
      questionCount: 10,
      locale: "en",
    });
    for (const question of sign.questions) {
      await attemptService.answer(user.id, {
        attemptId: sign.id,
        position: question.position,
        optionKey: question.options[0].key,
        locale: "en",
      });
    }
    await attemptService.submit(user.id, { attemptId: sign.id, locale: "en" });
    console.log("  sign test: submitted");
  } catch {
    console.log("  sign test: skipped (no sign questions in this database)");
  }

  console.log(`\nseeded ${sets.length} task set attempts for ${user.email}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
