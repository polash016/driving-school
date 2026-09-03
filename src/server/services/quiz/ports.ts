import type { ItemType } from "@prisma/client";
import type { VariantCandidate } from "./assembly";

/**
 * Engine ports (hexagonal): the pure core + attempt-service depend on these
 * interfaces; adapters live in redis-adapters.ts / prisma queries. Tests use
 * the in-memory implementations below.
 */

export interface VariantSource {
  /**
   * Candidate variants grouped by DISTRIBUTION topic slug (a main topic gathers
   * its descendants' items). Only APPROVED masters / active variants.
   */
  candidatesByTopic(params: {
    topicSlugs: string[];
    type?: ItemType;
    licenseClassId?: string | null;
    /**
     * Restrict candidates to ONE task set's slice (spec-16).
     *
     * This is the entire engine change task sets need: a set IS a slice, and a sitting is the
     * ordinary assembly path run against that slice. `assembly.ts` never learns task sets exist,
     * so every guarantee it already makes — one master item per paper, conceptGroup
     * de-duplication, difficulty spread, seen-window exclusion, seeded option order — carries
     * over to a 45-of-68 draw for free.
     */
    taskSetId?: string;
  }): Promise<Record<string, VariantCandidate[]>>;
}

export interface SeenStore {
  /** contentHashes served to this user within the exclusion window. */
  getSeenHashes(userId: string): Promise<Set<string>>;
  recordServed(userId: string, hashes: string[], at: Date): Promise<void>;
}

/** Fired after grading persists — adapters invalidate the dashboard cache etc. */
export type GradedHook = (userId: string) => Promise<void>;

// ── In-memory implementations (tests) ───────────────────────────────────────

export class InMemorySeenStore implements SeenStore {
  private store = new Map<string, Set<string>>();

  async getSeenHashes(userId: string): Promise<Set<string>> {
    return new Set(this.store.get(userId) ?? []);
  }

  async recordServed(userId: string, hashes: string[]): Promise<void> {
    const set = this.store.get(userId) ?? new Set<string>();
    for (const h of hashes) set.add(h);
    this.store.set(userId, set);
  }
}

export class InMemoryVariantSource implements VariantSource {
  constructor(private byTopic: Record<string, VariantCandidate[]>) {}

  async candidatesByTopic(params: {
    topicSlugs: string[];
    type?: ItemType;
  }): Promise<Record<string, VariantCandidate[]>> {
    const out: Record<string, VariantCandidate[]> = {};
    for (const slug of params.topicSlugs) {
      const all = this.byTopic[slug] ?? [];
      out[slug] = params.type ? all.filter((c) => c.type === params.type) : all;
    }
    return out;
  }
}
