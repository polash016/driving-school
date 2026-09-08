/**
 * The i18n background worker (spec-19).
 *
 *   pnpm i18n:worker            # long-lived; pm2 app `teoripro-i18n-worker` in production
 *
 * Claims translation runs an admin enqueued from /admin/languages and works them to completion,
 * chaining a REPAIR run over what QA flagged. Deviates from the other scripts on purpose: it logs
 * through pino (pm2 captures NDJSON), never exits on its own, and finishes the batch in flight on
 * SIGTERM so a deploy orphans nothing.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { logger } from "../src/lib/logger";
import { env } from "../src/lib/env";
import { keys, redis } from "../src/server/redis";
import { executeRun } from "../src/server/services/i18n/runs";
import { defaultAfterRun, runWorker } from "../src/server/services/i18n/worker";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);

const db = new PrismaClient();
const log = logger.child({ component: "i18n-worker" });
const pollMs = env().I18N_WORKER_POLL_MS;
const leaseOwner = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const shutdown = new AbortController();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutdown requested — finishing the current batch");
    shutdown.abort();
  });
}
// Layer 4: a rejected promise nobody awaited is logged, not fatal. An uncaught exception leaves
// the process in an unknown state, so it is logged and handed to pm2 (layer 5) to restart.
process.on("unhandledRejection", (reason) =>
  log.error({ reason }, "unhandled rejection"),
);
process.on("uncaughtException", (error) => {
  log.error({ error }, "uncaught exception — exiting for pm2 to restart");
  shutdown.abort();
  process.exitCode = 1;
});

async function heartbeat(): Promise<void> {
  // Invalidated by: TTL only — 3 polls without a beat means the worker is gone.
  await redis.set(
    keys.i18nWorker(),
    JSON.stringify({ leaseOwner, at: new Date().toISOString() }),
    "PX",
    pollMs * 3,
  );
}

runWorker({
  db,
  leaseOwner,
  pollMs,
  signal: shutdown.signal,
  heartbeat,
  execute: (runId, options) => executeRun(db, runId, options),
  afterRun: defaultAfterRun({ db, log }),
  log,
})
  .catch((error) => {
    log.error({ error }, "worker loop ended with an error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
