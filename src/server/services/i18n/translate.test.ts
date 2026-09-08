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

interface GatewayEnvelope {
  data: { units: Array<Record<string, unknown>> };
  modelVersion: string;
  promptVersion: string;
  usage: { promptTokens: number; completionTokens: number };
  providerLabel: string;
}

/**
 * The five-field shape every `aiJson` call returns, whichever task asked and whatever built its
 * `units` — the one thing that differs by task is which prompt version comes back.
 */
function gatewayEnvelope(
  task: string,
  units: Array<Record<string, unknown>>,
): GatewayEnvelope {
  return {
    data: { units },
    modelVersion: "stub-model",
    promptVersion:
      task === "validation"
        ? "qa.backTranslation@1.0.0"
        : "translation.units@1.0.0",
    usage: { promptTokens: 100, completionTokens: 100 },
    providerLabel: "stub",
  };
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
      return gatewayEnvelope(opts.task, units);
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

  it("issues no transaction for an empty batch", async () => {
    const { stub, db } = stubDb();
    await storeTranslations(db, "es", [], "run1");

    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.translation.upsert).not.toHaveBeenCalled();
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

  it("never fails the batch when the memory write does", async () => {
    const { stub, db } = stubDb();
    stubTranslation();
    // A lost memory row costs a few tokens next time; failing the run over it costs the batch.
    stub.$transaction.mockRejectedValueOnce(new Error("pool timeout"));

    const out = await translateBatch(db, language, [topicUnit(1)], {});

    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("MACHINE");
  });
});

/**
 * spec-19a Task 6: an advisory finding must not spend a back-translation on its own.
 *
 * `language.qaSampleRate` is 0 for every case here, so nothing is sampled unless something
 * *forces* it. The observable for "the semantic check ran" is a second `aiJson` call carrying
 * `task: "validation"` — that is the first thing `semanticCheck` does (a back-translation),
 * ahead of any embedding call.
 */
describe("translateBatch semantic-check sampling", () => {
  /**
   * Answers both calls `translateBatch` can make through the gateway: `task: "translation"`
   * returns the crafted `byId` values (falling back to an untouched echo of the source for any
   * id not listed); `task: "validation"` (the back-translation inside `semanticCheck`) just
   * echoes the translated value back, since these tests only care THAT it was called.
   */
  function mockGateway(
    byId: Record<string, Record<string, string>>,
    flagged: string[] = [],
  ) {
    aiJson.mockImplementation(
      async (opts: { task: string; vars: { unitsJson: string } }) => {
        const items = JSON.parse(opts.vars.unitsJson) as Array<{
          id: string;
          value?: Record<string, string>;
          en?: Record<string, string>;
        }>;
        if (opts.task === "translation") {
          const units = items.map((item) => ({
            id: item.id,
            value: byId[item.id] ?? item.en,
            ...(flagged.includes(item.id)
              ? { issue: "two options would read the same" }
              : {}),
          }));
          return gatewayEnvelope(opts.task, units);
        }
        // The back-translation: echo the translated value straight back. What it says does not
        // matter to these tests — only that the call happened.
        const units = items.map((item) => ({ id: item.id, value: item.value }));
        return gatewayEnvelope(opts.task, units);
      },
    );
    aiEmbed.mockImplementation(async (texts: string[]) =>
      texts.map(() => [1, 0, 0]),
    );
  }

  function validationCalls() {
    return aiJson.mock.calls.filter(
      (call) => (call[0] as { task: string }).task === "validation",
    );
  }

  it("LENGTH_OUTLIER alone does not force a semantic check", async () => {
    const { db } = stubDb();
    const unit = {
      entity: "TOPIC" as const,
      entityId: "topic-long",
      en: {
        name: "Roundabouts",
        description:
          "How to give way politely and safely when entering a busy " +
          "roundabout during peak traffic hours in the city center, every day.",
      },
      label: "Roundabouts",
      sourceHash: "hash-long",
    };
    // A ~15-char echo of a ~120-char source: well past the 0.4 ratio LENGTH_OUTLIER (advisory,
    // not blocking) fires on, but clearly not identical to the source, so UNTRANSLATED does not.
    mockGateway({ "topic-long": { name: "ES", description: "Muy breve." } });

    const out = await translateBatch(db, language, [unit], {});

    expect(aiJson).toHaveBeenCalledTimes(1);
    expect((aiJson.mock.calls[0][0] as { task: string }).task).toBe(
      "translation",
    );
    expect(validationCalls()).toHaveLength(0);
    expect(out[0].qaFlags).toContain("LENGTH_OUTLIER");
    expect(out[0].status).toBe("MACHINE");
  });

  it("a blocking finding still forces the semantic check at qaSampleRate 0", async () => {
    const { db } = stubDb();
    // Echoes the source's words but changes "1" to "2" — NUMBER_DRIFT (blocking) fires, nothing
    // else does.
    mockGateway({
      "topic-1": {
        name: "Roundabouts 1",
        description: "How to give way when entering a roundabout, part 2.",
      },
    });

    const out = await translateBatch(db, language, [topicUnit(1)], {});

    expect(validationCalls()).toHaveLength(1);
    expect(out[0].qaFlags).toContain("NUMBER_DRIFT");
    expect(out[0].status).toBe("NEEDS_REVIEW");
  });

  it("a model-raised issue forces the semantic check", async () => {
    const { db } = stubDb();
    // A faithful translation (numbers, structure all intact) but the model flags its own doubt.
    mockGateway(
      {
        "topic-1": {
          name: "ES Roundabouts 1",
          description:
            "ES Cómo ceder el paso al entrar en una rotonda, parte 1.",
        },
      },
      ["topic-1"],
    );

    const out = await translateBatch(db, language, [topicUnit(1)], {});

    expect(validationCalls()).toHaveLength(1);
    expect(out[0].qaFlags).toContain("MODEL_FLAGGED");
    expect(out[0].status).toBe("NEEDS_REVIEW");
  });
});
