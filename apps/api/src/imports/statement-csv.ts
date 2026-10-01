import { WorkbookError, type SheetCell } from "./xlsx.js";
import { parseStatementWorkbook, type StatementWorkbook } from "./statement-xlsx.js";
import { numberConvention, parseMoneyToken } from "./decimal-text.js";
import { localizedStatementType } from "./statement-locales.js";
import { isStatementPeriodLabel } from "./period.js";

/** Preserve printed tokens for contextual accounting, locale, and period interpretation. */
export function parseStatementCsvForIngestion(text: string, fileName: string): StatementWorkbook {
  const cells: SheetCell[] = [];
  parseGrid(text).forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const trimmed = value.trim();
      if (!trimmed) return;
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

/** Reads a statement grid from CSV, TSV, or semicolon text into the same sheet shape as an .xlsx upload. */
export function parseStatementCsv(text: string, fileName: string): StatementWorkbook {
  const grid = parseGrid(text);
  const convention = numberConvention(grid.flat(), text);
  const localized =
    localizedStatementType(text) !== null ||
    numberConvention([], text) === "comma" ||
    (convention === "comma" &&
      grid.some((row) =>
        row
          .slice(1)
          .some((value) => !/^(19|20)\d{2}$/.test(value.trim()) && isStatementPeriodLabel(value)),
      ));
  const readNumber = (value: string) =>
    /^[-\u2013\u2014]$/.test(value.trim())
      ? "0"
      : localized
        ? parseMoneyToken(value, convention)
        : csvNumber(value);
  const cells: SheetCell[] = [];
  const rejectedAmounts: { raw: string; page: null }[] = [];
  grid.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      // Years belong to period headers only, never to the amount-cell rule.
      const header =
        colIndex > 0 &&
        /^(?:account(?: name)?|line(?: item)?|particulars|financial row|description)?$/i.test(
          row[0]?.trim() ?? "",
        );
      const year = header && /^(19|20)\d{2}$/.test(trimmed);
      const numeric = year ? null : readNumber(trimmed);
      // The workbook's contextual text parser must not reinterpret rejected CSV amounts.
      const rejected = !year && numeric === null && parseMoneyToken(trimmed) !== null;
      if (rejected && colIndex > 0) rejectedAmounts.push({ raw: trimmed, page: null });
      cells.push({
        row: rowIndex + 1,
        col: colIndex + 1,
        kind: numeric === null ? "string" : "number",
        text:
          numeric === null
            ? rejected
              ? `Invalid CSV amount: ${trimmed}`
              : trimmed
            : /^-?\d+$/.test(numeric)
              ? `${numeric}.0`
              : numeric,
        formula: false,
      });
    });
  });
  const parsed = parseStatementWorkbook([{ name: fileName, cells }], fileName);
  const book = parsed.layoutUnresolved
    ? displayUnresolvedGrid(grid, cells, fileName, parsed)
    : parsed;
  // Preserve the ingestion layout refusal when normalization hid ambiguous source text.
  const sourceUnresolved =
    rejectedAmounts.length > 0 &&
    parseStatementWorkbook(
      [
        {
          name: fileName,
          cells: cells.map((cell) => ({
            ...cell,
            kind: "string",
            text: grid[cell.row - 1]?.[cell.col - 1]?.trim() ?? "",
          })),
        },
      ],
      fileName,
    ).layoutUnresolved;
  // XLSX cleanup rounds binary residue; CSV decimals have no binary residue.
  // Rehydrate values from the original text after using the workbook layout detector.
  return {
    ...book,
    layoutUnresolved: book.layoutUnresolved || sourceUnresolved || convention === "conflict",
    droppedAmounts: [...book.droppedAmounts, ...rejectedAmounts],
    sheets: book.sheets.map((sheet) => ({
      ...sheet,
      lines: sheet.lines.map((line) => ({
        ...line,
        values: sheet.periods.flatMap((period) => {
          const raw = (grid[line.sheetRow - 1]?.[period.col - 1] ?? "").trim();
          const amount = readNumber(raw);
          return amount === null ? [] : [{ period: period.label, amount, raw, formula: false }];
        }),
      })),
    })),
  };
}

/** Legacy previews may display columns whose periods ingestion still requires a reviewer to resolve. */
function displayUnresolvedGrid(
  grid: string[][],
  cells: SheetCell[],
  fileName: string,
  unresolved: StatementWorkbook,
): StatementWorkbook {
  const headers = grid[0]?.slice(1).map((value) => value.trim()) ?? [];
  const repeated =
    headers.length > 1 &&
    headers.every((value) => /^(19|20)\d{2}$/.test(value)) &&
    new Set(headers).size < headers.length &&
    cells.filter((c) => c.row === 1 && c.col > 1).every((c) => c.kind === "string");
  const unlabelled =
    grid.length > 0 &&
    grid.every(
      (row, index) =>
        row.length > 1 &&
        row[0]?.trim() &&
        cells.filter((c) => c.row === index + 1 && c.col > 1).every((c) => c.kind === "number"),
    );
  if (!repeated && !unlabelled) return unresolved;
  const offset = repeated ? 0 : 1;
  const columns = [...new Set(cells.filter((c) => c.col > 1).map((c) => c.col))].sort(
    (a, b) => a - b,
  );
  const previews = columns.map((col) => {
    const columnCells: SheetCell[] = [
      { row: 1, col: 2, kind: "string", text: "This Year", formula: false },
      ...cells
        .filter((c) => c.row > (repeated ? 1 : 0) && (c.col === 1 || c.col === col))
        .map((c) => ({ ...c, row: c.row + offset, col: c.col === 1 ? 1 : 2 })),
    ];
    return parseStatementWorkbook([{ name: fileName, cells: columnCells }], fileName).sheets[0];
  });
  const first = previews[0];
  if (!first || previews.some((sheet) => !sheet)) return unresolved;
  return {
    ...unresolved,
    sheets: [
      {
        ...first,
        periods: columns.map((col) => ({
          col,
          label: repeated ? headers[col - 2]! : `Column ${col}`,
          derived: false,
        })),
        lines: first.lines.map((line) => ({ ...line, sheetRow: line.sheetRow - offset })),
        skippedCells: previews.reduce((sum, sheet) => sum + (sheet?.skippedCells ?? 0), 0),
      },
    ],
  };
}

