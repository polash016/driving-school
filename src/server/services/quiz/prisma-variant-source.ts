import type { ItemType, PrismaClient } from "@prisma/client";
import { variantContentSchema } from "@/server/contracts/models";
import type { VariantCandidate } from "./assembly";
import type { VariantSource } from "./ports";

/**
 * DB-backed candidate source. A distribution (root) topic gathers items from its
 * whole subtree. Served by MasterItem_topicId_status_type_idx +
 * ItemVariant_masterItemId_isActive_idx.
 *
 * NOTE (07-integration): the Redis pool warmer replaces this read on the hot
 * path with cached candidate metadata; this class stays as the cache-miss source.
 */
export class PrismaVariantSource implements VariantSource {
  constructor(private db: PrismaClient) {}

  async candidatesByTopic(params: {
    topicSlugs: string[];
    type?: ItemType;
    licenseClassId?: string | null;
  }): Promise<Record<string, VariantCandidate[]>> {
    const topics = await this.db.topic.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true, parentId: true },
    });

    // topicId → root slug, for every subtree rooted at a requested slug
    const childrenByParent = new Map<string, typeof topics>();
    for (const t of topics) {
      if (t.parentId) {
        const list = childrenByParent.get(t.parentId) ?? [];
        list.push(t);
        childrenByParent.set(t.parentId, list);
      }
    }
    const rootSlugByTopicId = new Map<string, string>();
    for (const slug of params.topicSlugs) {
      const root = topics.find((t) => t.slug === slug);
      if (!root) continue;
      const queue = [root];
      while (queue.length > 0) {
        const node = queue.pop()!;
        rootSlugByTopicId.set(node.id, slug);
        queue.push(...(childrenByParent.get(node.id) ?? []));
      }
    }

    const items = await this.db.masterItem.findMany({
      where: {
        status: "APPROVED",
        deletedAt: null,
        topicId: { in: [...rootSlugByTopicId.keys()] },
        ...(params.type ? { type: params.type } : {}),
        ...(params.licenseClassId !== undefined
          ? {
              OR: [
                { licenseClassId: null },
                { licenseClassId: params.licenseClassId },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        type: true,
        topicId: true,
        variants: {
          where: { isActive: true },
          select: { id: true, contentHash: true, content: true },
        },
      },
    });

    const out: Record<string, VariantCandidate[]> = Object.fromEntries(
      params.topicSlugs.map((s) => [s, []]),
    );
    for (const item of items) {
      const rootSlug = rootSlugByTopicId.get(item.topicId);
      if (!rootSlug) continue;
      for (const variant of item.variants) {
        const content = variantContentSchema.parse(variant.content);
        out[rootSlug].push({
          variantId: variant.id,
          masterItemId: item.id,
          contentHash: variant.contentHash,
          type: item.type,
          topicSlug: rootSlug,
          topicId: item.topicId,
          optionKeys: content.en.options.map((o) => o.key),
        });
      }
    }
    return out;
  }
}
