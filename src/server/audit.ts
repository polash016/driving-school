import type { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";

/**
 * Audit trail writer (spec-03; the admin audit viewer is spec-11).
 * Never throws — a failed audit write must not fail the user's action, but it is logged at
 * error level so the gap is visible. Actions are an open set; the constants below keep the
 * spelling consistent across call sites.
 */

export const AUDIT = {
  authLogin: "auth.login",
  authLoginFailed: "auth.login_failed",
  authLogout: "auth.logout",
  authRegister: "auth.register",
  emailVerified: "auth.email_verified",
  passwordResetRequested: "auth.password_reset_requested",
  passwordReset: "auth.password_reset",
  passwordChanged: "auth.password_changed",
  sessionRevoked: "auth.session_revoked",
  twoFactorEnabled: "auth.2fa_enabled",
  twoFactorReset: "auth.2fa_reset",
  inviteCreated: "invite.created",
  inviteRevoked: "invite.revoked",
  inviteUsed: "invite.used",
  studentsImported: "students.imported",
  itemTransitioned: "item.transitioned",
  itemApproved: "item.approved",
  itemReplaced: "item.replaced",
  attemptAttested: "attempt.attested",
  aiProviderCreated: "ai.provider_created",
  aiProviderKeyRotated: "ai.provider_key_rotated",
  aiProviderDeleted: "ai.provider_deleted",
  aiProviderTested: "ai.provider_tested",
  aiRouteChanged: "ai.route_changed",
  kbIngested: "kb.ingested",
  factUpdated: "kb.fact_updated",
  questionsGenerated: "generation.questions",
  securityPolicyChanged: "security.policy_changed",
  itemUpserted: "item.upserted",
  itemsBulkActioned: "item.bulk_action",
  itemsImported: "item.imported",
  batchCreated: "batch.created",
  batchItemsAttached: "batch.items_attached",
  batchItemDetached: "batch.item_detached",
  adminCreated: "admin.created",
  languageAdded: "i18n.language_added",
  languageUpdated: "i18n.language_updated",
  translationRunStarted: "i18n.run_started",
  translationRunFinished: "i18n.run_finished",
  translationRunEnqueued: "i18n.run_enqueued",
  translationRunPaused: "i18n.run_paused",
  translationRunResumed: "i18n.run_resumed",
  translationRunCancelled: "i18n.run_cancelled",
  translationRunFailed: "i18n.run_failed",
  translationApproved: "i18n.translation_approved",
  translationRejected: "i18n.translation_rejected",
  translationEdited: "i18n.translation_edited",
  translationFlagged: "i18n.translation_flagged",
  learnBookUpserted: "learn.book_upserted",
  learnBookTransitioned: "learn.book_transitioned",
  learnChaptersReordered: "learn.chapters_reordered",
  learnDocumentUpserted: "learn.document_upserted",
  learnDocumentTransitioned: "learn.document_transitioned",
  learnDocumentDrafted: "learn.document_ai_drafted",
  learnDeleted: "learn.deleted",
  translationAudited: "i18n.translation_audited",
  imagesUploaded: "image.uploaded",
  imageDeleted: "image.deleted",
  signUpdated: "sign.updated",
  taskSetsBuilt: "taskset.built",
  taskSetsPublished: "taskset.published",
  /**
   * spec-22. Distinct from `itemUpserted` ("a draft was edited") and `itemReplaced`
   * ("retired and superseded"): this is an approved question whose text was shortened in place.
   * Its `meta` carries `previousContent`, which is the rollback record.
   */
  itemSimplified: "item.simplified",
  itemRewriteRolledBack: "item.rewrite_rolled_back",
  signSimplified: "sign.simplified",
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

export interface AuditEntry {
  /** null = system action (CLI scripts, scheduled jobs). */
  actorId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  meta?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        meta: entry.meta,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    logger.error({ entry, error }, "audit log write failed");
  }
}
