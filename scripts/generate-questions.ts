/**
 * Generate draft questions for a topic with AI (spec-05/06).
 *
 *   pnpm ai:generate <topic-slug> [count]
 *
 * Questions land as DRAFTs in a new set, grounded in whatever the knowledge base holds for that
 * topic. Nothing reaches a student from here: they go through the same review queue and the same
 * two-reviewer rule as anything else.
 */
import { PrismaClient } from "@prisma/client";
import { generateTheoryQuestions } from "../src/server/services/generation/theory";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");
const db = new PrismaClient();

async function main(): Promise<void> {
  const slug = process.argv[2];
  const count = Number(process.argv[3] ?? 5);
  if (!slug) throw new Error("Usage: pnpm ai:generate <topic-slug> [count]");

  const topic = await db.topic.findFirstOrThrow({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  const admin = await db.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true, role: true, email: true },
  });

  const outcome = await generateTheoryQuestions(db, admin, {
    topicId: topic.id,
    count,
  });

  console.log(
    `Set ${outcome.batchId}: asked for ${outcome.requested}, model returned ${outcome.returned}, ` +
      `${outcome.accepted} passed the quality gate, ${outcome.rejected.length} rejected.`,
  );
  for (const rejection of outcome.rejected) {
    console.log(`  rejected [${rejection.reasons.join(", ")}] ${rejection.stem}`);
  }
}

main()
  .catch((error) => {
    // AppError.message is an i18n key; the useful detail is in `meta` (logs only, by design).
    const meta = (error as { meta?: unknown }).meta;
    console.error(error instanceof Error ? error.message : error);
    if (meta) console.error(JSON.stringify(meta, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
