import { describe, expect, it } from "vitest";
import { expandTemplate, type TemplateContent } from "./template";

const template: TemplateContent = {
  en: {
    stem: "You drive at {{speed}} km/h where the limit is {{limit}} km/h. {{actor}} crosses. What applies?",
    options: [
      { key: "a", text: "You must yield to {{actor}}" },
      { key: "b", text: "You may continue at {{speed}} km/h" },
      { key: "c", text: "Sound the horn" },
    ],
    explanation: "The limit is {{limit}} km/h and you must yield to {{actor}}.",
  },
  nb: {
    stem: "Du kjører i {{speed}} km/t der grensen er {{limit}} km/t. {{actor}} krysser. Hva gjelder?",
    options: [
      { key: "a", text: "Du må vike for {{actor}}" },
      { key: "b", text: "Du kan fortsette i {{speed}} km/t" },
      { key: "c", text: "Bruk hornet" },
    ],
    explanation: "Grensen er {{limit}} km/t og du må vike for {{actor}}.",
  },
};

const slots = {
  slots: {
    speed: { kind: "number" as const, values: [40, 50, 60] },
    limit: { kind: "fact" as const, factKey: "speed_default_urban" },
    actor: {
      kind: "choice" as const,
      values: [
        { en: "a pedestrian", nb: "en fotgjenger" },
        { en: "a cyclist", nb: "en syklist" },
      ],
    },
  },
  constraints: [],
};

const facts = { speed_default_urban: "50" };

describe("template expansion", () => {
  it("expands the cartesian product deterministically, both locales rendered", () => {
    const first = expandTemplate({ template, parameterSlots: slots, facts });
    const second = expandTemplate({ template, parameterSlots: slots, facts });
    expect(first.variants.length).toBe(3 * 1 * 2); // speed × fact-pinned limit × actor
    expect(first.variants.map((v) => v.bindings)).toEqual(
      second.variants.map((v) => v.bindings),
    );
    const v = first.variants[0];
    expect(v.content.en.stem).not.toContain("{{");
    expect(v.content.nb.stem).not.toContain("{{");
    expect(v.content.nb.options[0].text).toContain("en fotgjenger");
    expect(v.explanation.en).toContain("50 km/h");
  });

  it("fact slots are pinned to the facts table value (never enumerated)", () => {
    const { variants } = expandTemplate({ template, parameterSlots: slots, facts });
    for (const v of variants) {
      expect(v.bindings.limit).toBe("50");
      expect(v.content.en.stem).toContain("limit is 50 km/h");
    }
  });

  it("throws on unknown fact keys — legal ground truth is mandatory", () => {
    expect(() =>
      expandTemplate({ template, parameterSlots: slots, facts: {} }),
    ).toThrow(/speed_default_urban/);
  });

  it("distinct constraint filters colliding combos", () => {
    const constrained = {
      slots: {
        a: { kind: "number" as const, values: [50, 60] },
        b: { kind: "number" as const, values: [50, 60] },
      },
      constraints: [{ type: "distinct" as const, slots: ["a", "b"] }],
    };
    const tpl: TemplateContent = {
      en: {
        stem: "{{a}} vs {{b}}",
        options: [
          { key: "a", text: "First {{a}}" },
          { key: "b", text: "Second {{b}}" },
        ],
        explanation: "x",
      },
      nb: {
        stem: "{{a}} mot {{b}}",
        options: [
          { key: "a", text: "Første {{a}}" },
          { key: "b", text: "Andre {{b}}" },
        ],
        explanation: "x",
      },
    };
    const { variants } = expandTemplate({
      template: tpl,
      parameterSlots: constrained,
      facts: {},
    });
    expect(variants).toHaveLength(2); // (50,60) and (60,50) only
    for (const v of variants) {
      expect(v.bindings.a).not.toBe(v.bindings.b);
    }
  });

  it("rejects combos that produce duplicate option texts (expansion validator)", () => {
    const tpl: TemplateContent = {
      en: {
        stem: "Limit?",
        options: [
          { key: "a", text: "{{x}} km/h" },
          { key: "b", text: "50 km/h" },
        ],
        explanation: "x",
      },
      nb: {
        stem: "Grense?",
        options: [
          { key: "a", text: "{{x}} km/t" },
          { key: "b", text: "50 km/t" },
        ],
        explanation: "x",
      },
    };
    const { variants, issues } = expandTemplate({
      template: tpl,
      parameterSlots: {
        slots: { x: { kind: "number", values: [50, 60] } },
        constraints: [],
      },
      facts: {},
    });
    expect(variants).toHaveLength(1); // x=50 collides with the static "50 km/h" option
    expect(issues.some((i) => i.reason.includes("duplicate option texts"))).toBe(true);
  });

  it("rejects templates with unresolved placeholders", () => {
    const tpl: TemplateContent = {
      en: {
        stem: "What about {{missing}}?",
        options: [
          { key: "a", text: "A" },
          { key: "b", text: "B" },
        ],
        explanation: "x",
      },
      nb: {
        stem: "Hva med {{missing}}?",
        options: [
          { key: "a", text: "A" },
          { key: "b", text: "B" },
        ],
        explanation: "x",
      },
    };
    const { variants, issues } = expandTemplate({
      template: tpl,
      parameterSlots: null,
      facts: {},
    });
    expect(variants).toHaveLength(0);
    expect(issues[0].reason).toContain("unresolved placeholder");
  });

  it("static templates (no slots) expand to exactly one variant", () => {
    const { variants } = expandTemplate({
      template,
      parameterSlots: null,
      facts: {},
    });
    expect(variants).toHaveLength(0); // template HAS placeholders → all rejected
    const staticTpl: TemplateContent = {
      en: { stem: "S", options: [{ key: "a", text: "A" }, { key: "b", text: "B" }], explanation: "e" },
      nb: { stem: "S", options: [{ key: "a", text: "A" }, { key: "b", text: "B" }], explanation: "e" },
    };
    expect(
      expandTemplate({ template: staticTpl, parameterSlots: null, facts: {} })
        .variants,
    ).toHaveLength(1);
  });
});
