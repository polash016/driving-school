/**
 * Assemble real mock exams from the live bank and check what comes out.
 *
 *   pnpm qb:audit [papers]
 *
 * Answers the questions a school actually has to answer for a government-facing test: can a full
 * paper be built, does any paper repeat a question or a rule, and is it spread across difficulty
 * rather than drifting easy. Reads only — it assembles papers, it does not create attempts.
 */
import { PrismaClient } from "@prisma/client";
import { assembleQuiz, bandOf } from "../src/server/services/quiz/assembly";
import { PrismaVariantSource } from "../src/server/services/quiz/prisma-variant-source";
import { rebalanceToAvailability } from "../src/server/services/quiz/attempt-service";
import { examReadiness } from "../src/server/services/assessment/exam-readiness";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);
const db = new PrismaClient();

async function main(): Promise<void> {
  const papers = Number(process.argv[2] ?? 5);

  const licenseClass = await db.licenseClass.findFirstOrThrow({
    where: { isEnabled: true },
    select: { id: true, code: true, questionCount: true, passMark: true },
  });
  const blueprint = await db.examBlueprint.findFirstOrThrow({
    where: { licenseClassId: licenseClass.id, isDefault: true, isActive: true },
    select: { topicDistribution: true, imageRatio: true },
  });

  const readiness = await examReadiness(db, licenseClass.code);
  console.log(
    `Class ${licenseClass.code}: ${licenseClass.questionCount} questions, pass at ${licenseClass.passMark}.`,
  );
  console.log(
    `Readiness: ${readiness.ready ? "ready" : "NOT ready"} — ${readiness.available} distinct concepts available, ${readiness.required} required.`,
  );
  for (const row of readiness.shortfall) {
    console.log(`  short: ${row.topicSlug} needs ${row.need}, has ${row.have}`);
  }

  const distribution = blueprint.topicDistribution as Record<string, number>;
  const source = new PrismaVariantSource(db);
  const candidates = await source.candidatesByTopic({
    topicSlugs: Object.keys(distribution),
    licenseClassId: licenseClass.id,
  });
  const balanced = rebalanceToAvailability(distribution, candidates);

  const conceptOf = new Map<string, string>();
  for (const list of Object.values(candidates)) {
    for (const candidate of list) {
      conceptOf.set(
        candidate.masterItemId,
        candidate.conceptGroupId ?? candidate.masterItemId,
      );
    }
  }

  console.log(`\nAssembling ${papers} paper(s):`);
  let failures = 0;
  // Which phrasing of each rule each paper served — two students meeting one rule in different
  // words is the point of keeping alternates instead of deleting them.
  const phrasingsByConcept = new Map<string, Set<string>>();
  for (let index = 0; index < papers; index++) {
    const result = assembleQuiz({
      seed: `audit-${index}`,
      distribution: balanced,
      imageRatio: Number(blueprint.imageRatio ?? 0),
      candidatesByTopic: candidates,
      seenHashes: new Set<string>(),
    });

    const masters = new Set(result.questions.map((q) => q.masterItemId));
    const concepts = new Set(
      result.questions.map(
        (q) => conceptOf.get(q.masterItemId) ?? q.masterItemId,
      ),
    );
    const bands = { easy: 0, medium: 0, hard: 0 };
    for (const question of result.questions) {
      const candidate = Object.values(candidates)
        .flat()
        .find((c) => c.variantId === question.variantId);
      if (candidate) bands[bandOf(candidate.difficulty)]++;
    }

    for (const question of result.questions) {
      const concept =
        conceptOf.get(question.masterItemId) ?? question.masterItemId;
      if (concept === question.masterItemId) continue; // not part of a group
      const seen = phrasingsByConcept.get(concept) ?? new Set<string>();
      seen.add(question.masterItemId);
      phrasingsByConcept.set(concept, seen);
    }

    const repeatedMaster = result.questions.length - masters.size;
    const repeatedConcept = result.questions.length - concepts.size;
    const ok =
      result.questions.length === licenseClass.questionCount &&
      repeatedMaster === 0 &&
      repeatedConcept === 0;
    if (!ok) failures++;

    console.log(
      `  paper ${index + 1}: ${result.questions.length}/${licenseClass.questionCount} questions · ` +
        `repeated question ${repeatedMaster} · repeated rule ${repeatedConcept} · ` +
        `easy ${bands.easy} / medium ${bands.medium} / hard ${bands.hard}` +
        (ok ? "" : "   ← FAIL"),
    );
    for (const warning of result.warnings) console.log(`      ${warning}`);
  }

  const varied = [...phrasingsByConcept.values()].filter(
    (set) => set.size > 1,
  ).length;
  console.log(
    `\n${varied} of ${phrasingsByConcept.size} grouped rule(s) were asked in different words ` +
      `across these papers — two students meet the same rule, not the same sentence.`,
  );
  console.log(
    failures === 0 ? "All papers clean." : `${failures} paper(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
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
