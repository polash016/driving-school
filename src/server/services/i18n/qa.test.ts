import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * spec-19a Task 3: batch size moved from 5 units to 20, and `semanticCheck` embeds up to 10 texts
 * per unit in one `aiEmbed` call. At 20 units that is 200 texts — but Google's `batchEmbedContents`
 * accepts at most 100 requests per call and answers 400 (non-retryable), which turns into
 * `QA_UNAVAILABLE` on every unit in the batch. These tests pin the chunking behavior that fixes it.
 *
 * Stubbed gateway: this is about the shape and count of `aiEmbed` calls, not about a live model.
 */
const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));

const { semanticCheck } = await import("./qa");

interface StubUnit {
  id: string;
  value: Record<string, unknown>;
}

/** Echo the translated payload back as the "back-translation" — content doesn't matter here since
 * `aiEmbed` is stubbed to a fixed vector regardless of text. */
function echo(unitsJson: string) {
  const items = JSON.parse(unitsJson) as StubUnit[];
  return items.map((unit) => ({ id: unit.id, value: unit.value }));
}

function stubBackTranslation() {
  aiJson.mockImplementation(async (opts: { vars: { unitsJson: string } }) => ({
    data: { units: echo(opts.vars.unitsJson) },
    modelVersion: "stub-model",
    promptVersion: "qa.backTranslation@1.0.0",
    usage: { promptTokens: 10, completionTokens: 10 },
    providerLabel: "stub",
  }));
}

/** Every text maps to the same unit vector, so every cosine comparison is 1 and nothing is flagged. */
function stubUnitVectors() {
  aiEmbed.mockImplementation(async (texts: string[]) =>
    texts.map(() => [1, 0, 0]),
  );
}

const STEM_A =
  "At an unmarked crossing where two roads of equal size meet, who has the right of way?";
const STEM_B =
  "When approaching a roundabout with multiple lanes, which lane should you choose for a straight exit?";

function buildUnit(n: number) {
  const stem = n % 2 === 0 ? STEM_A : STEM_B;
  return {
    id: `unit-${n}`,
    entity: "MASTER_ITEM" as const,
    source: {
      stem,
      options: [
        { key: "a", text: `Give way to traffic from the right, item ${n}` },
        { key: "b", text: `Proceed if the way is clear, item ${n}` },
        { key: "c", text: `Sound the horn and continue, item ${n}` },
        { key: "d", text: `Stop unconditionally, item ${n}` },
      ],
    },
    translated: {
      stem: `${stem} (translated ${n})`,
      options: [
        { key: "a", text: `Vik for trafikk fra høyre, item ${n}` },
        { key: "b", text: `Kjør videre hvis fritt, item ${n}` },
        { key: "c", text: `Bruk hornet og fortsett, item ${n}` },
        { key: "d", text: `Stopp uansett, item ${n}` },
      ],
    },
    correctOptionKey: "a",
  };
}

beforeEach(() => {
  aiJson.mockReset();
  aiEmbed.mockReset();
});

describe("semanticCheck embedding batches", () => {
  it("embeds in slices of at most 100 texts", async () => {
    stubBackTranslation();
    stubUnitVectors();
    const units = Array.from({ length: 20 }, (_, i) => buildUnit(i));

    const results = await semanticCheck({
      locale: "nb",
      languageName: "Norwegian",
      units,
    });

    expect(aiEmbed).toHaveBeenCalledTimes(2);
    const [firstCallTexts] = aiEmbed.mock.calls[0] as [string[], unknown];
    const [secondCallTexts] = aiEmbed.mock.calls[1] as [string[], unknown];
    expect(firstCallTexts).toHaveLength(100);
    expect(secondCallTexts).toHaveLength(100);

    expect(results.size).toBe(20);
    for (const unit of units) {
      const result = results.get(unit.id);
      expect(result?.semanticScore).not.toBeNull();
      expect(result?.flags).toEqual([]);
    }
  });

  it("a 7-unit batch still makes one embed call", async () => {
    stubBackTranslation();
    stubUnitVectors();
    const units = Array.from({ length: 7 }, (_, i) => buildUnit(i));

    await semanticCheck({
      locale: "nb",
      languageName: "Norwegian",
      units,
    });

    expect(aiEmbed).toHaveBeenCalledTimes(1);
    const [texts] = aiEmbed.mock.calls[0] as [string[], unknown];
    expect(texts).toHaveLength(70);
  });

  it("an embed failure still flags every unit QA_UNAVAILABLE", async () => {
    stubBackTranslation();
    aiEmbed.mockRejectedValue(new Error("400 Bad Request"));
    const units = Array.from({ length: 20 }, (_, i) => buildUnit(i));

    const results = await semanticCheck({
      locale: "nb",
      languageName: "Norwegian",
      units,
    });

    expect(results.size).toBe(20);
    for (const unit of units) {
      const result = results.get(unit.id);
      expect(result?.flags).toContain("QA_UNAVAILABLE");
      expect(result?.report.embeddings).toBe("failed");
    }
  });

  it("the signal is passed to every embed slice", async () => {
    stubBackTranslation();
    stubUnitVectors();
    const units = Array.from({ length: 20 }, (_, i) => buildUnit(i));
    const controller = new AbortController();

    await semanticCheck({
      locale: "nb",
      languageName: "Norwegian",
      units,
      signal: controller.signal,
    });

    expect(aiEmbed).toHaveBeenCalledTimes(2);
    for (const call of aiEmbed.mock.calls) {
      const [, options] = call as [string[], { signal?: AbortSignal }];
      expect(options?.signal).toBe(controller.signal);
    }
  });
});
