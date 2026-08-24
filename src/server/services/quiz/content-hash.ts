import { createHash } from "node:crypto";
import type { z } from "zod";
import type { variantContentSchema } from "@/server/contracts/models";

type VariantContent = z.infer<typeof variantContentSchema>;

/**
 * Canonical contentHash for an ItemVariant (spec-07):
 * - unique constraint dedupes the pool,
 * - per-user seen-window keys off it.
 * Canonicalization: fixed field order, options sorted by key — the hash ignores
 * presentation order (which is per-attempt anyway) but captures every string.
 */
export function computeContentHash(
  masterItemId: string,
  content: VariantContent,
): string {
  const canonical = JSON.stringify({
    m: masterItemId,
    en: canonicalLocale(content.en),
    nb: canonicalLocale(content.nb),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalLocale(side: VariantContent["en"]) {
  return {
    s: side.stem,
    o: [...side.options]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((o) => [o.key, o.text]),
  };
}
