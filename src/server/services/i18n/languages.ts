import type {
  PrismaClient,
  TranslatableEntity,
  TranslationStatus,
} from "@prisma/client";
import { z } from "zod";
import { ConflictError, ValidationError } from "@/lib/errors";
import { BUILTIN_PREFIXES, isBuiltinLocale, localeSchema } from "@/lib/locale";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { invalidateMessages } from "./catalogue";
import { extractAll } from "./extract";
import { invalidateRegistry } from "./registry";

/**
 * Managing the languages a school offers (spec-15).
 *
 * Two rules are enforced here rather than left to the admin to remember, because getting either
 * wrong produces a broken site rather than an error message:
 *
 * 1. **A runtime language is served at `/<code>`.** next-intl compiles the prefix map into the
 *    client bundle, so a custom prefix would exist only on the server: `<Link>` would emit
 *    `/pt-BR/…` while the proxy expected `/br/…`, and the result is a redirect loop. `nb → /no` is
 *    the grandfathered exception and is compiled in.
 * 2. **A language reaches students only at full coverage.** Half a test in your own language and
 *    half in English is worse than a test honestly in English.
 */

export const createLanguageInputSchema = z
  .object({
    code: localeSchema,
    englishName: z.string().min(1).max(80),
    nativeName: z.string().min(1).max(80),
    shortLabel: z.string().min(1).max(6),
    direction: z.enum(["LTR", "RTL"]).default("LTR"),
    requiresApproval: z.boolean().default(true),
    styleNote: z.string().max(500).optional(),
  })
  .strict();

export const updateLanguageInputSchema = z
  .object({
    code: localeSchema,
    requiresApproval: z.boolean().optional(),
    studentVisible: z.boolean().optional(),
    qaSampleRate: z.number().min(0).max(1).optional(),
    styleNote: z.string().max(500).nullable().optional(),
    sortOrder: z.int().min(0).max(999).optional(),
  })
  .strict();

export interface CoverageRow {
  entity: string;
  total: number;
  translated: number;
  approved: number;
  flagged: number;
}

export type BlockerKind =
  "UNTRANSLATED" | "FAILED" | "FLAGGED" | "AWAITING_APPROVAL";

/** One reason this language is not servable yet, and how many units carry it. */
export interface Blocker {
  kind: BlockerKind;
  count: number;
}

/** Cheapest to clear first — an admin reads this list top to bottom. */
const BLOCKER_ORDER: BlockerKind[] = [
  "UNTRANSLATED",
  "FAILED",
  "FLAGGED",
  "AWAITING_APPROVAL",
];

export interface LanguageCoverage {
  locale: string;
  total: number;
  /** Units with a servable translation under this language's own policy. */
  ready: number;
  flagged: number;
  percent: number;
  byEntity: CoverageRow[];
  /**
   * Exactly what stands between this language and students. A partition of `total − ready`, so
   * the sum of the counts is always the shortfall the percentage describes.
   */
  blockers: Blocker[];
  /** True when nothing blocks — the gate on showing the language to students. */
  complete: boolean;
}

/**
 * Exactly what stands between this language and students, as a partition of (total − ready):
 * every unit that is not ready lands in one bucket and one only. `complete` is derived from this,
 * so the checklist and the publish gate cannot drift — a language that shows an empty checklist
 * is a language the gate will let through, by construction rather than by agreement.
 *
 * FAILED is a *subset of* "no fresh row", never a status of its own: a unit the machine gave up on
 * in one run and translated in the next has a fresh row and is not counted twice.
 */
export function partitionBlockers(
  units: Array<{
    entity: TranslatableEntity;
    entityId: string;
    sourceHash: string;
  }>,
  rows: Map<string, { sourceHash: string; status: TranslationStatus }>,
  failedKeys: Set<string>,
  requiresApproval: boolean,
): Blocker[] {
  const counts: Record<BlockerKind, number> = {
    UNTRANSLATED: 0,
    FAILED: 0,
    FLAGGED: 0,
    AWAITING_APPROVAL: 0,
  };

  for (const unit of units) {
    const key = `${unit.entity}:${unit.entityId}`;
    const row = rows.get(key);
    // A translation made from text that has since moved is not coverage — stale reads as absent.
    const fresh = row !== undefined && row.sourceHash === unit.sourceHash;
    if (!fresh) {
      counts[failedKeys.has(key) ? "FAILED" : "UNTRANSLATED"] += 1;
      continue;
    }
    if (row.status === "NEEDS_REVIEW" || row.status === "REJECTED") {
      counts.FLAGGED += 1;
      continue;
    }
    // MACHINE is servable when the language does not require approval, so it blocks nothing then.
    if (row.status === "MACHINE" && requiresApproval)
      counts.AWAITING_APPROVAL += 1;
  }

  return BLOCKER_ORDER.filter((kind) => counts[kind] > 0).map((kind) => ({
    kind,
    count: counts[kind],
  }));
}

