import type { PrismaClient } from "@prisma/client";

/**
 * Resolve legal citations to knowledge-base chunks without spending an embedding call.
 *
 * Exact reference first, then the whole SECTION: the base is chunked per section ("§ 7") while a
 * citation may name a subsection ("§ 7 nr. 3", "§ 13-3"). Measured on the production bank
 * (spec-22): 9 of 20 text questions resolved nothing on an exact match, and most of those cite a
 * subsection of a section that IS ingested. What stays unresolvable is a source never ingested at
 * all — and refusing those is right, because nothing could verify a claim made from them.
 *
 * Shared by the rewrite campaign (`question-bank/simplify.ts`) and the Learn drafting path
 * (spec-23), so "does this citation resolve?" has one answer.
 */
export interface CitationRef {
  sourceCode: string;
  ref: string;
}

export interface ResolvedCitation extends CitationRef {
  kbChunkId: string;
  /** The reference the chunk actually carries — the section head when the citation named a subsection. */
  chunkRef: string;
  text: string;
}

export interface CitationLookup {
  resolved: ResolvedCitation[];
  unresolved: CitationRef[];
}

/** A citation is usable when both halves are present and non-blank. */
export function usableCitations(citations: unknown): CitationRef[] {
  if (!Array.isArray(citations)) return [];
  return citations.filter(
    (c): c is CitationRef =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as CitationRef).sourceCode === "string" &&
      typeof (c as CitationRef).ref === "string" &&
      Boolean((c as CitationRef).sourceCode.trim() && (c as CitationRef).ref.trim()),
  );
}

/** "§ 7 nr. 3" → "§ 7"; "§ 13-3" → "§ 13"; anything without a § → null. */
export function sectionHead(ref: string): string | null {
  const match = ref.match(/§\s*(\d+)/);
  return match ? `§ ${match[1]}` : null;
}

export async function lookupChunksForCitations(
  db: PrismaClient,
  citations: CitationRef[],
  options: { perCitation?: number } = {},
): Promise<CitationLookup> {
  const perCitation = options.perCitation ?? 3;
  const resolved: ResolvedCitation[] = [];
  const unresolved: CitationRef[] = [];

  for (const citation of citations) {
    const candidates = [citation.ref];
    const head = sectionHead(citation.ref);
    if (head && head !== citation.ref) candidates.push(head);

    let hits: Array<{ id: string; ref: string; text: string }> = [];
    for (const ref of candidates) {
      // Index: KbChunk[sourceId] + the source's unique code; `isActive` belongs to the CHUNK.
      hits = await db.kbChunk.findMany({
        where: { isActive: true, ref, source: { code: citation.sourceCode, deletedAt: null } },
        select: { id: true, ref: true, text: true },
        orderBy: { createdAt: "asc" },
        take: perCitation,
      });
      if (hits.length > 0) break;
    }

    if (hits.length === 0) {
      unresolved.push(citation);
      continue;
    }
    for (const hit of hits) {
      resolved.push({ ...citation, kbChunkId: hit.id, chunkRef: hit.ref, text: hit.text });
    }
  }

  return { resolved, unresolved };
}
