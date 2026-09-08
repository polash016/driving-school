import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * spec-19a Task 5: the per-batch write overhead.
 *
 * Three things this pins, all of which only matter once several batches run concurrently:
 * the row writes go out as ONE array `$transaction` (one connection per slot, atomic with the
 * DONE marking that follows) rather than N sequential upserts; the memory writes do the same;
 * and the "previously rejected" examples are computed once per run and passed in, instead of
 * being re-queried on every batch.
 *
 * Pure: the gateway and the logger are stubbed, and `db` is a hand-written stub carrying only the
 * methods these paths touch.
 */
const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { storeTranslations, translateBatch } = await import("./translate");
const { memoryHash } = await import("./units");
type TranslatedUnit = Awaited<ReturnType<typeof translateBatch>>[number];

const language = {
  code: "es",
  englishName: "Spanish",
  nativeName: "Español",
  glossary: null,
  glossaryVersion: 1,
  styleNote: null,
  /** 0: a clean unit skips the semantic pass, so these cases stay about the writes. */
  qaSampleRate: 0,
};

/** Only the argument shapes these assertions read; the stubs ignore the rest. */
interface FindManyArgs {
  where?: { status?: string };
}
interface RowUpsertArgs {
  where: { locale_entity_entityId: { entityId: string } };
}
interface MemoryUpsertArgs {
  where: { locale_sourceHash: { sourceHash: string } };
}

function stubDb() {
  const stub = {
    translation: {
      findMany: vi.fn<(args: FindManyArgs) => Promise<unknown[]>>(
        async () => [],
      ),
      upsert: vi.fn<(args: RowUpsertArgs) => Promise<{ id: string }>>(() =>
        Promise.resolve({ id: "row" }),
      ),
    },
    translationMemory: {
      findMany: vi.fn<(args: FindManyArgs) => Promise<unknown[]>>(
        async () => [],
      ),
      upsert: vi.fn<(args: MemoryUpsertArgs) => Promise<{ id: string }>>(() =>
        Promise.resolve({ id: "mem" }),
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // The real client resolves an array of PrismaPromises; nothing here needs a real transaction.
    $transaction: vi.fn(async (ops: unknown) =>
      Promise.all(ops as Array<Promise<unknown>>),
    ),
  };
  return { stub, db: stub as unknown as PrismaClient };
}

function topicUnit(n: number) {
  const en = {
    name: `Roundabouts ${n}`,
    description: `How to give way when entering a roundabout, part ${n}.`,
  };
  return {
    entity: "TOPIC" as const,
    entityId: `topic-${n}`,
    en,
    label: `Roundabouts ${n}`,
    sourceHash: `hash-${n}`,
  };
}

function translatedUnit(n: number): TranslatedUnit {
  return {
    unit: topicUnit(n),
    value: { name: `ES Roundabouts ${n}`, description: `ES descripción ${n}` },
    status: "MACHINE",
    qaFlags: [],
    qaReport: null,
    semanticScore: null,
    fromMemory: false,
    modelVersion: "stub-model",
    promptVersion: "translation.units@1.0.0",
    providerLabel: "stub",
    promptTokens: 10,
    completionTokens: 10,
  };
}

interface ModelUnit {
  id: string;
  kind: string;
  en: Record<string, string>;
}

/**
 * Translate by prefixing — keeps every number, citation and placeholder intact (so the
 * deterministic gate passes) while never being byte-identical to the source (which would trip
 * UNTRANSLATED). `flagged` marks ids the model refuses, which is what sends them to review.
 */
function stubTranslation(flagged: string[] = []) {
  aiJson.mockImplementation(
    async (opts: { task: string; vars: { unitsJson: string } }) => {
      const items = JSON.parse(opts.vars.unitsJson) as Array<
        ModelUnit | { id: string; value: Record<string, string> }
      >;
      const units = items.map((item) => {
        const source =
          "en" in item ? item.en : (item.value as Record<string, string>);
        const value = Object.fromEntries(
          Object.entries(source).map(([key, text]) => [key, `ES ${text}`]),
        );
        return {
          id: item.id,
          value,
          ...(flagged.includes(item.id)
            ? { issue: "two options would read the same" }
            : {}),
        };
      });
      return {
        data: { units },
        modelVersion: "stub-model",
        promptVersion:
          opts.task === "validation"
            ? "qa.backTranslation@1.0.0"
            : "translation.units@1.0.0",
        usage: { promptTokens: 100, completionTokens: 100 },
        providerLabel: "stub",
      };
    },
  );
  aiEmbed.mockImplementation(async (texts: string[]) =>
    texts.map(() => [1, 0, 0]),
  );
}

function rejectionQueries(calls: FindManyArgs[][]) {
  return calls.filter((call) => call[0]?.where?.status === "REJECTED");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("storeTranslations", () => {
  it("issues one $transaction holding one upsert per unit", async () => {
    const { stub, db } = stubDb();
    await storeTranslations(
      db,
      "es",
      [translatedUnit(1), translatedUnit(2), translatedUnit(3)],
      "run1",
    );

    expect(stub.$transaction).toHaveBeenCalledTimes(1);
    const ops = stub.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(3);
    expect(stub.translation.upsert).toHaveBeenCalledTimes(3);
    expect(
      stub.translation.upsert.mock.calls.map(
        (call) => call[0].where.locale_entity_entityId.entityId,
      ),
    ).toEqual(["topic-1", "topic-2", "topic-3"]);
  });
});

describe("translateBatch rejections", () => {
  it("uses the rejections it is given and never queries them itself", async () => {
    const { stub, db } = stubDb();
    stubTranslation();

    await translateBatch(db, language, [topicUnit(1)], {
      rejections: [{ excerpt: "old wording", note: "too formal" }],
    });

    expect(rejectionQueries(stub.translation.findMany.mock.calls)).toHaveLength(
      0,
    );
    const vars = aiJson.mock.calls[0][0].vars as { rejectedBlock: string };
    expect(vars.rejectedBlock).toContain("old wording");
    expect(vars.rejectedBlock).toContain("too formal");
  });

  it("queries them itself when none are passed in", async () => {
    const { stub, db } = stubDb();
    stubTranslation();

    await translateBatch(db, language, [topicUnit(1)], {});

    expect(rejectionQueries(stub.translation.findMany.mock.calls)).toHaveLength(
      1,
    );
  });
});

describe("translation memory writes", () => {
  it("remembers the clean units of a batch in one transaction", async () => {
    const { stub, db } = stubDb();
    stubTranslation(["topic-2"]);

    const out = await translateBatch(
      db,
      language,
      [topicUnit(1), topicUnit(2), topicUnit(3)],
      {},
    );
    expect(out.map((item) => item.status)).toEqual([
      "MACHINE",
      "NEEDS_REVIEW",
      "MACHINE",
    ]);

    expect(stub.$transaction).toHaveBeenCalledTimes(1);
    const ops = stub.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(2);
    expect(stub.translationMemory.upsert).toHaveBeenCalledTimes(2);

    const written = stub.translationMemory.upsert.mock.calls.map(
      (call) => call[0].where.locale_sourceHash.sourceHash,
    );
    const hashOf = (n: number) => memoryHash("TOPIC", topicUnit(n).en, 1);
    expect(written).toEqual([hashOf(1), hashOf(3)]);
    expect(written).not.toContain(hashOf(2));
  });
});
