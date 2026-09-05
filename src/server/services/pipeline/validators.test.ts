import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The blind answer-check, against a stubbed gateway.
 *
 * Stubbed deliberately: these tests must prove the COMPARISON logic is right — that a disputed key
 * is refused, that the verifier is never shown the key, that a quote it did not read is not
 * evidence — and none of that should depend on a live model's mood or on a rate limit.
 */
const aiJson = vi.fn();
const aiEmbed = vi.fn();
vi.mock("@/server/ai/client", () => ({
  aiJson: (...args: unknown[]) => aiJson(...args),
  aiEmbed: (...args: unknown[]) => aiEmbed(...args),
}));

const {
  verifyAnswerBlind,
  checkDistractorDistinctness,
  checkStemHidesTheSign,
  checkStemDoesNotLeakAnswer,
} = await import("./validators");

const LEGAL =
  "§ 5. Vikeplikt- og forkjørsskilt. Skilt 202 Vikeplikt angir at kjørende har vikeplikt for trafikk i begge retninger på kryssende veg.";

const base = {
  stem: "What must you do at this sign?",
  options: [
    { key: "a", text: "Give way to traffic on the crossing road" },
    { key: "b", text: "Stop completely, then continue" },
    { key: "c", text: "Sound your horn and proceed" },
    { key: "d", text: "You have priority over the crossing road" },
  ],
  correctOptionKey: "a",
  situationSummary: "A junction with a give-way sign.",
  signNames: ["Vikeplikt"],
  legalText: LEGAL,
  seed: "item-1",
};

/** Answer as whichever option text the stub is told to pick, whatever position it was shuffled to. */
function verifierPicks(text: string, extra: Record<string, unknown> = {}) {
  aiJson.mockImplementation(async (opts: { vars: { options: string[] } }) => ({
    data: {
      choice: opts.vars.options.findIndex((o) => o === text) + 1,
      quote:
        "kjørende har vikeplikt for trafikk i begge retninger på kryssende veg",
      unanswerable: false,
      ...extra,
    },
    modelVersion: "stub-model",
    promptVersion: "1.0.0",
  }));
}

beforeEach(() => {
  aiJson.mockReset();
  aiEmbed.mockReset();
});

describe("verifyAnswerBlind", () => {
  it("passes when the verifier independently reaches the authored key", async () => {
    verifierPicks("Give way to traffic on the crossing road");
    const result = await verifyAnswerBlind(base);
    expect(result.verified).toBe(true);
    expect(result.verifierModel).toBe("stub-model");
  });

  it("REFUSES a mis-keyed question — the failure no other validator finds", async () => {
    verifierPicks("Give way to traffic on the crossing road");
    // The author marked the opposite of the rule as correct.
    const result = await verifyAnswerBlind({ ...base, correctOptionKey: "d" });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("answer key disputed");
  });

  it("never shows the verifier the key, the explanation, or the authored order", async () => {
    verifierPicks("Give way to traffic on the crossing road");
    await verifyAnswerBlind(base);

    const { vars } = aiJson.mock.calls[0][0];
    const sent = JSON.stringify(vars);
    expect(sent).not.toContain("correctOptionKey");
    // Options travel as bare strings — no a/b/c/d keys the verifier could align with a key.
    expect(vars.options).toEqual(
      expect.arrayContaining([base.options[0].text]),
    );
    expect(sent).not.toMatch(/"key"/);
  });

  it("refuses when the verifier says the cited rule does not settle it", async () => {
    aiJson.mockResolvedValue({
      data: { choice: 1, quote: "", unanswerable: true },
      modelVersion: "stub-model",
      promptVersion: "1.0.0",
    });
    const result = await verifyAnswerBlind(base);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("does not settle");
  });

  it("refuses agreement backed by a quote that is not in the cited text", async () => {
    // Agreeing for a reason it invented is not evidence the rule supports the answer.
    aiJson.mockImplementation(
      async (opts: { vars: { options: string[] } }) => ({
        data: {
          choice:
            opts.vars.options.findIndex((o) => o === base.options[0].text) + 1,
          quote:
            "drivers must always yield to vehicles approaching from the left at all times",
          unanswerable: false,
        },
        modelVersion: "stub-model",
        promptVersion: "1.0.0",
      }),
    );
    const result = await verifyAnswerBlind(base);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("not in the cited text");
  });

  it("refuses when the verifier returns no choice at all", async () => {
    // Every tolerance in the schema must fail towards refusal: a missing answer is emphatically
    // not independent confirmation of the key.
    aiJson.mockResolvedValue({
      data: { quote: "", unanswerable: false },
      modelVersion: "stub-model",
      promptVersion: "1.0.0",
    });
    expect((await verifyAnswerBlind(base)).verified).toBe(false);
  });

  it("accepts a choice returned as a string, as some models do", async () => {
    aiJson.mockImplementation(
      async (opts: { vars: { options: string[] } }) => ({
        data: {
          choice: String(
            opts.vars.options.findIndex((o) => o === base.options[0].text) + 1,
          ),
          quote:
            "kjørende har vikeplikt for trafikk i begge retninger på kryssende veg",
          unanswerable: false,
        },
        modelVersion: "stub-model",
        promptVersion: "1.0.0",
      }),
    );
    expect((await verifyAnswerBlind(base)).verified).toBe(true);
  });

  it("refuses an out-of-range choice rather than crashing on it", async () => {
    aiJson.mockResolvedValue({
      data: { choice: 99, quote: "", unanswerable: false },
      modelVersion: "stub-model",
      promptVersion: "1.0.0",
    });
    expect((await verifyAnswerBlind(base)).verified).toBe(false);
  });

  it("is reproducible: the same item shuffles the same way", async () => {
    verifierPicks("Give way to traffic on the crossing road");
    await verifyAnswerBlind(base);
    await verifyAnswerBlind(base);
    expect(aiJson.mock.calls[0][0].vars.options).toEqual(
      aiJson.mock.calls[1][0].vars.options,
    );
  });
});

