import type { AuthTokenType, Prisma, PrismaClient } from "@prisma/client";
import { ValidationError } from "@/lib/errors";
import { generateToken, hashToken } from "./crypto";

/**
 * Single-use email tokens (verification + password reset), spec-03.
 * Only the sha256 hash is persisted; the plaintext exists solely in the email that was sent.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const TOKEN_TTL_SEC: Record<AuthTokenType, number> = {
  EMAIL_VERIFY: 24 * 3600,
  PASSWORD_RESET: 3600,
};

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

/**
 * Issues a token and invalidates the user's outstanding ones of the same type, so a fresh
 * "reset" link always kills the previous one.
 * Uses AuthToken(userId, type, consumedAt).
 */
export async function issueAuthToken(
  db: Db,
  userId: string,
  type: AuthTokenType,
  now: Date = new Date(),
): Promise<IssuedToken> {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_SEC[type] * 1000);

  await db.authToken.updateMany({
    where: { userId, type, consumedAt: null },
    data: { consumedAt: now },
  });
  await db.authToken.create({
    data: { tokenHash: hashToken(token), type, userId, expiresAt },
    select: { id: true },
  });

  return { token, expiresAt };
}

/**
 * Consumes a token, returning the owning user id. Single-use is enforced by the conditional
 * update: a replayed link updates zero rows. Served by the AuthToken_tokenHash unique index.
 */
export async function consumeAuthToken(
  db: Db,
  token: string,
  type: AuthTokenType,
  now: Date = new Date(),
): Promise<string> {
  const tokenHash = hashToken(token);
  const row = await db.authToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, type: true, expiresAt: true, consumedAt: true },
  });

  if (!row || row.type !== type || row.consumedAt) {
    throw new ValidationError({ reason: "token invalid" }, "auth.errors.tokenInvalid");
  }
  if (row.expiresAt <= now) {
    throw new ValidationError({ reason: "token expired" }, "auth.errors.tokenExpired");
  }

  const consumed = await db.authToken.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) {
    throw new ValidationError({ reason: "token replay" }, "auth.errors.tokenInvalid");
  }
  return row.userId;
}
