import { describe, expect, it } from "vitest";
import {
  checkClassDistinctness,
  distinctnessDelta,
  rerenderSignQuestion,
} from "./sign-simplify";
import type { QuestionContent } from "./simplify";

const question: QuestionContent = {
  en: {
    stem: "What does this sign mean?",
    options: [
      { key: "a", text: "You must give way to all traffic on the crossing road" },
      { key: "b", text: "The road ahead narrows from both sides" },
      { key: "c", text: "Overtaking is prohibited from this sign until the next junction" },
      { key: "d", text: "You must stop completely before entering the junction" },
    ],
    explanation: "Give way — You must give way to all traffic on the crossing road",
  },
  nb: {
    stem: "Hva betyr dette skiltet?",
    options: [
      { key: "a", text: "Du har vikeplikt for all trafikk pa kryssende veg" },
      { key: "b", text: "Vegen framover blir smalere fra begge sider" },
      { key: "c", text: "Forbikjoring er forbudt fra dette skiltet til neste kryss" },
      { key: "d", text: "Du ma stanse helt for du kjorer inn i krysset" },
    ],
    explanation: "Vikeplikt — Du har vikeplikt for all trafikk pa kryssende veg",
  },
};

const indexEn = new Map(
  Object.entries({
    "you must give way to all traffic on the crossing road": "Give way to crossing traffic.",
    "the road ahead narrows from both sides": "Road narrows from both sides.",
    "overtaking is prohibited from this sign until the next junction": "No overtaking.",
    "you must stop completely before entering the junction": "Stop. Then give way.",
  }),
);
const indexNb = new Map(
  Object.entries({
    "du har vikeplikt for all trafikk pa kryssende veg": "Vikeplikt for kryssende trafikk.",
    "vegen framover blir smalere fra begge sider": "Vegen blir smalere fra begge sider.",
    "forbikjoring er forbudt fra dette skiltet til neste kryss": "Forbikjoring forbudt.",
    "du ma stanse helt for du kjorer inn i krysset": "Stopp. Deretter vikeplikt.",
  }),
);

const subject = {
  name: { en: "Give way", nb: "Vikeplikt" },
  meaning: { en: "Give way to crossing traffic.", nb: "Vikeplikt for kryssende trafikk." },
};

const base = { itemId: "i1", kind: "meaning" as const, subject, indexEn, indexNb };

describe("rerenderSignQuestion", () => {
  it("substitutes each option in place, keeping keys and order", () => {
    const result = rerenderSignQuestion({ ...base, content: question });
    expect(result.findings).toEqual([]);
    expect(result.content!.en.options.map((o) => o.key)).toEqual(["a", "b", "c", "d"]);
    expect(result.content!.en.options[0]!.text).toBe("Give way to crossing traffic.");
    expect(result.content!.nb.options[2]!.text).toBe("Forbikjoring forbudt.");
  });

  it("keeps the correct answer in the SAME key it was in", () => {
    // Key "a" held the pictured sign's meaning before; it must hold the pictured sign's new
    // meaning after. This is the whole reason for substituting rather than regenerating.
    const result = rerenderSignQuestion({ ...base, content: question });
    expect(result.content!.en.options[0]!.text).toBe(subject.meaning.en);
  });

  it("rebuilds the explanation exactly as the seeder does", () => {
    const result = rerenderSignQuestion({ ...base, content: question });
    expect(result.content!.en.explanation).toBe("Give way — Give way to crossing traffic.");
  });

  it("REFUSES when an option maps to no sign, rather than guessing", () => {
    const orphan = JSON.parse(JSON.stringify(question)) as QuestionContent;
    orphan.en.options[1]!.text = "Some text no sign ever had";
    const result = rerenderSignQuestion({ ...base, content: orphan });
    expect(result.content).toBeNull();
    expect(result.findings).toContain("UNRESOLVED_OPTION_EN");
  });

  it("REFUSES when two shortened options collapse into the same text", () => {
    const collapsing = new Map(indexEn);
    collapsing.set("the road ahead narrows from both sides", "Give way to crossing traffic.");
    const result = rerenderSignQuestion({
      ...base,
      content: question,
      indexEn: collapsing,
    });
    expect(result.content).toBeNull();
    expect(result.findings).toContain("DUPLICATE_OPTIONS_EN");
  });
});

describe("checkClassDistinctness", () => {
  const row = (code: string, meaningEn: string) => ({
    code,
    signClass: "FARE" as const,
    meaningEn,
  });

  it("passes a class with four distinct meanings", () => {
    expect(
      checkClassDistinctness([
        row("a", "Road narrows."),
        row("b", "Slippery road."),
        row("c", "Children crossing."),
        row("d", "Falling rocks."),
      ]),
    ).toEqual([]);
  });

  it("flags a class where shortening collapsed two meanings", () => {
    const problems = checkClassDistinctness([
      row("a", "Give way."),
      row("b", "Give way."),
      row("c", "Children crossing."),
      row("d", "Falling rocks."),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.duplicates).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("flags a class left with too few distinct meanings to build a question", () => {
    // Three distinct meanings cannot furnish a right answer plus three distractors.
    const problems = checkClassDistinctness([
      row("a", "Give way."),
      row("b", "Stop."),
      row("c", "No entry."),
    ]);
    expect(problems[0]!.distinct).toBe(3);
  });
});

describe("distinctnessDelta", () => {
  const row = (code: string, meaningEn: string) => ({
    code,
    signClass: "SERVICE" as const,
    meaningEn,
  });

  it("does not block on a duplicate that already existed", () => {
    // Production really has this: XSE015 and XSE016 are both "Youth hostel" with identical
    // meanings, from the original extraction. A gate that blocked on it could never be satisfied.
    const current = [
      row("a", "Youth hostel nearby."),
      row("b", "Youth hostel nearby."),
      row("c", "Petrol station."),
      row("d", "Hospital."),
      row("e", "Camping site."),
    ];
    const proposed = [
      row("a", "Youth hostel nearby."),
      row("b", "Youth hostel nearby."),
      row("c", "Fuel."),
      row("d", "Hospital."),
      row("e", "Camping."),
    ];
    const delta = distinctnessDelta(current, proposed);
    expect(delta.introduced).toEqual([]);
    expect(delta.preExisting).toHaveLength(1);
  });

  it("blocks when the rewrite collapses two previously distinct meanings", () => {
    const current = [
      row("a", "Petrol station ahead."),
      row("b", "Electric charging point ahead."),
      row("c", "Hospital."),
      row("d", "Camping site."),
    ];
    const proposed = [
      row("a", "Fuel."),
      row("b", "Fuel."),
      row("c", "Hospital."),
      row("d", "Camping."),
    ];
    const delta = distinctnessDelta(current, proposed);
    expect(delta.introduced).toHaveLength(1);
    expect(delta.introduced[0]!.duplicates).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("blocks when the rewrite makes an already-imperfect class worse", () => {
    const current = [
      row("a", "One."),
      row("b", "One."),
      row("c", "Three."),
      row("d", "Four."),
      row("e", "Five."),
    ];
    const proposed = [
      row("a", "One."),
      row("b", "One."),
      row("c", "Three."),
      row("d", "Three."),
      row("e", "Five."),
    ];
    expect(distinctnessDelta(current, proposed).introduced).toHaveLength(1);
  });
});
