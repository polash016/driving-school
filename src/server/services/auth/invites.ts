import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { absoluteUrl } from "@/lib/locale-url";
import { env } from "@/lib/env";
import { AUDIT, auditLog } from "@/server/audit";
import {
  createInviteInputSchema,
  inviteSchema,
  type Invite,
} from "@/server/contracts/auth";
import { paginationInputSchema } from "@/server/contracts/common";
import type { AppLocale } from "../../../../config/school.config";
import { schoolConfig } from "../../../../config/school.config";
import { generateToken } from "./crypto";

/**
 * Invite links — the ONLY way a student account comes into existence (spec-03: no open signup).
 *
 * `maxUses`: null = unlimited group link, 1 = single-use. An omitted input means single-use
 * (DECISIONS 2026-08-24 — resolves the old ambiguity in the schema comment).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const INVITE_SELECT = {
  id: true,
  token: true,
  role: true,
  groupId: true,
  email: true,
  maxUses: true,
  usedCount: true,
  expiresAt: true,
  revokedAt: true,
} as const;

/** Registration URL for an invite token, in the recipient's locale. */
export function inviteUrl(token: string, locale: AppLocale): string {
  return `${absoluteUrl(env().APP_BASE_URL, locale, "/register")}?invite=${token}`;
}

function toInvite(
  row: {
    id: string;
    token: string;
    role: Role;
    groupId: string | null;
    maxUses: number | null;
    usedCount: number;
    expiresAt: Date | null;
    revokedAt: Date | null;
  },
  locale: AppLocale,
): Invite {
  return inviteSchema.parse({
    id: row.id,
    token: row.token,
    url: inviteUrl(row.token, locale),
    role: row.role,
    groupId: row.groupId,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  });
}

export interface CreateInviteOptions {
  /** Binds the invite to one address (CSV import, individual invites). */
  email?: string;
  /** Locale used to build the link that gets emailed. */
  locale?: AppLocale;
  now?: Date;
}

export async function createInvite(
  db: Db,
  actorId: string,
  rawInput: unknown,
  options: CreateInviteOptions = {},
): Promise<Invite> {
  const input = createInviteInputSchema.parse(rawInput);
  const now = options.now ?? new Date();
  const locale = options.locale ?? schoolConfig.locales.default;

  if (input.groupId) {
    const group = await db.studentGroup.findFirst({
      where: { id: input.groupId, deletedAt: null },
      select: { id: true },
    });
    if (!group) throw new NotFoundError({ groupId: input.groupId });
  }

  const created = await db.inviteLink.create({
    data: {
      token: generateToken(),
      role: input.role,
      groupId: input.groupId ?? null,
      email: options.email ?? null,
      // omitted maxUses = single-use
      maxUses: input.maxUses ?? 1,
      expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000),
      createdById: actorId,
    },
    select: INVITE_SELECT,
  });

  await auditLog({
    actorId,
    action: AUDIT.inviteCreated,
    entityType: "InviteLink",
    entityId: created.id,
    meta: {
      role: created.role,
      maxUses: created.maxUses,
      bound: Boolean(options.email),
    },
  });

  return toInvite(created, locale);
}

/** Admin invite list, newest first — served by InviteLink(createdById, createdAt DESC). */
export async function listInvites(
  db: PrismaClient,
  rawPagination: unknown = {},
  locale: AppLocale = schoolConfig.locales.default,
): Promise<{
  items: Invite[];
  page: number;
  pageSize: number;
  totalCount: number;
}> {
  const { page, pageSize } = paginationInputSchema.parse(rawPagination);
  const [rows, totalCount] = await Promise.all([
    db.inviteLink.findMany({
      select: INVITE_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.inviteLink.count(),
  ]);
  return {
    items: rows.map((row) => toInvite(row, locale)),
    page,
    pageSize,
    totalCount,
  };
}

export async function revokeInvite(
  db: PrismaClient,
  actorId: string,
  inviteId: string,
): Promise<void> {
  const updated = await db.inviteLink.updateMany({
    where: { id: inviteId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (updated.count === 0) throw new NotFoundError({ inviteId });
  await auditLog({
    actorId,
    action: AUDIT.inviteRevoked,
    entityType: "InviteLink",
    entityId: inviteId,
  });
}

export interface InvitePreview {
  valid: boolean;
  /** Set when the invite is bound to one address — the form pre-fills and locks the field. */
  email: string | null;
  role: Role;
}

/**
 * What the registration page may know about an invite before anyone registers: whether it is
 * usable and which address it is bound to. Deliberately returns no ids or counts.
 * Served by the InviteLink_token unique index.
 */
export async function previewInvite(
  db: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<InvitePreview> {
  const invite = await db.inviteLink.findUnique({
    where: { token },
    select: {
      role: true,
      email: true,
      maxUses: true,
      usedCount: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!invite) return { valid: false, email: null, role: "STUDENT" };

  const usable =
    !invite.revokedAt &&
    (!invite.expiresAt || invite.expiresAt > now) &&
    (invite.maxUses === null || invite.usedCount < invite.maxUses);

  return { valid: usable, email: invite.email, role: invite.role };
}

export interface ConsumedInvite {
  id: string;
  role: Role;
  groupId: string | null;
}

/**
 * Atomically claims one use of an invite. The conditional `updateMany` is the concurrency
 * guard: two simultaneous registrations against a single-use link serialise on the row, and
 * the loser's WHERE no longer matches, so exactly one succeeds.
 *
 * MUST run inside the registration transaction.
 */
export async function consumeInvite(
  tx: Prisma.TransactionClient,
  fields: PrismaClient["inviteLink"]["fields"],
  token: string,
  email: string,
  now: Date = new Date(),
): Promise<ConsumedInvite> {
  const claimed = await tx.inviteLink.updateMany({
    where: {
      token,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ maxUses: null }, { usedCount: { lt: fields.maxUses } }] },
        { OR: [{ email: null }, { email }] },
      ],
    },
    data: { usedCount: { increment: 1 } },
  });

  const invite = await tx.inviteLink.findUnique({
    where: { token },
    select: {
      id: true,
      role: true,
      groupId: true,
      email: true,
      maxUses: true,
      usedCount: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (claimed.count === 1) {
    // `invite` is non-null here: the row we just updated cannot disappear inside the transaction.
    return { id: invite!.id, role: invite!.role, groupId: invite!.groupId };
  }

  // Nothing claimed — say precisely why, so the student sees an actionable message.
  if (!invite)
    throw new NotFoundError({ reason: "invite" }, "auth.errors.inviteInvalid");
  if (invite.revokedAt) {
    throw new ValidationError(
      { inviteId: invite.id },
      "auth.errors.inviteInvalid",
    );
  }
  if (invite.expiresAt && invite.expiresAt <= now) {
    throw new ValidationError(
      { inviteId: invite.id },
      "auth.errors.inviteExpired",
    );
  }
  if (invite.email && invite.email !== email) {
    throw new ValidationError(
      { inviteId: invite.id },
      "auth.errors.inviteEmailMismatch",
    );
  }
  throw new ConflictError({ inviteId: invite.id }, "auth.errors.inviteUsed");
}
