import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

/**
 * Can a mock exam actually be assembled? (spec-07 integration)
 *
 * "Enough questions" is not a total — a mock exam mirrors the official blueprint, which asks for
 * a specific number per topic. A bank of 200 questions all about road signs still cannot fill one.
 * Answering with the shortfall per topic tells the school exactly what to write next, and lets the
 * student's tile say something true instead of failing on tap.
 *
 * Counting matches what assembly can actually serve: questions sharing a `conceptGroupId` are
 * re-phrasings of one rule and only one of them may appear in a paper, so a group counts once.
 * Counting them individually would report a bank as ready and then assemble short.
 */

const distributionSchema = z.record(z.string(), z.int().positive());

export interface ExamReadiness {
  ready: boolean;
  required: number;
  available: number;
  /** Topics still short, worst first — the school's to-do list. */
  shortfall: Array<{ topicSlug: string; need: number; have: number }>;
}

export async function examReadiness(
  db: PrismaClient,
  licenseClassCode: string,
): Promise<ExamReadiness> {
  const licenseClass = await db.licenseClass.findFirst({
    where: { code: licenseClassCode, isEnabled: true },
    select: { id: true, questionCount: true },
  });
  if (!licenseClass) {
    return { ready: false, required: 0, available: 0, shortfall: [] };
  }

  const blueprint = await db.examBlueprint.findFirst({
    where: { licenseClassId: licenseClass.id, isDefault: true, isActive: true },
    select: { topicDistribution: true },
  });
  if (!blueprint) {
    return { ready: false, required: licenseClass.questionCount, available: 0, shortfall: [] };
  }

  const distribution = distributionSchema.parse(blueprint.topicDistribution);

  // Count per ROOT topic: the blueprint is written in root slugs, and an item on a subtopic
  // counts toward its root (the engine gathers subtrees the same way).
  const topics = await db.topic.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, parentId: true },
  });
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const rootSlugOf = (topicId: string): string => {
    let node = byId.get(topicId);
    while (node?.parentId && byId.has(node.parentId)) node = byId.get(node.parentId);
    return node?.slug ?? "unknown";
  };

  const approved = await db.masterItem.findMany({
    where: {
      status: "APPROVED",
      deletedAt: null,
      variants: { some: { isActive: true } },
      OR: [{ licenseClassId: null }, { licenseClassId: licenseClass.id }],
    },
    select: { topicId: true, id: true, conceptGroupId: true },
  });

  // One count per distinct concept — alternates of the same rule collapse to one. A group can
  // span topics (the same rule tagged under two of them); since assembly's exclusion is
  // whole-paper, such a concept is counted once, under the topic holding most of it. Counting it
  // in both would report a bank as ready and then assemble short.
  const slugsByConcept = new Map<string, Map<string, number>>();
  for (const item of approved) {
    const concept = item.conceptGroupId ?? item.id;
    const slug = rootSlugOf(item.topicId);
    const slugs = slugsByConcept.get(concept) ?? new Map<string, number>();
    slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
    slugsByConcept.set(concept, slugs);
  }
  const have = new Map<string, number>();
  for (const slugs of slugsByConcept.values()) {
    const [home] = [...slugs.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    have.set(home, (have.get(home) ?? 0) + 1);
  }

  const shortfall = Object.entries(distribution)
    .map(([topicSlug, need]) => ({ topicSlug, need, have: have.get(topicSlug) ?? 0 }))
    .filter((row) => row.have < row.need)
    .sort((a, b) => b.need - b.have - (a.need - a.have));

  return {
    ready: shortfall.length === 0,
    required: Object.values(distribution).reduce((sum, count) => sum + count, 0),
    available: [...have.values()].reduce((sum, count) => sum + count, 0),
    shortfall,
  };
}
