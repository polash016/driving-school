import type { AiProviderKind, AiTask, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AiPipelineError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { AUDIT, auditLog } from "@/server/audit";
import type { SessionUser } from "@/server/authz";
import { idSchema } from "@/server/contracts/common";
import { cacheDel, cacheGet, cacheSet, keys } from "@/server/redis";
import { decryptSecret, encryptSecret } from "@/server/services/auth/crypto";
import { adapterFor } from "@/server/ai/providers";

/**
 * The provider registry (spec-05): which AI services this school has configured, and which one
 * serves each task.
 *
 * Keys are encrypted at rest with the same AES-256-GCM helpers as the TOTP secrets (spec-03) and
 * are decrypted only here, on the server, immediately before a call. Nothing that crosses a
 * boundary carries a key — the admin UI gets a four-character hint and nothing more.
 */

const ROUTE_CACHE_TTL_SEC = 300;

export const providerKindSchema = z.enum([
  "GOOGLE",
  "ANTHROPIC",
  "OPENAI_COMPATIBLE",
]);
export const aiTaskSchema = z.enum([
  "VISION",
  "GENERATION",
  "VALIDATION",
  "EMBEDDING",
  "IMAGE",
  "TRANSLATION",
]);

export const createProviderInputSchema = z
  .object({
    kind: providerKindSchema,
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(8).max(400),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === "OPENAI_COMPATIBLE" && !input.baseUrl) {
      // Without it we would not know whether this is DeepSeek, Groq or a local Ollama.
      ctx.addIssue({
        code: "custom",
        message: "baseUrl is required for OpenAI-compatible providers",
      });
    }
  });

/** What the admin screen may see: everything except the key. */
export const providerSummarySchema = z
  .object({
    id: idSchema,
    kind: providerKindSchema,
    label: z.string(),
    baseUrl: z.string().nullable(),
    keyHint: z.string(),
    isActive: z.boolean(),
    lastCheckedAt: z.date().nullable(),
    lastCheckOk: z.boolean().nullable(),
    lastCheckError: z.string().nullable(),
  })
  .strict();
export type ProviderSummary = z.infer<typeof providerSummarySchema>;

export const routeSummarySchema = z
  .object({
    id: idSchema,
    task: aiTaskSchema,
    providerId: idSchema,
    providerLabel: z.string(),
    model: z.string(),
    priority: z.int(),
    isActive: z.boolean(),
  })
  .strict();
export type RouteSummary = z.infer<typeof routeSummarySchema>;

export const upsertRouteInputSchema = z
  .object({
    id: idSchema.optional(),
    task: aiTaskSchema,
    providerId: idSchema,
    model: z.string().min(1).max(120),
    priority: z.int().min(0).max(100).default(0),
  })
  .strict();

/** Never the key itself — just enough to recognise which one is configured. */
function hintOf(apiKey: string): string {
  return `…${apiKey.trim().slice(-4)}`;
}

export async function createProvider(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<ProviderSummary> {
  const input = createProviderInputSchema.parse(rawInput);
  const provider = await db.aiProvider.create({
    data: {
      kind: input.kind,
      label: input.label,
      baseUrl: input.baseUrl ?? null,
      encryptedApiKey: encryptSecret(input.apiKey),
      keyHint: hintOf(input.apiKey),
      createdById: actor.id,
    },
    select: PROVIDER_SELECT,
  });

  await auditLog({
    actorId: actor.id,
    action: AUDIT.aiProviderCreated,
    entityType: "AiProvider",
    entityId: provider.id,
    // The key is never logged, not even in an audit row.
    meta: { kind: provider.kind, label: provider.label },
  });
  await invalidateRoutes();
  return providerSummarySchema.parse(provider);
}

const PROVIDER_SELECT = {
  id: true,
  kind: true,
  label: true,
  baseUrl: true,
  keyHint: true,
  isActive: true,
  lastCheckedAt: true,
  lastCheckOk: true,
  lastCheckError: true,
} as const;

export async function listProviders(
  db: PrismaClient,
): Promise<ProviderSummary[]> {
  const rows = await db.aiProvider.findMany({
    select: PROVIDER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => providerSummarySchema.parse(row));
}

export async function rotateProviderKey(
  db: PrismaClient,
  actor: SessionUser,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const parsed = z.string().min(8).max(400).parse(apiKey);
  await db.aiProvider.update({
    where: { id: providerId },
    data: { encryptedApiKey: encryptSecret(parsed), keyHint: hintOf(parsed) },
    select: { id: true },
  });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.aiProviderKeyRotated,
    entityType: "AiProvider",
    entityId: providerId,
  });
  await invalidateRoutes();
}

export async function deleteProvider(
  db: PrismaClient,
  actor: SessionUser,
  providerId: string,
): Promise<void> {
  await db.aiProvider.delete({ where: { id: providerId } });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.aiProviderDeleted,
    entityType: "AiProvider",
    entityId: providerId,
  });
  await invalidateRoutes();
}

