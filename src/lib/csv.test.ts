import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseCsvRecords } from "./csv";

describe("CSV parsing", () => {
  it("parses a plain comma file", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields, embedded separators, newlines and escaped quotes", () => {
    const csv =
      'name,note\n"Nordmann, Kari","line1\nline2"\n"He said ""hi""",x';
    expect(parseCsv(csv)).toEqual([
      ["name", "note"],
      ["Nordmann, Kari", "line1\nline2"],
      ['He said "hi"', "x"],
    ]);
  });

  it("accepts CRLF line endings and a UTF-8 BOM", () => {
    expect(parseCsv("﻿email,firstName\r\nkari@example.no,Kari\r\n")).toEqual([
      ["email", "firstName"],
      ["kari@example.no", "Kari"],
    ]);
  });

  it("detects the semicolon dialect Norwegian Excel writes", () => {
    expect(detectDelimiter("email;firstName;lastName\n")).toBe(";");
    expect(parseCsv("email;firstName\nkari@example.no;Kari")).toEqual([
      ["email", "firstName"],
      ["kari@example.no", "Kari"],
    ]);
  });

  it("drops blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toHaveLength(2);
  });

  it("maps records by normalised header names", () => {
    const records = parseCsvRecords(
      "E-mail, First Name ,Last name\nkari@example.no, Kari , Nordmann ",
    );
    expect(records).toEqual([
      { email: "kari@example.no", firstname: "Kari", lastname: "Nordmann" },
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsvRecords("")).toEqual([]);
    expect(parseCsvRecords("   \n")).toEqual([]);
  });

  it("keeps æøå intact", () => {
    expect(
      parseCsvRecords("email,firstName\nase@example.no,Åse Øystein"),
    ).toEqual([{ email: "ase@example.no", firstname: "Åse Øystein" }]);
  });
});
