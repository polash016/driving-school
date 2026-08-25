import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { AUDIT, auditLog } from "@/server/audit";
import { authorizeOwner, type SessionUser } from "@/server/authz";
import { sessionInfoSchema, type SessionInfo } from "@/server/contracts/auth";
import { cacheDel, cacheGet, cacheSet, keys, redis } from "@/server/redis";

/**
 * Login sessions (spec-03). Credentials logins must use the JWT strategy, so revocation is
 * enforced by pairing the JWT's `sid` with this table: the jwt callback asks `isSessionValid`,
 * which reads a Redis flag (TTL 5 min) that revocation deletes immediately.
 */

const SESSION_CACHE_TTL_SEC = 300;
/** lastSeenAt is refreshed at most this often — one DB write per request would be absurd. */
const LAST_SEEN_THROTTLE_SEC = 300;

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(
  db: PrismaClient,
  userId: string,
  ctx: SessionContext = {},
  now: Date = new Date(),
): Promise<string> {
  const session = await db.userSession.create({
    data: {
      userId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 512) ?? null,
      createdAt: now,
      lastSeenAt: now,
    },
    select: { id: true },
  });
  // Invalidated by: revokeSession / revokeAllSessions / password reset.
  await cacheSet(keys.authSession(session.id), true, SESSION_CACHE_TTL_SEC);
  return session.id;
}

/** Read-through validity check used by the Auth.js jwt callback on every request. */
export async function isSessionValid(
  db: PrismaClient,
  sessionId: string,
): Promise<boolean> {
  const cached = await cacheGet<boolean>(keys.authSession(sessionId));
  if (cached !== null) return cached;

  const session = await db.userSession.findUnique({
    where: { id: sessionId },
    select: {
      revokedAt: true,
      user: { select: { isActive: true, deletedAt: true } },
    },
  });
  const valid = Boolean(
    session &&
    !session.revokedAt &&
    session.user.isActive &&
    !session.user.deletedAt,
  );
  // Invalidated by: revokeSession / revokeAllSessions / password reset.
  await cacheSet(keys.authSession(sessionId), valid, SESSION_CACHE_TTL_SEC);
  return valid;
}

/** Throttled lastSeenAt refresh — the Redis marker keeps this to one write per 5 minutes. */
export async function touchSession(
  db: PrismaClient,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const fresh = await redis.set(
      keys.authSeen(sessionId),
      "1",
      "EX",
      LAST_SEEN_THROTTLE_SEC,
      "NX",
    );
    if (fresh !== "OK") return;
    await db.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt: now },
    });
  } catch (error) {
    logger.warn({ sessionId, error }, "session touch failed");
  }
}

/** Active sessions for the security page — served by UserSession(userId, revokedAt). */
export async function listSessions(
  db: PrismaClient,
  userId: string,
  currentSessionId: string | null,
): Promise<SessionInfo[]> {
  const rows = await db.userSession.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });
  return rows.map((row) =>
    sessionInfoSchema.parse({
      id: row.id,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      userAgent: row.userAgent,
      current: row.id === currentSessionId,
    }),
  );
}

export async function revokeSession(
  db: PrismaClient,
  session: SessionUser,
  sessionId: string,
  ctx: SessionContext = {},
): Promise<void> {
  const row = await db.userSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!row) throw new NotFoundError({ sessionId });
  // Students may only revoke their own sessions; INSTRUCTOR+ may revoke others' (support).
  authorizeOwner(session, row.userId);

  await db.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await cacheDel(keys.authSession(sessionId));
  await auditLog({
    actorId: session.id,
    action: AUDIT.sessionRevoked,
    entityType: "UserSession",
    entityId: sessionId,
    meta: { ownerId: row.userId },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Ends the caller's own session (logout): revokes the row, drops the cache flag and records
 * the event as `auth.logout` rather than an administrative revoke.
 */
export async function endSession(
  db: PrismaClient,
  userId: string,
  sessionId: string,
  ctx: SessionContext = {},
): Promise<void> {
  await db.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await cacheDel(keys.authSession(sessionId));
  await auditLog({
    actorId: userId,
    action: AUDIT.authLogout,
    entityType: "UserSession",
    entityId: sessionId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/** Revokes every session of a user (password reset, 2FA change, admin lockout). */
export async function revokeAllSessions(
  db: PrismaClient,
  userId: string,
  options: { exceptSessionId?: string; actorId?: string | null } = {},
): Promise<number> {
  const rows = await db.userSession.findMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId
        ? { id: { not: options.exceptSessionId } }
        : {}),
    },
    select: { id: true },
  });
  if (rows.length === 0) return 0;

  await db.userSession.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { revokedAt: new Date() },
  });
  await cacheDel(...rows.map((row) => keys.authSession(row.id)));
  await auditLog({
    actorId: options.actorId ?? null,
    action: AUDIT.sessionRevoked,
    entityType: "User",
    entityId: userId,
    meta: { revoked: rows.length, reason: "revoke-all" },
  });
  return rows.length;
}
