import type {
  ItemStatus,
  PrismaClient,
  Provenance,
  RejectionReason,
} from "@prisma/client";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import {
  bulkActionInputSchema,
  rejectionReasonSchema,
  transitionItemInputSchema,
} from "@/server/contracts/question-bank";
import { publishItem, unpublishItem } from "./publish";
import { recordRejection } from "./rejections";
import { invalidateAccuracyStats } from "./stats";
import { getSecurityPolicy } from "@/server/services/auth/security-policy";
import { checkItemQualityAgainstPool } from "./validation";

/**
 * THE lifecycle chokepoint (spec-04). Every status change goes through `transitionItem` —
 * no route, action or other service may write `MasterItem.status` directly.
 *
 * Approving publishes (spec-04 D1); retiring unpublishes. Both happen in the same transaction
 * as the status write, so an item can never be APPROVED without servable variants.
 */

/**
 * Allowed edges. NEEDS_REVIEW is entered by the system only (spec-05 law changes).
 * APPROVED is a terminal content state: an approved question is frozen and can only be retired
 * (spec-04b) — corrections go through retire-and-replace, never an edit.
 */
const ALLOWED: Record<ItemStatus, readonly ItemStatus[]> = {
  DRAFT: ["IN_REVIEW", "RETIRED"],
  IN_REVIEW: ["APPROVED", "DRAFT", "RETIRED"],
  APPROVED: ["RETIRED", "NEEDS_REVIEW"],
  NEEDS_REVIEW: ["IN_REVIEW", "RETIRED"],
  RETIRED: ["DRAFT"],
} as const;

/** Transitions a human must justify — the reason is stored as a rankable taxonomy value. */
const REQUIRES_REASON: readonly ItemStatus[] = ["RETIRED"];

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * How many distinct reviewers must sign off (spec-04b). A human-authored question always needs
 * one reviewer who is not the author; AI drafts need however many the school's policy says
 * (default two).
 */
export function requiredApprovals(provenance: Provenance, aiApprovalsRequired = 2): number {
  return provenance === "AI" ? aiApprovalsRequired : 1;
}

export interface TransitionResult {
  id: string;
  from: ItemStatus;
  to: ItemStatus;
  /** False when the reviewer's approval was recorded but a second one is still required. */
  applied: boolean;
  approvals?: { recorded: number; required: number };
  variantsCreated: number;
  variantsDeactivated: number;
}

