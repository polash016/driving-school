import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import {
  createProvider,
  deleteProvider,
  listProviders,
  resolveRoutes,
  rotateProviderKey,
  upsertRoute,
} from "./providers";

/**
 * Spec-05 acceptance: a key added through the admin screen is encrypted at rest, never returned
 * by any read path, and routes resolve in priority order.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomUUID().slice(0, 8);
const actor: SessionUser = { id: "", role: "ADMIN", email: `ai-${RUN}@example.no` };
const SECRET_KEY = `sk-super-secret-${RUN}-abcd`;
const created: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "AI", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
});

afterAll(async () => {
  if (!enabled) return;
  await db.aiRoute.deleteMany({ where: { providerId: { in: created } } });
  await db.aiProvider.deleteMany({ where: { id: { in: created } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("key vault", () => {
  it("stores the key encrypted and never returns it", async () => {
    const provider = await createProvider(db, actor, {
      kind: "OPENAI_COMPATIBLE",
      label: `DeepSeek ${RUN}`,
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: SECRET_KEY,
    });
    created.push(provider.id);

    // What the admin screen receives: a hint, never the key.
    expect(JSON.stringify(provider)).not.toContain(SECRET_KEY);
    expect(provider.keyHint).toBe(`…${SECRET_KEY.slice(-4)}`);

    const listed = await listProviders(db);
    expect(JSON.stringify(listed)).not.toContain(SECRET_KEY);

    // What the database holds: ciphertext, not the key.
    const row = await db.aiProvider.findUniqueOrThrow({
      where: { id: provider.id },
      select: { encryptedApiKey: true },
    });
    expect(row.encryptedApiKey).not.toContain(SECRET_KEY);
    expect(row.encryptedApiKey.startsWith("v1.")).toBe(true);

    // And the audit trail does not carry it either.
    const audits = await db.auditLog.findMany({
      where: { actorId: actor.id },
      select: { meta: true },
    });
    expect(JSON.stringify(audits)).not.toContain(SECRET_KEY);
  });

  it("decrypts the key only when a route is resolved for a call", async () => {
    const provider = await createProvider(db, actor, {
      kind: "GOOGLE",
      label: `Gemini ${RUN}`,
      apiKey: `AIza-${RUN}-wxyz`,
    });
    created.push(provider.id);
    await upsertRoute(db, actor, {
      task: "GENERATION",
      providerId: provider.id,
      model: "gemini-2.0-flash",
      priority: 0,
    });

    const routes = await resolveRoutes(db, "GENERATION");
    const mine = routes.find((route) => route.providerId === provider.id);
    expect(mine?.apiKey).toBe(`AIza-${RUN}-wxyz`);
    expect(mine?.model).toBe("gemini-2.0-flash");
  });

  it("rotates a key without changing anything else", async () => {
    const provider = await createProvider(db, actor, {
      kind: "ANTHROPIC",
      label: `Claude ${RUN}`,
      apiKey: `sk-ant-old-${RUN}`,
    });
    created.push(provider.id);

    await rotateProviderKey(db, actor, provider.id, `sk-ant-new-${RUN}-zzzz`);
    const after = (await listProviders(db)).find((row) => row.id === provider.id);
    expect(after?.keyHint).toBe("…zzzz");
    expect(after?.label).toBe(`Claude ${RUN}`);
  });
});

d("routing", () => {
  it("returns active routes cheapest-priority first, and drops inactive providers", async () => {
    const [primary, backup] = await Promise.all([
      createProvider(db, actor, {
        kind: "GOOGLE",
        label: `Primary ${RUN}`,
        apiKey: `AIza-primary-${RUN}`,
      }),
      createProvider(db, actor, {
        kind: "OPENAI_COMPATIBLE",
        label: `Backup ${RUN}`,
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: `sk-backup-${RUN}`,
      }),
    ]);
    created.push(primary.id, backup.id);

    await upsertRoute(db, actor, {
      task: "VALIDATION",
      providerId: backup.id,
      model: "cheap-model",
      priority: 10,
    });
    await upsertRoute(db, actor, {
      task: "VALIDATION",
      providerId: primary.id,
      model: "primary-model",
      priority: 1,
    });

    const routes = await resolveRoutes(db, "VALIDATION");
    expect(routes.map((route) => route.model)).toEqual(["primary-model", "cheap-model"]);

    // Deactivating the primary provider removes its route from the chain.
    await db.aiProvider.update({
      where: { id: primary.id },
      data: { isActive: false },
      select: { id: true },
    });
    const { invalidateRoutes } = await import("./providers");
    await invalidateRoutes();

    const afterDisable = await resolveRoutes(db, "VALIDATION");
    expect(afterDisable.map((route) => route.model)).toEqual(["cheap-model"]);
  });

  it("removes a provider's routes with the provider", async () => {
    const provider = await createProvider(db, actor, {
      kind: "GOOGLE",
      label: `Temp ${RUN}`,
      apiKey: `AIza-temp-${RUN}`,
    });
    await upsertRoute(db, actor, {
      task: "IMAGE",
      providerId: provider.id,
      model: "imagen",
      priority: 0,
    });

    await deleteProvider(db, actor, provider.id);

    // Scoped to this provider: the test database is shared, so asserting the table is globally
    // empty would only be testing whoever ran last.
    expect(await db.aiRoute.count({ where: { providerId: provider.id } })).toBe(0);
    const remaining = await resolveRoutes(db, "IMAGE");
    expect(remaining.some((route) => route.providerId === provider.id)).toBe(false);
  });
});
