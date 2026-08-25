/**
 * Volume data for the spec-04 performance evidence (the spec-02 method).
 *
 *   pnpm db:seed-volume            # insert 10 000 synthetic items
 *   pnpm db:seed-volume 25000      # a different count
 *   pnpm db:seed-volume --cleanup  # remove everything this script created
 *
 * Synthetic rows are marked with a `volume:` prefix in the English stem, so cleanup can never
 * touch real or seeded content.
 */
import { PrismaClient } from "@prisma/client";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);

const db = new PrismaClient();
const MARKER = "volume:";

async function cleanup(): Promise<void> {
  const deleted = await db.$executeRawUnsafe(
    `DELETE FROM "MasterItem" WHERE "content"->'en'->>'stem' LIKE '${MARKER}%'`,
  );
  const batches = await db.generationBatch.deleteMany({
    where: { notes: MARKER },
  });
  console.log(
    `Removed ${deleted} synthetic items and ${batches.count} synthetic sets.`,
  );
}

async function seed(count: number): Promise<void> {
  const topics = await db.topic.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  if (topics.length === 0)
    throw new Error("No topics — run `pnpm exec prisma db seed` first.");

  // A handful of sets so the set-detail query is measured at a realistic fan-out.
  const batchIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const batch = await db.generationBatch.create({
      data: {
        kind: "THEORY",
        status: "READY",
        requestedCount: 5,
        modelVersion: `synthetic-model-${i % 4}`,
        promptVersion: `generation.theory@1.${i % 3}.0`,
        notes: MARKER,
      },
      select: { id: true },
    });
    batchIds.push(batch.id);
  }

  const statuses = ["DRAFT", "IN_REVIEW", "APPROVED", "RETIRED"] as const;
  const reasons = [
    "WRONG_ANSWER",
    "AMBIGUOUS_DISTRACTOR",
    "CITATION_MISMATCH",
    "DUPLICATE",
  ] as const;
  const CHUNK = 500;
  let inserted = 0;

  for (let start = 0; start < count; start += CHUNK) {
    const rows = [];
    for (let i = start; i < Math.min(start + CHUNK, count); i++) {
      const status = statuses[i % statuses.length];
      const isAi = i % 3 !== 0;
      const reviewed = status === "APPROVED" || status === "RETIRED";
      rows.push({
        type: "TEXT" as const,
        status,
        topicId: topics[i % topics.length].id,
        difficulty: (i % 5) + 1,
        content: {
          en: {
            stem: `${MARKER} synthetic question ${i} about right of way and speed`,
            options: [
              { key: "a", text: `Option A ${i}` },
              { key: "b", text: `Option B ${i}` },
              { key: "c", text: `Option C ${i}` },
            ],
            explanation: `Synthetic explanation ${i}.`,
          },
          nb: {
            stem: `${MARKER} syntetisk spørsmål ${i} om vikeplikt og fart`,
            options: [
              { key: "a", text: `Alternativ A ${i}` },
              { key: "b", text: `Alternativ B ${i}` },
              { key: "c", text: `Alternativ C ${i}` },
            ],
            explanation: `Syntetisk forklaring ${i}.`,
          },
        },
        correctOptionKey: "a",
        legalCitations: [
          { sourceCode: "trafikkreglene", ref: `§ ${(i % 20) + 1}` },
        ],
        createdBy: isAi ? ("AI" as const) : ("HUMAN" as const),
        modelVersion: isAi ? `synthetic-model-${i % 4}` : null,
        promptVersion: isAi ? `generation.theory@1.${i % 3}.0` : null,
        batchId: batchIds[i % batchIds.length],
        reviewedAt: reviewed
          ? new Date(Date.now() - (i % 60) * 3_600_000)
          : null,
        reviewReason: status === "RETIRED" ? reasons[i % reasons.length] : null,
      });
    }
    const result = await db.masterItem.createMany({ data: rows });
    inserted += result.count;
    process.stdout.write(`\rinserted ${inserted}/${count}`);
  }

  console.log(`\nDone. Run \`pnpm db:seed-volume --cleanup\` to remove them.`);
}

const arg = process.argv[2];
(arg === "--cleanup" ? cleanup() : seed(Number(arg ?? 10_000)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
