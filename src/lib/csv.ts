/**
 * Minimal RFC-4180 CSV reader (spec-03 student import). No dependency: the import path
 * needs quoting, embedded newlines and Excel's semicolon dialect — nothing more.
 *
 * Norwegian Excel exports with a comma decimal separator use ";" as the field delimiter,
 * so the delimiter is detected from the header line instead of assumed.
 */

export function detectDelimiter(input: string): "," | ";" | "\t" {
  const headerLine = input.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts = {
    ",": (headerLine.match(/,/g) ?? []).length,
    ";": (headerLine.match(/;/g) ?? []).length,
    "\t": (headerLine.match(/\t/g) ?? []).length,
  };
  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? (best[0] as "," | ";" | "\t") : ",";
}

/** Parses CSV text into rows of raw cell strings. Empty trailing lines are dropped. */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((value) => value.trim().length > 0));
}

/**
 * Parses CSV with a header row into records keyed by normalised header name
 * (lowercased, non-alphanumerics stripped: "First Name" → "firstname").
 */
export function parseCsvRecords(input: string): Record<string, string>[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ""),
  );
  return rows
    .slice(1)
    .map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header, (row[index] ?? "").trim()]),
      ),
    );
}

/**
 * Serialises rows to RFC-4180 CSV. Quotes a field only when it needs it (separator, quote,
 * newline or leading/trailing space), so hand-edited exports stay readable.
 */
export function toCsv(
  rows: Array<Record<string, string | number | null | undefined>>,
  headers?: string[],
  delimiter = ",",
): string {
  const columns = headers ?? [
    ...new Set(rows.flatMap((row) => Object.keys(row))),
  ];
  const escape = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /["\n\r]|^\s|\s$/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };

  return [
    columns.join(delimiter),
    ...rows.map((row) =>
      columns.map((column) => escape(row[column])).join(delimiter),
    ),
  ].join("\r\n");
}
