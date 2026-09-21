import { describe, expect, it, vi } from "vitest";
import enMessages from "@/i18n/messages/en.json";
import { QualityWarnings } from "./quality-warnings";
import type { QualityIssue } from "@/server/services/question-bank/validation";

// next-intl's server helper, rendering from the real en.json so a missing key or a wrong ICU
// argument fails here rather than in production.
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => {
    const table = namespace
      .split(".")
      .reduce<Record<string, unknown>>(
        (node, key) => node[key] as Record<string, unknown>,
        enMessages as unknown as Record<string, unknown>,
      );
    return (key: string, values?: Record<string, string | number>) => {
      const template = table[key];
      if (typeof template !== "string") throw new Error(`missing key: ${key}`);
      return template.replace(/\{(\w+)\}/g, (_m, name) => {
        if (!values || !(name in values)) throw new Error(`missing arg ${name} for ${key}`);
        return String(values[name]);
      });
    };
  },
}));

function texts(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  const props = (node as { props?: { children?: unknown } }).props;
  if (props && "children" in props) texts(props.children, out);
  return out;
}

describe("QualityWarnings", () => {
  it("renders nothing when the gate is clean", async () => {
    expect(await QualityWarnings({ issues: [] })).toBeNull();
  });

  it("renders a brevity warning with its real numbers substituted", async () => {
    const issues: QualityIssue[] = [
      {
        code: "STEM_LONG",
        messageKey: "admin.quality.stemLong",
        locale: "en",
        values: { actual: 19, max: 15 },
      },
    ];
    const joined = texts(await QualityWarnings({ issues })).join(" ");
    expect(joined).toContain("19");
    expect(joined).toContain("15");
    expect(joined).toContain("words long");
    expect(joined).toContain("en");
  });

  it("renders every brevity key the gate can emit — catches a missing i18n key", async () => {
    const issues: QualityIssue[] = [
      { code: "STEM_LONG", messageKey: "admin.quality.stemLong", values: { actual: 19, max: 15 } },
      { code: "OPTION_LONG", messageKey: "admin.quality.optionLong", values: { actual: 12, max: 8 }, detail: "a long option" },
      { code: "EXPLANATION_LONG", messageKey: "admin.quality.explanationLong", values: { actual: 40, max: 24 } },
      { code: "EXPLANATION_SENTENCES", messageKey: "admin.quality.explanationSentences", values: { actual: 4, max: 2 } },
      { code: "STEM_RUNAWAY", messageKey: "admin.quality.stemRunaway" },
      { code: "LENGTH_TELL", messageKey: "admin.quality.lengthTell" },
    ];
    const joined = texts(await QualityWarnings({ issues })).join(" ");
    expect(joined).toContain("a long option");
    expect(joined).not.toContain("{");
  });
});