function csvNumber(value: string): string | null {
  const parsed = parseAmount(value, { decimal: "auto" });
  return parsed.ok ? amountDecimal(parsed) : null;
}

export function parseGrid(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === delimiter || char === "\r" || char === "\n") {
      row.push(cell);
      cell = "";
      closed = false;
      if (char !== delimiter) {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        if (row.some((value) => value.trim().length > 0)) rows.push(row);
        row = [];
      }
    } else if (char === '"' && cell.length === 0 && !closed) quoted = true;
    else {
      if (closed || char === '"')
        throw new WorkbookError("Malformed CSV quoting; review the source file.");
      cell += char;
    }
  }
  if (quoted) throw new WorkbookError("Unclosed CSV quote; review the source file.");
  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  let lines = 0;
  for (let index = 0; index < text.length && lines < 100; index += 1) {
    const char = text[index] ?? "";
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) lines += 1;
      if (counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  // Bank exports can have title rows and unquoted decimal commas.
  if (counts.get("\t")) return "\t";
  if (counts.get(";")) return ";";
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}

type AmountResult = { ok: true; minor: string; scale: number } | { ok: false; reason: string };

/** decimal-text-v1. CR is positive, DR is negative; conflicting sign markers require review. */
function parseAmount(text: string, options: { decimal: "." | "," | "auto" }): AmountResult {
  let body = text.trim();
  let negative = false;
  let signs = 0;
  const invalid = (reason: string): AmountResult => ({ ok: false, reason });
  const suffix = /\s*(CR|DR)$/i.exec(body);
  if (suffix) {
    negative = suffix[1]?.toUpperCase() === "DR";
    signs += 1;
    body = body.slice(0, suffix.index).trim();
  }
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    signs += 1;
    body = body.slice(1, -1).trim();
  }
  const stripSign = () => {
    if (body.startsWith("-")) {
      signs += 1;
      negative = true;
      body = body.slice(1).trim();
    }
    if (body.endsWith("-")) {
      signs += 1;
      negative = true;
      body = body.slice(0, -1).trim();
    }
  };
  stripSign();
  body = body.replace(/^(?:\p{Sc}|[A-Z]{3})\s*/u, "");
  stripSign();
  if (signs > 1) return invalid("Conflicting sign markers");
  if (!/^\d[\d.,]*$/.test(body)) return invalid("Invalid amount syntax");
  let decimal: "." | "," | null = options.decimal === "auto" ? null : options.decimal;
  if (options.decimal === "auto") {
    if (body.includes(".") && body.includes(",")) {
      decimal = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    } else if (body.includes(".")) {
      if ((body.match(/\./g) ?? []).length === 1) {
        if (body.split(".")[1]?.length === 3)
          return invalid("Ambiguous decimal or thousands separator");
        decimal = ".";
      }
    } else if ((body.match(/,/g) ?? []).length === 1) {
      return invalid("Ambiguous decimal or thousands separator");
    }
  }
  const parts = decimal ? body.split(decimal) : [body];
  if (parts.length > 2) return invalid("Multiple decimal separators");
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (parts.length === 2 && !/^\d+$/.test(fraction)) return invalid("Invalid fractional digits");
  const group = decimal === "," ? "." : decimal === "." ? "," : body.includes(",") ? "," : ".";
  const groups = whole.split(group);
  if (groups.length > 1) {
    const western =
      /^\d{1,3}$/.test(groups[0] ?? "") && groups.slice(1).every((part) => /^\d{3}$/.test(part));
    const indian =
      /^\d{1,2}$/.test(groups[0] ?? "") &&
      /^\d{3}$/.test(groups.at(-1) ?? "") &&
      groups.slice(1, -1).every((part) => /^\d{2}$/.test(part));
    if (!western && !indian) return invalid("Invalid thousands grouping");
  }
  const digits = groups.join("");
  if (!/^\d+$/.test(digits)) return invalid("Invalid integer digits");
  const minor = BigInt(digits + fraction) * (negative ? -1n : 1n);
  return { ok: true, minor: minor.toString(), scale: fraction.length };
}

/** Exact decimal string for submission, preserving the source scale. */
function amountDecimal(amount: Extract<AmountResult, { ok: true }>): string {
  const negative = amount.minor.startsWith("-");
  const digits = (negative ? amount.minor.slice(1) : amount.minor).padStart(amount.scale + 1, "0");
  return `${negative ? "-" : ""}${amount.scale ? `${digits.slice(0, -amount.scale)}.${digits.slice(-amount.scale)}` : digits}`;
}
