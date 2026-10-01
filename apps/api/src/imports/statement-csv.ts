import type { SheetCell } from "./xlsx.js";
import { parseStatementWorkbook, type StatementWorkbook } from "./statement-xlsx.js";

/** Reads a statement grid from CSV, TSV, or semicolon text into the same sheet shape as an .xlsx upload. */
export function parseStatementCsv(text: string, fileName: string): StatementWorkbook {
  const grid = parseGrid(text.replace(/^\uFEFF/, ""));
  const cells: SheetCell[] = [];
  grid.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      cells.push({
        row: rowIndex + 1,
        col: colIndex + 1,
        kind: "string",
        text: trimmed,
        formula: false,
      });
    });
  });
  return parseStatementWorkbook([{ name: fileName, cells }], fileName);
}

export function parseGrid(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const sample = text
    .replace(/"(?:[^"]|"")*"/g, "")
    .split(/\r?\n/)
    .slice(0, 100)
    .join("\n");
  if (sample.includes("\t")) return "\t";
  if (sample.includes(";")) return ";";
  const counts = [
    { mark: ",", count: sample.split(",").length },
    { mark: ";", count: sample.split(";").length },
    { mark: "\t", count: sample.split("\t").length },
  ];
  counts.sort((a, b) => b.count - a.count);
  return counts[0]?.mark ?? ",";
}
