import { describe, expect, it } from "vitest";
import { hashUnit } from "@/server/services/i18n/units";
import { bookUnit, documentUnits, sectionEntityId } from "./overlay";

const doc = {
  id: "d1",
  title: { en: "Right of way", nb: "Vikeplikt" },
  summary: { en: "Who goes first", nb: "Hvem kjører først" },
  body: {
    en: "Intro.\n\n## Rule\n\nYield right (§ 7).\n\n## Signs\n\nSign 206.\n",
    nb: "Innledning.\n\n## Regel\n\nVik til høyre (§ 7).\n\n## Skilt\n\nSkilt 206.\n",
  },
};

describe("Learn translation units", () => {
  it("emits one document unit and one section unit per H2 block, aligned across languages", () => {
    const units = documentUnits(doc, 1);
    expect(units.map((u) => [u.entity, u.entityId])).toEqual([
      ["LEARN_DOCUMENT", "d1"],
      ["LEARN_SECTION", sectionEntityId("d1", 0)],
      ["LEARN_SECTION", sectionEntityId("d1", 1)],
      ["LEARN_SECTION", sectionEntityId("d1", 2)],
    ]);
    expect(units[0]!.en).toEqual({ title: "Right of way", summary: "Who goes first" });
    expect(units[0]!.nb).toEqual({ title: "Vikeplikt", summary: "Hvem kjører først" });
    expect((units[2]!.en as { text: string }).text).toContain("## Rule");
    expect((units[2]!.nb as { text: string }).text).toContain("## Regel");
    expect(units[2]!.label).toBe("Right of way · §2 Rule");
  });

  it("drops the Norwegian side when the two bodies have different skeletons", () => {
    const units = documentUnits({ ...doc, body: { en: doc.body.en, nb: "## Bare en\n\ntekst\n" } }, 1);
    expect(units.filter((u) => u.entity === "LEARN_SECTION").every((u) => u.nb === undefined)).toBe(true);
  });

  it("hashes exactly what the resolver will compare, so a changed section changes only its own hash", () => {
    const before = documentUnits(doc, 1);
    const after = documentUnits({ ...doc, body: { ...doc.body, en: doc.body.en.replace("Sign 206.", "Sign 206 and 208.") } }, 1);
    expect(after[1]!.sourceHash).toBe(before[1]!.sourceHash);
    expect(after[2]!.sourceHash).toBe(before[2]!.sourceHash);
    expect(after[3]!.sourceHash).not.toBe(before[3]!.sourceHash);
    expect(after[0]!.sourceHash).toBe(before[0]!.sourceHash);
    expect(before[3]!.sourceHash).toBe(hashUnit({ entity: "LEARN_SECTION", en: before[3]!.en, nb: before[3]!.nb }, 1));
  });

  it("a glossary bump moves every hash", () => {
    expect(bookUnit({ id: "b", title: { en: "T", nb: "T" }, description: null }, 1).sourceHash).not.toBe(
      bookUnit({ id: "b", title: { en: "T", nb: "T" }, description: null }, 2).sourceHash,
    );
  });
});