/**
 * Units the machine gave up on: SKIPPED jobs of the newest completed, non-sample run, mapped to
 * the last error they carried.
 *
 * A cancel marks every remaining job SKIPPED and a re-plan supersedes them — neither is a failure,
 * and calling them one would put "gave up after 3 tries" beside a unit nobody ever tried. Samples
 * are excluded because a sample deliberately covers ~5 units and skips the rest.
 */
async function failedUnits(
  db: PrismaClient,
  locale: string,
): Promise<Map<string, string | null>> {
  // Index: TranslationRun[locale, status, createdAt(sort: Desc)].
  const lastRun = await db.translationRun.findFirst({
    where: { locale, status: "COMPLETED", kind: { not: "SAMPLE" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!lastRun) return new Map();

  // Index: TranslationJob[runId, state, entity].
  const jobs = await db.translationJob.findMany({
    where: {
      runId: lastRun.id,
      state: "SKIPPED",
      error: { notIn: ["cancelled", "superseded"] },
    },
    select: { entity: true, entityId: true, error: true },
  });
  return new Map(
    jobs.map((job) => [`${job.entity}:${job.entityId}`, job.error]),
  );
}

export interface UntranslatedUnit {
  entity: TranslatableEntity;
  entityId: string;
  label: string;
  failed: boolean;
  error: string | null;
}

/**
 * The units behind the UNTRANSLATED and FAILED blockers.
 *
 * These have no `Translation` row at all, so the review queue — built on `translation.findMany` —
 * cannot show them. Without this list those two lines of the checklist would link nowhere.
 *
 * `only` filters BEFORE the limit is applied: asking for the failures must return failures, not
 * whatever survives a slice of a much longer untranslated list.
 */
export async function untranslatedUnits(
  db: PrismaClient,
  locale: string,
  options: { limit?: number; only?: "FAILED" | "UNTRANSLATED" } = {},
): Promise<UntranslatedUnit[]> {
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: { glossaryVersion: true },
  });
  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  // Index: Translation[locale, entity, status] — the leading column serves this locale scan.
  const rows = await db.translation.findMany({
    where: { locale },
    select: { entity: true, entityId: true, sourceHash: true },
  });
  const fresh = new Set(
    rows.map((row) => `${row.entity}:${row.entityId}:${row.sourceHash}`),
  );
  const failed = await failedUnits(db, locale);

  return units
    .filter(
      (unit) =>
        !fresh.has(`${unit.entity}:${unit.entityId}:${unit.sourceHash}`),
    )
    .map((unit) => {
      const key = `${unit.entity}:${unit.entityId}`;
      return {
        entity: unit.entity,
        entityId: unit.entityId,
        label: unit.label,
        failed: failed.has(key),
        error: failed.get(key) ?? null,
      };
    })
    .filter((unit) =>
      options.only === undefined
        ? true
        : options.only === "FAILED"
          ? unit.failed
          : !unit.failed,
    )
    .slice(0, options.limit ?? 50);
}

/**
 * How far along a language is.
 *
 * "Ready" means *servable under this language's own policy*: with approval required, only approved
 * translations count; without it, clean machine output counts too. So the percentage always answers
 * the question that matters — how much of the site would a student in this language actually read
 * in it.
 */
export async function languageCoverage(
  db: PrismaClient,
  locale: string,
): Promise<LanguageCoverage> {
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: { requiresApproval: true, glossaryVersion: true, isBuiltIn: true },
  });

  if (language.isBuiltIn) {
    // Built-in languages are authored, not translated: they are complete by definition, and
    // nothing can block them.
    return {
      locale,
      total: 0,
      ready: 0,
      flagged: 0,
      percent: 100,
      byEntity: [],
      blockers: [],
      complete: true,
    };
  }

  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  // Index: Translation[locale, entity, status] — the leading column serves this locale scan.
  const rows = await db.translation.findMany({
    where: { locale },
    select: { entity: true, entityId: true, sourceHash: true, status: true },
  });
  const failedKeys = new Set((await failedUnits(db, locale)).keys());

  const servable: TranslationStatus[] = language.requiresApproval
    ? ["APPROVED"]
    : ["APPROVED", "MACHINE"];
  const byKey = new Map(
    rows.map((row) => [`${row.entity}:${row.entityId}`, row]),
  );

  const totals = new Map<string, CoverageRow>();
  let ready = 0;
  let flagged = 0;

  for (const unit of units) {
    const entry = totals.get(unit.entity) ?? {
      entity: unit.entity,
      total: 0,
      translated: 0,
      approved: 0,
      flagged: 0,
    };
    entry.total++;

    const current = byKey.get(`${unit.entity}:${unit.entityId}`);
    // A translation made from text that has since moved does not count as coverage.
    const fresh = current && current.sourceHash === unit.sourceHash;
    if (fresh) {
      entry.translated++;
      if (current.status === "APPROVED") entry.approved++;
      if (current.status === "NEEDS_REVIEW" || current.status === "REJECTED") {
        entry.flagged++;
        flagged++;
      }
      if (servable.includes(current.status)) ready++;
    }
    totals.set(unit.entity, entry);
  }

  const total = units.length;
  const blockers = partitionBlockers(
    units,
    byKey,
    failedKeys,
    language.requiresApproval,
  );
  return {
    locale,
    total,
    ready,
    flagged,
    percent: total === 0 ? 0 : Math.floor((ready / total) * 100),
    byEntity: [...totals.values()].sort((a, b) =>
      a.entity.localeCompare(b.entity),
    ),
    blockers,
    // Derived from the blockers, never computed alongside them: the checklist an admin reads and
    // the gate that refuses `studentVisible` are then the same statement.
    complete: total > 0 && blockers.length === 0,
  };
}