export async function upsertRoute(
  db: PrismaClient,
  actor: SessionUser,
  rawInput: unknown,
): Promise<RouteSummary> {
  const input = upsertRouteInputSchema.parse(rawInput);
  const route = await db.aiRoute.upsert({
    where: {
      task_providerId_model: {
        task: input.task,
        providerId: input.providerId,
        model: input.model,
      },
    },
    create: {
      task: input.task,
      providerId: input.providerId,
      model: input.model,
      priority: input.priority,
    },
    update: { priority: input.priority, isActive: true },
    select: {
      id: true,
      task: true,
      providerId: true,
      model: true,
      priority: true,
      isActive: true,
      provider: { select: { label: true } },
    },
  });

  await auditLog({
    actorId: actor.id,
    action: AUDIT.aiRouteChanged,
    entityType: "AiRoute",
    entityId: route.id,
    meta: { task: route.task, model: route.model, priority: route.priority },
  });
  await invalidateRoutes();

  const { provider, ...fields } = route;
  return routeSummarySchema.parse({ ...fields, providerLabel: provider.label });
}

export async function deleteRoute(
  db: PrismaClient,
  actor: SessionUser,
  routeId: string,
): Promise<void> {
  await db.aiRoute.delete({ where: { id: routeId } });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.aiRouteChanged,
    entityType: "AiRoute",
    entityId: routeId,
    meta: { deleted: true },
  });
  await invalidateRoutes();
}

export async function listRoutes(db: PrismaClient): Promise<RouteSummary[]> {
  const rows = await db.aiRoute.findMany({
    select: {
      id: true,
      task: true,
      providerId: true,
      model: true,
      priority: true,
      isActive: true,
      provider: { select: { label: true } },
    },
    orderBy: [{ task: "asc" }, { priority: "asc" }],
  });
  return rows.map(({ provider, ...fields }) =>
    routeSummarySchema.parse({ ...fields, providerLabel: provider.label }),
  );
}

/** A resolved route, key included — server-internal, never serialized anywhere. */
export interface ResolvedRoute {
  routeId: string;
  providerId: string;
  providerLabel: string;
  kind: AiProviderKind;
  model: string;
  apiKey: string;
  baseUrl: string | null;
}

interface CachedRoute {
  routeId: string;
  providerId: string;
  providerLabel: string;
  kind: AiProviderKind;
  model: string;
  encryptedApiKey: string;
  baseUrl: string | null;
}

/**
 * Every active route for a task, cheapest priority first. Cached as the ENCRYPTED key: the
 * plaintext exists only inside `resolveRoutes`, for the length of one call.
 */
export async function resolveRoutes(
  db: PrismaClient,
  task: AiTask,
): Promise<ResolvedRoute[]> {
  const cacheKey = keys.aiRoutes(task);
  let cached = await cacheGet<CachedRoute[]>(cacheKey);

  if (!cached) {
    const rows = await db.aiRoute.findMany({
      where: { task, isActive: true, provider: { isActive: true } },
      select: {
        id: true,
        model: true,
        providerId: true,
        provider: {
          select: {
            kind: true,
            label: true,
            encryptedApiKey: true,
            baseUrl: true,
          },
        },
      },
      orderBy: { priority: "asc" },
    });
    cached = rows.map((row) => ({
      routeId: row.id,
      providerId: row.providerId,
      providerLabel: row.provider.label,
      kind: row.provider.kind,
      model: row.model,
      encryptedApiKey: row.provider.encryptedApiKey,
      baseUrl: row.provider.baseUrl,
    }));
    // Invalidated by: any provider or route mutation (invalidateRoutes).
    await cacheSet(cacheKey, cached, ROUTE_CACHE_TTL_SEC);
  }

  return cached.map((route) => ({
    routeId: route.routeId,
    providerId: route.providerId,
    providerLabel: route.providerLabel,
    kind: route.kind,
    model: route.model,
    baseUrl: route.baseUrl,
    apiKey: decryptSecret(route.encryptedApiKey),
  }));
}

export async function invalidateRoutes(): Promise<void> {
  await cacheDel(
    ...(
      [
        "VISION",
        "GENERATION",
        "VALIDATION",
        "EMBEDDING",
        "IMAGE",
        "TRANSLATION",
      ] as AiTask[]
    ).map((task) => keys.aiRoutes(task)),
  );
}

/**
 * "Test connection": the cheapest call that proves the key works, with the outcome recorded on
 * the provider so the admin screen can show what happened without re-running it.
 */
export async function testProvider(
  db: PrismaClient,
  actor: SessionUser,
  providerId: string,
  model: string,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const provider = await db.aiProvider.findUnique({
    where: { id: providerId },
    select: { kind: true, encryptedApiKey: true, baseUrl: true },
  });
  if (!provider) throw new NotFoundError({ providerId });

  const started = Date.now();
  let ok = true;
  let error: string | undefined;

  try {
    await adapterFor(provider.kind).ping(
      {
        apiKey: decryptSecret(provider.encryptedApiKey),
        baseUrl: provider.baseUrl,
      },
      model,
    );
  } catch (caught) {
    ok = false;
    error =
      caught instanceof Error ? caught.message.slice(0, 300) : String(caught);
    logger.warn({ providerId, error }, "provider test failed");
  }

  const ms = Date.now() - started;
  await db.aiProvider.update({
    where: { id: providerId },
    data: {
      lastCheckedAt: new Date(),
      lastCheckOk: ok,
      lastCheckError: error ?? null,
    },
    select: { id: true },
  });
  await auditLog({
    actorId: actor.id,
    action: AUDIT.aiProviderTested,
    entityType: "AiProvider",
    entityId: providerId,
    meta: { ok, ms, model },
  });

  return { ok, ms, ...(error ? { error } : {}) };
}

/** Thrown when a task has no usable route at all — a configuration problem, not a model problem. */
export function noRouteError(task: AiTask): AiPipelineError {
  return new AiPipelineError({ task, reason: "no active AI route configured" });
}
