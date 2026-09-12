import type { PrismaClient, TranslatableEntity } from "@prisma/client";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { invalidateMessages } from "./catalogue";
import { extractAll } from "./extract";
import { queueRepairIfIdle } from "./queue-repair";
import { invalidateTaxonomy } from "./taxonomy";
import type { TranslationUnit, UnitPayload } from "./units";
import {
  allCodes,
  blockingCodes,
  checkTranslation,
  NOT_A_QUALITY_FLAG,
  type TranslationCheck,
} from "./validation";

/**
 * Re-check what is already stored against the gate as it is today (spec-21).
 *
 * The gate only ever ran on the way in. Production held 23 approved Bangla questions in Latin
 * letters because, at the time, the gate did not know Bengali; a stricter gate helps nothing
 * already stored unless something runs it again. This does — reports first, touches nothing on a
 * dry run, and on apply moves what it refuses to `NEEDS_REVIEW` with a fresh repair budget, so
 * the repair run can do the rest.
 *
 * Stale rows (source moved) are left alone: they are the sync's job, and re-checking a
 * translation against text it was never made from would flag it for the wrong reason.
 */

export interface AuditFinding {
  entity: TranslatableEntity;
  entityId: string;
  label: string;
  codes: string[];
  detail: string;
}

export interface AuditReport {
  locale: string;
  /** Rows with a current source that were run through the gate. */
  checked: number;
  /** Rows the gate refused that were not already held for exactly those findings. */
  flagged: number;
  byCode: Record<string, number>;
  examples: AuditFinding[];
  applied: boolean;
  repairRunId: string | null;
}

const EXAMPLES = 10;

/** The flags the audit cannot re-derive and therefore keeps: semantic findings, model doubts. */
function keptFlags(flags: string[]): string[] {
  return flags.filter(
    (flag) => !NOT_A_QUALITY_FLAG.has(flag) && flag !== "ADMIN_FLAGGED",
  );
}

export async function auditTranslations(
  db: PrismaClient,
  actor: SessionUser | null,
  locale: string,
  options: { apply?: boolean; repair?: boolean } = {},
): Promise<AuditReport> {
  const empty: AuditReport = {
    locale,
    checked: 0,
    flagged: 0,
    byCode: {},
    examples: [],
    applied: Boolean(options.apply),
    repairRunId: null,
  };
  const language = await db.language.findUniqueOrThrow({
    where: { code: locale },
    select: { glossaryVersion: true, isBuiltIn: true },
  });
  // en and nb are authored, not translated: there is nothing here to audit.
  if (language.isBuiltIn) return empty;

  const units = await extractAll(db, {
    glossaryVersion: language.glossaryVersion,
  });
  const byKey = new Map<string, TranslationUnit>(
    units.map((unit) => [`${unit.entity}:${unit.entityId}`, unit]),
  );
  // Index: Translation[locale, entity, status] — the leading column serves this locale scan.
  const rows = await db.translation.findMany({
    where: {
      locale,
      entity: { not: "ITEM_VARIANT" },
      status: { in: ["APPROVED", "MACHINE", "NEEDS_REVIEW"] },
    },
    select: {
      id: true,
      entity: true,
      entityId: true,
      value: true,
      status: true,
      sourceHash: true,
      qaFlags: true,
      qaReport: true,
    },
  });

  let checked = 0;
  const findings: Array<{
    row: (typeof rows)[number];
    unit: TranslationUnit;
    check: TranslationCheck;
    codes: string[];
  }> = [];
  for (const row of rows) {
    const unit = byKey.get(`${row.entity}:${row.entityId}`);
    if (!unit || unit.sourceHash !== row.sourceHash) continue;
    checked++;
    const check = checkTranslation({
      entity: row.entity,
      locale,
      source: unit.en,
      translated: row.value as unknown as UnitPayload,
      ...(unit.correctOptionKey
        ? { correctOptionKey: unit.correctOptionKey }
        : {}),
    });
    if (check.passed) continue;
    const codes = blockingCodes(check);
    // Already held for exactly these findings: nothing new to say about it.
    if (
      row.status === "NEEDS_REVIEW" &&
      codes.every((code) => row.qaFlags.includes(code))
    )
      continue;
    findings.push({ row, unit, check, codes });
  }

  const byCode: Record<string, number> = {};
  for (const finding of findings)
    for (const code of finding.codes) byCode[code] = (byCode[code] ?? 0) + 1;
  const examples: AuditFinding[] = findings.slice(0, EXAMPLES).map((f) => ({
    entity: f.unit.entity,
    entityId: f.unit.entityId,
    label: f.unit.label,
    codes: f.codes,
    detail: f.check.issues
      .filter((issue) => issue.blocking && issue.detail)
      .map((issue) => `${issue.code}: ${issue.detail}`)
      .join(" · "),
  }));

  if (options.apply && findings.length > 0) {
    for (const finding of findings) {
      const report = (finding.row.qaReport ?? {}) as Record<string, unknown>;
      await db.translation.update({
        where: { id: finding.row.id },
        data: {
          status: "NEEDS_REVIEW",
          qaFlags: [
            ...new Set([
              ...allCodes(finding.check),
              ...keptFlags(finding.row.qaFlags),
            ]),
          ],
          qaReport: {
            ...report,
            source: "audit",
            issues: finding.check.issues,
          } as object,
          // A translation the gate refuses is not approved, whoever approved it; a fresh finding
          // deserves a fresh repair budget.
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
          repairAttempts: 0,
        },
        select: { id: true },
      });
    }
    // A flagged interface string or label must stop serving at once.
    await invalidateMessages(locale);
    await invalidateTaxonomy(locale);
  }

  await auditLog({
    actorId: actor?.id ?? null,
    action: AUDIT.translationAudited,
    entityType: "Language",
    entityId: locale,
    meta: {
      checked,
      flagged: findings.length,
      byCode,
      applied: Boolean(options.apply),
    },
  });

  const repairRunId =
    options.apply && options.repair
      ? await queueRepairIfIdle(db, actor?.id ?? null, locale)
      : null;

  return {
    locale,
    checked,
    flagged: findings.length,
    byCode,
    examples,
    applied: Boolean(options.apply),
    repairRunId,
  };
}