export async function transitionItem(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
  options: { facts?: Record<string, string>; systemInitiated?: boolean } = {},
): Promise<TransitionResult> {
  const input = transitionItemInputSchema.parse(rawInput);
  const reason = parseReason(input.reason);

  const item = await db.masterItem.findFirst({
    where: { id: input.id, deletedAt: null },
    select: {
      id: true,
      status: true,
      correctOptionKey: true,
      content: true,
      legalCitations: true,
      version: true,
      createdBy: true,
      createdById: true,
      topicId: true,
      batchId: true,
      modelVersion: true,
      promptVersion: true,
    },
  });
  if (!item) {
    throw new ConflictError({ itemId: input.id }, "admin.questions.errors.notFound");
  }
  if (item.status === input.to) {
    throw new ConflictError(
      { itemId: item.id, status: item.status },
      "admin.questions.errors.alreadyInStatus",
    );
  }
  if (!canTransition(item.status, input.to)) {
    throw new ConflictError(
      { itemId: item.id, from: item.status, to: input.to },
      "admin.questions.errors.illegalTransition",
    );
  }
  // NEEDS_REVIEW means "the law under this item moved" — only spec-05's fact/chunk watcher
  // may set it, never a person clicking in the review queue.
  if (input.to === "NEEDS_REVIEW" && !options.systemInitiated) {
    throw new ConflictError(
      { itemId: item.id },
      "admin.questions.errors.systemOnlyTransition",
    );
  }
  if (REQUIRES_REASON.includes(input.to) && !reason) {
    throw new ValidationError(
      { itemId: item.id, to: input.to },
      "admin.questions.errors.reasonRequired",
    );
  }
  // DRAFT and RETIRED are non-serving states (mirrors the DB CHECK constraint).
  if (!["DRAFT", "RETIRED"].includes(input.to) && !item.correctOptionKey) {
    throw new ValidationError(
      { itemId: item.id },
      "admin.questions.errors.answerKeyMissing",
    );
  }

  // The quality gate runs before a question can be put up for review or approved — nothing
  // reaches a student without passing it (spec-04b).
  if (input.to === "IN_REVIEW" || input.to === "APPROVED") {
    const quality = await checkItemQualityAgainstPool(db, item);
    if (!quality.passed) {
      throw new ValidationError(
        { itemId: item.id, errors: quality.errors },
        quality.errors[0]?.messageKey ?? "admin.quality.failed",
      );
    }
  }

  // Two-person sign-off: an AI-drafted question needs two distinct approvers, a human-authored
  // one needs a single approver who is not its author. Nobody vouches for their own work.
  if (input.to === "APPROVED") {
    if (item.createdById === actor.id && item.createdBy === "HUMAN") {
      throw new ForbiddenError(
        { itemId: item.id },
        "admin.questions.errors.selfApproval",
      );
    }

    await db.itemApproval.upsert({
      where: {
        masterItemId_approverId_itemVersion: {
          masterItemId: item.id,
          approverId: actor.id,
          itemVersion: item.version,
        },
      },
      create: {
        masterItemId: item.id,
        approverId: actor.id,
        itemVersion: item.version,
        note: input.reason ?? null,
      },
      update: {},
      select: { id: true },
    });

    const approvals = await db.itemApproval.count({
      where: { masterItemId: item.id, itemVersion: item.version },
    });
    const policy = await getSecurityPolicy(db);
    const required = requiredApprovals(item.createdBy, policy.aiApprovalsRequired);

    if (approvals < required) {
      // Recorded, and that is a success for this reviewer — the question simply stays in review
      // until a second pair of eyes arrives. Not an error: they did their part.
      await auditLog({
        actorId: actor.id,
        action: AUDIT.itemApproved,
        entityType: "MasterItem",
        entityId: item.id,
        meta: { approvals, required, version: item.version },
      });
      return {
        id: item.id,
        from: item.status,
        to: item.status,
        applied: false,
        approvals: { recorded: approvals, required },
        variantsCreated: 0,
        variantsDeactivated: 0,
      };
    }
  }

  const result = await db.$transaction(async (tx) => {
    let variantsCreated = 0;
    let variantsDeactivated = 0;

    if (input.to === "APPROVED") {
      const published = await publishItem(tx, item.id, options.facts ?? {});
      variantsCreated = published.variantsCreated + published.variantsReused;
    }
    if (input.to === "RETIRED") {
      variantsDeactivated = await unpublishItem(tx, item.id);
    }

    await tx.masterItem.update({
      where: { id: item.id },
      data: {
        status: input.to,
        reviewedById: options.systemInitiated ? null : actor.id,
        reviewedAt: new Date(),
        reviewNote: input.note?.trim() || null,
        reviewReason: reason,
      },
      select: { id: true },
    });

    return { variantsCreated, variantsDeactivated };
  });

  // A refusal is a teaching example: file it so the next generation run is shown what not to
  // write, along with the reviewer's own words when they left any (spec-05 amendment).
  if (input.to === "RETIRED" && reason) {
    const content = item.content as { en?: { stem?: string }; nb?: { stem?: string } };
    await recordRejection(db, {
      source: "REVIEWER",
      stemEn: content?.en?.stem ?? "",
      stemNb: content?.nb?.stem ?? null,
      reasonCodes: [reason],
      note: input.note ?? null,
      topicId: item.topicId,
      batchId: item.batchId,
      masterItemId: item.id,
      modelVersion: item.modelVersion,
      promptVersion: item.promptVersion,
      createdById: options.systemInitiated ? null : actor.id,
    });
  }

  await invalidateAccuracyStats();
  await auditLog({
    actorId: options.systemInitiated ? null : actor.id,
    action: AUDIT.itemTransitioned,
    entityType: "MasterItem",
    entityId: item.id,
    meta: {
      from: item.status,
      to: input.to,
      reason: reason ?? undefined,
      ...result,
    },
  });

  return { id: item.id, from: item.status, to: input.to, applied: true, ...result };
}

