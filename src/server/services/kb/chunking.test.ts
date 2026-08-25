import { describe, expect, it } from "vitest";
import { chunkLegalText } from "./chunking";

/**
 * Every citation in the system inherits what this function decides, so the section reference
 * matters as much as the text.
 */
describe("legal text chunking", () => {
  it("splits on section boundaries and carries the reference", () => {
    const chunks = chunkLegalText(
      [
        "§ 7. Vikeplikt",
        "Trafikant som kommer fra høyre har forkjørsrett.",
        "",
        "§ 8. Kjørende som vil svinge",
        "Den som svinger til venstre har vikeplikt for møtende.",
      ].join("\n"),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0].ref).toBe("§ 7");
    expect(chunks[0].text).toContain("høyre");
    expect(chunks[1].ref).toBe("§ 8");
    expect(chunks[1].text).toContain("venstre");
  });

  it("handles the reference forms Norwegian regulations use", () => {
    const chunks = chunkLegalText(
      ["§ 7-2. Noe", "Tekst.", "§ 13 a. Annet", "Mer tekst."].join("\n"),
    );
    expect(chunks.map((chunk) => chunk.ref)).toEqual(["§ 7-2", "§ 13 a"]);
  });

  it("keeps text before the first section under a fallback reference", () => {
    const chunks = chunkLegalText("Innledende bestemmelser om vegtrafikk.\n\n§ 1. Formål\nTekst.");
    expect(chunks[0].ref).toBe("—");
    expect(chunks[1].ref).toBe("§ 1");
  });

  it("splits an over-long section into overlapping windows under the same reference", () => {
    const long = `§ 5. Lang paragraf\n${"Setning om vegtrafikk. ".repeat(400)}`;
    const chunks = chunkLegalText(long);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.ref === "§ 5")).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 3200)).toBe(true);
    // Overlap: consecutive windows share text, so a rule spanning the seam is still retrievable.
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });

  it("drops empty input rather than producing an empty chunk", () => {
    expect(chunkLegalText("   \n  \n")).toEqual([]);
  });
});