export async function listLanguages(db: PrismaClient) {
  return db.language.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      code: true,
      englishName: true,
      nativeName: true,
      shortLabel: true,
      urlPrefix: true,
      direction: true,
      isBuiltIn: true,
      requiresApproval: true,
      studentVisible: true,
      qaSampleRate: true,
      styleNote: true,
      sortOrder: true,
      lastSyncedAt: true,
    },
  });
}

export async function createLanguage(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
) {
  const input = createLanguageInputSchema.parse(rawInput);

  if (isBuiltinLocale(input.code)) {
    throw new ConflictError(
      { code: input.code },
      "admin.languages.errors.builtInExists",
    );
  }
  const existing = await db.language.findUnique({
    where: { code: input.code },
    select: { code: true },
  });
  if (existing) {
    throw new ConflictError(
      { code: input.code },
      "admin.languages.errors.alreadyExists",
    );
  }

  const language = await db.language.create({
    data: {
      code: input.code,
      englishName: input.englishName,
      nativeName: input.nativeName,
      shortLabel: input.shortLabel.toUpperCase(),
      // Rule 1 above: never anything but `/<code>` for a runtime language.
      urlPrefix: `/${input.code}`,
      direction: input.direction,
      requiresApproval: input.requiresApproval,
      styleNote: input.styleNote ?? null,
      studentVisible: false,
      sortOrder: (await db.language.count()) + 1,
    },
    select: { code: true, englishName: true },
  });

  await invalidateRegistry();
  await auditLog({
    actorId: actor.id,
    action: AUDIT.languageAdded,
    entityType: "Language",
    entityId: language.code,
    meta: { englishName: language.englishName, direction: input.direction },
  });
  return language;
}

export async function updateLanguage(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
) {
  const input = updateLanguageInputSchema.parse(rawInput);
  const current = await db.language.findUniqueOrThrow({
    where: { code: input.code },
    select: {
      code: true,
      isBuiltIn: true,
      studentVisible: true,
      requiresApproval: true,
    },
  });

  // Rule 2: the gate on student visibility is coverage, not intent.
  if (
    input.studentVisible === true &&
    !current.studentVisible &&
    !current.isBuiltIn
  ) {
    const coverage = await languageCoverage(db, input.code);
    if (!coverage.complete) {
      throw new ValidationError(
        { code: input.code, percent: coverage.percent },
        "admin.languages.errors.notComplete",
      );
    }
  }

  const updated = await db.language.update({
    where: { code: input.code },
    data: {
      ...(input.requiresApproval !== undefined
        ? { requiresApproval: input.requiresApproval }
        : {}),
      ...(input.studentVisible !== undefined
        ? { studentVisible: input.studentVisible }
        : {}),
      ...(input.qaSampleRate !== undefined
        ? { qaSampleRate: input.qaSampleRate }
        : {}),
      ...(input.styleNote !== undefined ? { styleNote: input.styleNote } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
    select: { code: true, studentVisible: true, requiresApproval: true },
  });

  await invalidateRegistry();
  // Changing the approval policy changes which strings are servable, so the catalogue is stale.
  if (input.requiresApproval !== undefined)
    await invalidateMessages(input.code);

  await auditLog({
    actorId: actor.id,
    action: AUDIT.languageUpdated,
    entityType: "Language",
    entityId: input.code,
    meta: { from: current, to: updated },
  });
  return updated;
}

/** The prefixes a new language may use — surfaced so the admin form can explain the constraint. */
export function reservedPrefixes(): string[] {
  return Object.values(BUILTIN_PREFIXES);
}