/**
 * The reason field carries either a taxonomy value (rankable in the accuracy dashboard) or a
 * free-text note. A value that looks like neither is a caller bug, not user input.
 */
function parseReason(reason: string | undefined): RejectionReason | null {
  if (!reason) return null;
  const parsed = rejectionReasonSchema.safeParse(reason.trim().toUpperCase());
  return parsed.success ? (parsed.data as RejectionReason) : null;
}

export interface BulkOutcome {
  itemId: string;
  /**
   * `approved` — live. `awaitingApproval` — this reviewer signed off, an AI-written question
   * still needs a second pair of eyes. `failed` — the quality gate or a lifecycle rule refused.
   */
  outcome: "approved" | "retired" | "retagged" | "awaitingApproval" | "failed";
  messageKey?: string;
}

/**
 * Bulk approve / retire / retag — the practical way to work through a generated set.
 *
 * Each item runs the **same** rules as a single action: the quality gate, the lifecycle map, and
 * two-person sign-off. Bulk is a way to save clicks, never a way around review — an AI-written
 * question bulk-approved by one reviewer is *recorded*, not published, and says so.
 *
 * A draft is walked DRAFT → IN_REVIEW → APPROVED, because "approve these" is what a reviewer
 * means when they select a pile of drafts. One bad item fails alone; the rest still go through.
 */
export async function bulkAction(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
  options: { facts?: Record<string, string> } = {},
): Promise<BulkOutcome[]> {
  const input = bulkActionInputSchema.parse(rawInput);
  const outcomes: BulkOutcome[] = [];

  for (const itemId of input.ids) {
    try {
      if (input.action === "RETAG") {
        if (!input.topicId) {
          throw new ValidationError({ itemId }, "admin.questions.errors.topicRequired");
        }
        await db.masterItem.update({
          where: { id: itemId },
          data: { topicId: input.topicId },
          select: { id: true },
        });
        outcomes.push({ itemId, outcome: "retagged" });
        continue;
      }

      if (input.action === "RETIRE") {
        await transitionItem(db, actor, { id: itemId, to: "RETIRED", reason: "OTHER" }, options);
        outcomes.push({ itemId, outcome: "retired" });
        continue;
      }

      // APPROVE: put a draft up for review first — that is what selecting drafts and pressing
      // approve means, and it is where the quality gate runs.
      const current = await db.masterItem.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { status: true },
      });
      if (!current) throw new ConflictError({ itemId }, "admin.questions.errors.notFound");
      if (current.status === "APPROVED") {
        // Someone else got there first. That is the desired end state, not a failure to report.
        outcomes.push({ itemId, outcome: "approved" });
        continue;
      }
      if (current.status === "DRAFT" || current.status === "NEEDS_REVIEW") {
        await transitionItem(db, actor, { id: itemId, to: "IN_REVIEW" }, options);
      }

      const result = await transitionItem(db, actor, { id: itemId, to: "APPROVED" }, options);
      outcomes.push({
        itemId,
        outcome: result.applied ? "approved" : "awaitingApproval",
      });
    } catch (error) {
      outcomes.push({
        itemId,
        outcome: "failed",
        messageKey:
          error instanceof ValidationError ||
          error instanceof ConflictError ||
          error instanceof ForbiddenError
            ? error.messageKey
            : "errors.internal",
      });
    }
  }

  await auditLog({
    actorId: actor.id,
    action: AUDIT.itemsBulkActioned,
    entityType: "MasterItem",
    meta: {
      action: input.action,
      requested: input.ids.length,
      approved: outcomes.filter((row) => row.outcome === "approved").length,
      awaitingApproval: outcomes.filter((row) => row.outcome === "awaitingApproval").length,
      failed: outcomes.filter((row) => row.outcome === "failed").length,
    },
  });
  return outcomes;
}
