import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import type { SessionUser } from "@/server/authz";
import { db } from "@/server/db";
import { redis } from "@/server/redis";
import { createLanguage } from "./languages";
import {
  latestRunFor,
  reapAbandonedCancels,
  requestCancel,
  requestPause,
  resumeRun,
  runDetail,
  startBackgroundRun,
} from "./run-control";
import { executeRun, planRun } from "./runs";

/**
 * What an admin can do to a background run (spec-19).
 *
 * These are rules about rows — "only one live run per language", "a pause outlives the runner that
 * honoured it" — so they are checked against a real Postgres. No model is ever reached: the one
 * `executeRun` call here is bounded to zero units, which claims the run and stops at the budget
 * check before any batch is fetched. That makes it an honest probe of claimability, which is the
 * one thing a resume has to restore and a flag read cannot prove on its own.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);
const RUN = randomBytes(3).toString("hex");
const CODE = `zc-${RUN}`.slice(0, 8);
const actor: SessionUser = {
  id: "",
  role: "ADMIN",
  email: `ctl-${RUN}@example.no`,
};
const topicIds: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  const user = await db.user.create({
    data: {
      email: actor.email,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: "Ctl", lastName: RUN } },
    },
    select: { id: true },
  });
  actor.id = user.id;
  await createLanguage(db, actor, {
    code: CODE,
    englishName: "Controlic",
    nativeName: "Controlic",
    shortLabel: "ZC",
    direction: "LTR",
    requiresApproval: false,
  });
  for (let i = 0; i < 5; i++) {
    const topic = await db.topic.create({
      data: {
        slug: `zc-${RUN}-${i}`,
        name: { en: `Topic ${i}`, nb: `Emne ${i}` },
        sortOrder: 900 + i,
      },
      select: { id: true },
    });
    topicIds.push(topic.id);
  }
});

afterAll(async () => {
  if (!enabled) return;
  await db.translation.deleteMany({ where: { locale: CODE } });
  await db.translationMemory.deleteMany({ where: { locale: CODE } });
  await db.translationJob.deleteMany({ where: { run: { locale: CODE } } });
  await db.translationRun.deleteMany({ where: { locale: CODE } });
  await db.language.deleteMany({ where: { code: CODE } });
  await db.topic.deleteMany({ where: { id: { in: topicIds } } });
  await db.auditLog.deleteMany({ where: { actorId: actor.id } });
  await db.user.deleteMany({ where: { id: actor.id } });
  await db.$disconnect();
  await redis.quit().catch(() => undefined);
});

d("run control (spec-19)", () => {
  it("startBackgroundRun plans, enqueues, supersedes stale previews and refuses a second live run", async () => {
    const preview = await planRun(db, CODE, {
      kind: "SINGLE_ENTITY",
      only: ["TOPIC"],
    });
    const started = await startBackgroundRun(db, actor, {
      locale: CODE,
      only: ["TOPIC"],
    });

    // A cost-free preview must not stay executable against a bank that has since moved on.
    const stale = await db.translationRun.findUniqueOrThrow({
      where: { id: preview.runId },
      select: { status: true, error: true },
    });
    expect(stale).toEqual({ status: "CANCELLED", error: "superseded" });

    const live = await db.translationRun.findUniqueOrThrow({
      where: { id: started.runId },
      select: { enqueuedAt: true, status: true, startedById: true },
    });
    expect(live.enqueuedAt).not.toBeNull();
    expect(live.status).toBe("PENDING");
    expect(live.startedById).toBe(actor.id);

    await expect(
      startBackgroundRun(db, actor, { locale: CODE }),
    ).rejects.toThrow(ConflictError);
    await requestCancel(db, actor, started.runId);
  });

  it("pause / resume / cancel flip the flags, restore claimability and audit", async () => {
    const started = await startBackgroundRun(db, actor, {
      locale: CODE,
      only: ["TOPIC"],
    });
    await db.translationRun.update({
      where: { id: started.runId },
      data: { status: "RUNNING" },
    });

    await requestPause(db, actor, started.runId);
    expect(
      (
        await db.translationRun.findUniqueOrThrow({
          where: { id: started.runId },
          select: { pauseRequested: true },
        })
      ).pauseRequested,
    ).toBe(true);

    // The runner honoured the pause and let the status follow — but it left the flag standing.
    await db.translationRun.update({
      where: { id: started.runId },
      data: { status: "PAUSED" },
    });
    const whilePaused = await executeRun(db, started.runId, {
      leaseOwner: "t-paused",
      maxUnits: 0,
    });
    expect(whilePaused.stopReason).toBe("notClaimed");

    // Only a resume clears it — without this a paused run would never be worked again.
    await resumeRun(db, actor, started.runId);
    expect(
      (
        await db.translationRun.findUniqueOrThrow({
          where: { id: started.runId },
          select: { pauseRequested: true },
        })
      ).pauseRequested,
    ).toBe(false);
    const afterResume = await executeRun(db, started.runId, {
      leaseOwner: "t-resumed",
      maxUnits: 0,
    });
    expect(afterResume.stopReason).toBe("budget");

    await requestCancel(db, actor, started.runId);
    // A run nobody is executing is finalised immediately.
    const cancelled = await db.translationRun.findUniqueOrThrow({
      where: { id: started.runId },
      select: { status: true, cancelRequested: true, finishedAt: true },
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelRequested).toBe(false);
    expect(cancelled.finishedAt).not.toBeNull();
    expect(
      await db.translationJob.count({
        where: { runId: started.runId, state: { in: ["QUEUED", "RUNNING"] } },
      }),
    ).toBe(0);

    const audits = await db.auditLog.findMany({
      where: { actorId: actor.id, entityId: started.runId },
      select: { action: true },
    });
    expect(audits.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "i18n.run_enqueued",
        "i18n.run_paused",
        "i18n.run_resumed",
        "i18n.run_cancelled",
      ]),
    );
  });

  it("refuses a pause on a run that is not running and a resume on one that is not paused", async () => {
    const started = await startBackgroundRun(db, actor, {
      locale: CODE,
      only: ["TOPIC"],
    });
    await expect(requestPause(db, actor, started.runId)).rejects.toThrow(
      ConflictError,
    );
    await expect(resumeRun(db, actor, started.runId)).rejects.toThrow(
      ConflictError,
    );
    await requestCancel(db, actor, started.runId);
    await expect(requestCancel(db, actor, started.runId)).rejects.toThrow(
      ConflictError,
    );
  });

  /**
   * The wedge: `requestCancel` correctly leaves a live runner to finalise itself, and both claim
   * queries exclude `cancelRequested`. So a runner killed between the flag and the batch boundary
   * left the run RUNNING for ever — no worker would touch it and `startBackgroundRun` refused a
   * new one, which locked the language out of translation entirely until someone ran SQL.
   */
  it("reaps a cancelled run whose runner died holding the lease, and frees the language", async () => {
    const started = await startBackgroundRun(db, actor, {
      locale: CODE,
      only: ["TOPIC"],
    });
    // A runner has it, and its lease is good for another two minutes.
    await db.translationRun.update({
      where: { id: started.runId },
      data: {
        status: "RUNNING",
        leaseOwner: "t-doomed",
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });

    await requestCancel(db, actor, started.runId);
    const flagged = await db.translationRun.findUniqueOrThrow({
      where: { id: started.runId },
      select: { status: true, cancelRequested: true },
    });
    expect(flagged).toEqual({ status: "RUNNING", cancelRequested: true });
    // While the lease is good the runner owns the ending: the reaper must keep its hands off.
    expect(await reapAbandonedCancels(db, new Date())).not.toContain(
      started.runId,
    );

    // kill -9. The lease lapses and nothing else in the system can ever finish this run.
    await db.translationRun.update({
      where: { id: started.runId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await reapAbandonedCancels(db, new Date())).toContain(started.runId);

    const reaped = await db.translationRun.findUniqueOrThrow({
      where: { id: started.runId },
      select: {
        status: true,
        finishedAt: true,
        cancelRequested: true,
        pauseRequested: true,
        leaseOwner: true,
        leaseExpiresAt: true,
      },
    });
    // Exactly what requestCancel's own "no runner" branch writes — one shared function, so the
    // two endings cannot drift.
    expect(reaped).toEqual({
      status: "CANCELLED",
      finishedAt: expect.any(Date),
      cancelRequested: false,
      pauseRequested: false,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(
      await db.translationJob.count({
        where: { runId: started.runId, state: "SKIPPED", error: "cancelled" },
      }),
    ).toBe(started.plannedUnits);

    // The point of all of it: the language can be translated again.
    const next = await startBackgroundRun(db, actor, {
      locale: CODE,
      only: ["TOPIC"],
    });
    await requestCancel(db, actor, next.runId);
  });

  it("runDetail reports counts, per-entity states, stale heartbeat and eta", async () => {
    const started = await startBackgroundRun(db, actor, {
      locale: CODE,
      only: ["TOPIC"],
    });
    await db.translationRun.update({
      where: { id: started.runId },
      data: {
        status: "RUNNING",
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        rateUnitsPerMin: 10,
        modelBatches: 2,
        translatedUnits: 2,
      },
    });

    const detail = await runDetail(db, started.runId);
    expect(detail.stale).toBe(true);
    expect(
      detail.byEntity.find((entry) => entry.entity === "TOPIC")?.queued,
    ).toBe(started.plannedUnits);
    expect(detail.remaining).toBe(started.plannedUnits);
    expect(detail.done).toBe(false);
    expect(detail.etaSeconds).toBe(
      Math.round((started.plannedUnits / 10) * 60),
    );
    expect(detail.spentUsd).toBe(0);
    // Dates cross the RSC boundary every three seconds, so they leave here as strings.
    expect(typeof detail.enqueuedAt).toBe("string");
    expect(typeof detail.heartbeatAt).toBe("string");

    // The language card reads the newest enqueued run for the locale.
    expect((await latestRunFor(db, CODE))?.runId).toBe(started.runId);

    await requestCancel(db, actor, started.runId);
  });
});