describe("checkDistractorDistinctness", () => {
  const vec = (a: number, b: number) => [a, b];

  it("flags two options that mean the same thing", async () => {
    // Identical vectors = a paraphrase pair; a student picking the "wrong" twin is marked wrong
    // for a distinction that does not exist.
    aiEmbed.mockResolvedValue([vec(1, 0), vec(1, 0), vec(0, 1)]);
    const result = await checkDistractorDistinctness([
      { key: "a", text: "You must stop completely" },
      { key: "b", text: "You have to come to a full halt" },
      { key: "c", text: "You may continue" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.collidingKeys).toEqual(["a", "b"]);
  });

  it("passes genuinely distinct options", async () => {
    aiEmbed.mockResolvedValue([vec(1, 0), vec(0, 1)]);
    const result = await checkDistractorDistinctness([
      { key: "a", text: "Give way" },
      { key: "b", text: "You have priority" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.collidingKeys).toBeNull();
  });
});

describe("scene fit", () => {
  it("refuses a question about a sign that is not in the picture, however right the rule is", async () => {
    // Observed on a real batch: a question about where to stop, for a picture holding only a
    // give-way sign and a no-entry sign. The regulation section covers ALL priority signs, so the
    // law checked out perfectly while the picture showed something else.
    aiJson.mockResolvedValue({
      data: {
        choice: 1,
        quote: "",
        unanswerable: false,
        sceneSupported: false,
      },
      modelVersion: "stub-model",
      promptVersion: "1.0.0",
    });
    const result = await verifyAnswerBlind(base);
    expect(result.verified).toBe(false);
    expect(result.sceneMismatch).toBe(true);
  });

  it("treats a missing verdict as scene-supported, so an omission cannot fail a good item", async () => {
    verifierPicks("Give way to traffic on the crossing road");
    const result = await verifyAnswerBlind(base);
    expect(result.sceneMismatch).toBe(false);
    expect(result.verified).toBe(true);
  });
});

describe("checkStemDoesNotLeakAnswer", () => {
  it("refuses a stem that paraphrases its own correct option", async () => {
    aiEmbed.mockResolvedValue([
      [1, 0],
      [1, 0],
    ]);
    const result = await checkStemDoesNotLeakAnswer(
      "One of them indicates that drivers must give way to traffic in both directions.",
      "That drivers have a duty to give way to traffic in both directions on the crossing road.",
    );
    expect(result.ok).toBe(false);
  });

  it("passes a stem that asks rather than tells", async () => {
    aiEmbed.mockResolvedValue([
      [1, 0],
      [0, 1],
    ]);
    expect(
      (
        await checkStemDoesNotLeakAnswer(
          "What must you do at this sign?",
          "Give way",
        )
      ).ok,
    ).toBe(true);
  });
});

describe("checkStemHidesTheSign", () => {
  const signs = [
    { code: "202", name: "Give way" },
    { code: "302", name: "No entry" },
  ];

  it("refuses a stem that names the sign in the picture", () => {
    // Observed on the first real batch, despite the prompt forbidding it — which is why this is a
    // check and not an instruction.
    const result = checkStemHidesTheSign(
      "You see two signs, one of which is the Give Way sign. What does it specify?",
      signs,
    );
    expect(result.ok).toBe(false);
    expect(result.revealed).toBe("Give way");
  });

  it("refuses a stem naming the sign by its code", () => {
    expect(
      checkStemHidesTheSign("What does sign 302 require of you?", signs).ok,
    ).toBe(false);
  });

  it("allows a question that merely uses the words in a normal sentence", () => {
    // "Must you give way" is the question a driver actually faces; only the sign's NAME used to
    // label the sign is a give-away.
    expect(
      checkStemHidesTheSign(
        "Must you give way to traffic from the right here?",
        signs,
      ).ok,
    ).toBe(true);
    expect(
      checkStemHidesTheSign("Are you allowed to enter this road?", signs).ok,
    ).toBe(true);
  });

  it("allows the wording the prompt asks for", () => {
    expect(
      checkStemHidesTheSign("What does the sign on the right mean?", signs).ok,
    ).toBe(true);
    expect(
      checkStemHidesTheSign("What must you do at this sign?", signs).ok,
    ).toBe(true);
  });
});
