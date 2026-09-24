import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import { applyProposalsFromRun, type ApplyFromRunDeps } from "./apply-proposals";
import type { QuestionContent } from "./simplify";

const proposed: QuestionContent = {
  en: {
    stem: "Who has right of way at an unmarked intersection?",
    options: [
      { key: "a", text: "Traffic from your right" },
      { key: "b", text: "Traffic from your left" },
    ],
    explanation: "The right-hand rule applies.",
  },
  nb: {
    stem: "Hvem har forkjorsrett i et umerket kryss?",
    options: [
      { key: "a", text: "Trafikk fra hoyre" },
      { key: "b", text: "Trafikk fra venstre" },
    ],
    explanation: "Hoyreregelen gjelder.",
  },
};

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `p-${id}`,
    masterItemId: id,
    proposed,
    expectedVersion: 1,
    expectedFingerprint: `fp-${id}`,
    masterItem: { status: "APPROVED", deletedAt: null, correctOptionKey: "a" },
    ...overrides,
  };
}

function fakeDb(rows: ReturnType<typeof row>[]) {
  const update = vi.fn(async () => ({ id: "x" }));
  const findMany = vi.fn(async () => rows);
  return {
    db: { simplificationProposal: { findMany, update } } as unknown as PrismaClient,
    update,
    findMany,
  };
}

const ready = async () => ({
  ready: true,
  translations: [{ locale: "bn", value: {}, status: "MACHINE" as const, sourceHash: "h" }],
  failures: [],
});
const languages = async () => [];
const embed = async () => [0.1, 0.2];
const silent = () => undefined;

describe("applyProposalsFromRun", () => {
  it("swaps exactly the stored proposal and marks the row APPLIED", async () => {
    const { db, update } = fakeDb([row("item1")]);
    const rewrite = vi.fn<ApplyFromRunDeps["rewrite"]>(async () => ({
      itemId: "item1", versionFrom: 1, versionTo: 2, variantsCreated: 1, variantsReused: 0, translationsWritten: 1,
    }));

    const result = await applyProposalsFromRun(
      db,
      { runId: "run-1", actorId: "admin" },
      { translate: ready, rewrite, embed, loadLanguages: languages, log: silent },
    );

    expect(result.applied).toEqual(["item1"]);
    expect(rewrite).toHaveBeenCalledTimes(1);
    const call = rewrite.mock.calls[0]![1]!;
    expect(call.newContent).toBe(proposed);
    expect(call.expectedVersion).toBe(1);
    expect(call.expectedFingerprint).toBe("fp-item1");
    expect(call.runId).toBe("run-1");
    expect(call.stemEmbedding).toEqual([0.1, 0.2]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-item1" },
        data: expect.objectContaining({ status: "APPLIED", appliedById: "admin" }),
      }),
    );
  });

  it("only ever asks for PROPOSED rows of that run", async () => {
    const { db, findMany } = fakeDb([]);
    await applyProposalsFromRun(
      db,
      { runId: "run-9", actorId: "admin" },
      { translate: ready, rewrite: vi.fn(), embed, loadLanguages: languages, log: silent },
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runId: "run-9", status: "PROPOSED" }),
      }),
    );
  });

  it("holds an item whose student-visible translation is not ready, and writes nothing", async () => {
    const { db, update } = fakeDb([row("item1")]);
    const rewrite = vi.fn();
    const result = await applyProposalsFromRun(
      db,
      { runId: "run-1", actorId: "admin" },
      {
        translate: async () => ({
          ready: false,
          translations: [],
          failures: [{ locale: "bn", reason: "QA returned REJECTED", qaFlags: ["NUMBER_DRIFT"] }],
        }),
        rewrite,
        embed,
        loadLanguages: languages,
        log: silent,
      },
    );
    expect(result.applied).toEqual([]);
    expect(result.held).toEqual([
      { itemId: "item1", reason: "translation not ready — bn(QA returned REJECTED)" },
    ]);
    expect(rewrite).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("turns a stale proposal (ConflictError) into a hold and keeps going", async () => {
    const { db, update } = fakeDb([row("stale"), row("fresh")]);
    const rewrite = vi.fn(async (_db: unknown, input: { itemId: string }) => {
      if (input.itemId === "stale") {
        throw new ConflictError({ itemId: "stale" }, "admin.questions.errors.rewriteStale");
      }
      return {
        itemId: input.itemId, versionFrom: 1, versionTo: 2, variantsCreated: 1, variantsReused: 0, translationsWritten: 1,
      };
    });
    const result = await applyProposalsFromRun(
      db,
      { runId: "run-1", actorId: "admin" },
      { translate: ready, rewrite: rewrite as never, embed, loadLanguages: languages, log: silent },
    );
    expect(result.held).toEqual([
      { itemId: "stale", reason: "item changed since the proposal (stale)" },
    ]);
    expect(result.applied).toEqual(["fresh"]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("skips a proposal whose item is no longer approved", async () => {
    const { db } = fakeDb([
      row("retired", { masterItem: { status: "RETIRED", deletedAt: null, correctOptionKey: "a" } }),
    ]);
    const rewrite = vi.fn();
    const result = await applyProposalsFromRun(
      db,
      { runId: "run-1", actorId: "admin" },
      { translate: ready, rewrite, embed, loadLanguages: languages, log: silent },
    );
    expect(result.skipped).toHaveLength(1);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("re-throws anything that is not a concurrency conflict", async () => {
    const { db } = fakeDb([row("item1")]);
    await expect(
      applyProposalsFromRun(
        db,
        { runId: "run-1", actorId: "admin" },
        {
          translate: ready,
          rewrite: vi.fn(async () => { throw new Error("db down"); }),
          embed,
          loadLanguages: languages,
          log: silent,
        },
      ),
    ).rejects.toThrow("db down");
  });
});
