import type { PrismaClient, TranslationStatus } from "@prisma/client";
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

export interface LanguageCoverage {
  locale: string;
  total: number;
  /** Units with a servable translation under this language's own policy. */
  ready: number;
  flagged: number;
  percent: number;
  byEntity: CoverageRow[];
  /** True when every unit is ready — the gate on showing the language to students. */
  complete: boolean;
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
    // Built-in languages are authored, not translated: they are complete by definition.
    return {
      locale,
      total: 0,
      ready: 0,
      flagged: 0,
      percent: 100,
      byEntity: [],
      complete: true,
    };
  }

  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  const rows = await db.translation.findMany({
    where: { locale },
    select: { entity: true, entityId: true, sourceHash: true, status: true },
  });

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
  return {
    locale,
    total,
    ready,
    flagged,
    percent: total === 0 ? 0 : Math.floor((ready / total) * 100),
    byEntity: [...totals.values()].sort((a, b) =>
      a.entity.localeCompare(b.entity),
    ),
    complete: total > 0 && ready === total,
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
