import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/server/services/i18n/translate", () => ({ translateBatch: vi.fn() }));
vi.mock("@/server/services/i18n/repair", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/i18n/repair")>();
  return { ...actual, repairBatch: vi.fn() };
});

import { translateBatch } from "@/server/services/i18n/translate";
import { repairBatch } from "@/server/services/i18n/repair";
import { shadowTranslate } from "./shadow-translate";
import type { QuestionContent } from "./simplify";

const proposed: QuestionContent = {
  en: {
    stem: "Who has right of way at an unmarked intersection?",
    options: [
      { key: "a", text: "Traffic from your right" },
      { key: "b", text: "Traffic from your left" },
    ],
    explanation: "The right-hand rule applies. § 7 nr. 2",
  },
  nb: {
    stem: "Hvem har forkjorsrett i et umerket kryss?",
    options: [
      { key: "a", text: "Trafikk fra hoyre" },
      { key: "b", text: "Trafikk fra venstre" },
    ],
    explanation: "Hoyreregelen gjelder. § 7 nr. 2",
  },
};

const bn = {
  code: "bn",
  englishName: "Bengali",
  nativeName: "বাংলা",
  glossary: null,
  glossaryVersion: 1,
  styleNote: null,
  qaSampleRate: 1,
  requiresApproval: false,
};

function unitResult(status: "MACHINE" | "NEEDS_REVIEW", qaFlags: string[], text = "ok") {
  return {
    unit: { entity: "MASTER_ITEM", entityId: "item1", en: proposed.en, nb: proposed.nb, sourceHash: "h" },
    value: { stem: text, options: [], explanation: "" },
    status,
    qaFlags,
    qaReport: { issues: qaFlags.map((code) => ({ code, blocking: true, detail: "80 to 60" })) },
    semanticScore: null,
    fromMemory: false,
    modelVersion: "m",
    promptVersion: "p",
    providerLabel: null,
    promptTokens: 1,
    completionTokens: 1,
  };
}

const db = {} as PrismaClient;
const input = { itemId: "item1", proposed, correctOptionKey: "a", label: "q item1" };

describe("shadowTranslate repair loop", () => {
  beforeEach(() => {
    vi.mocked(translateBatch).mockReset();
    vi.mocked(repairBatch).mockReset();
  });

  it("serves a clean translation without touching repair", async () => {
    vi.mocked(translateBatch).mockResolvedValueOnce([unitResult("MACHINE", []) as never]);
    const out = await shadowTranslate(db, bn, input);
    expect(out.translation?.status).toBe("MACHINE");
    expect(repairBatch).not.toHaveBeenCalled();
  });

  it("repairs a flagged translation with its findings and swaps the repaired one", async () => {
    vi.mocked(translateBatch).mockResolvedValueOnce([unitResult("NEEDS_REVIEW", ["NUMBER_DRIFT"]) as never]);
    vi.mocked(repairBatch).mockResolvedValueOnce({
      translated: [unitResult("MACHINE", [], "repaired") as never],
      consumed: new Set(["item1"]),
    });
    const out = await shadowTranslate(db, bn, input);
    expect(out.translation?.status).toBe("MACHINE");
    expect((out.translation?.value as { stem: string }).stem).toBe("repaired");
    const context = vi.mocked(repairBatch).mock.calls[0]![3]!;
    expect(context.get("item1")?.problems).toEqual([{ code: "NUMBER_DRIFT", detail: "80 to 60" }]);
  });

  it("gives up after two repairs and reports the last verdict", async () => {
    vi.mocked(translateBatch).mockResolvedValueOnce([unitResult("NEEDS_REVIEW", ["SEMANTIC_DRIFT"]) as never]);
    vi.mocked(repairBatch)
      .mockResolvedValueOnce({ translated: [unitResult("NEEDS_REVIEW", ["SEMANTIC_DRIFT"]) as never], consumed: new Set() })
      .mockResolvedValueOnce({ translated: [unitResult("NEEDS_REVIEW", ["ANSWER_PERMUTED"]) as never], consumed: new Set() });
    const out = await shadowTranslate(db, bn, input);
    expect(out.translation).toBeNull();
    expect(repairBatch).toHaveBeenCalledTimes(2);
    expect(out.reason).toBe("QA returned NEEDS_REVIEW: ANSWER_PERMUTED");
  });

  it("does not spend a repair on an infrastructure-only flag", async () => {
    vi.mocked(translateBatch).mockResolvedValueOnce([unitResult("NEEDS_REVIEW", ["QA_UNAVAILABLE"]) as never]);
    const out = await shadowTranslate(db, bn, input);
    expect(out.translation).toBeNull();
    expect(repairBatch).not.toHaveBeenCalled();
  });

  it("does not repair for a language that requires approval — nothing it returns is servable today", async () => {
    vi.mocked(translateBatch).mockResolvedValueOnce([unitResult("NEEDS_REVIEW", ["NUMBER_DRIFT"]) as never]);
    const out = await shadowTranslate(db, { ...bn, code: "ar", requiresApproval: true }, input);
    expect(out.translation).toBeNull();
    expect(repairBatch).not.toHaveBeenCalled();
  });

  it("retries a thrown provider error once", async () => {
    vi.mocked(translateBatch)
      .mockRejectedValueOnce(new Error("response failed contract validation"))
      .mockResolvedValueOnce([unitResult("MACHINE", []) as never]);
    const out = await shadowTranslate(db, bn, input);
    expect(out.translation?.status).toBe("MACHINE");
    expect(translateBatch).toHaveBeenCalledTimes(2);
  });

  it("holds when both attempts throw", async () => {
    vi.mocked(translateBatch).mockRejectedValue(new Error("boom"));
    const out = await shadowTranslate(db, bn, input);
    expect(out.translation).toBeNull();
    expect(out.reason).toBe("translation call failed");
  });
});
