import { excelNumberToDecimal, trimBinaryNoise } from "./decimal-text.js";
import type { SheetCell, Worksheet } from "./xlsx.js";

export type StatementType = "income_statement" | "balance_sheet" | "cash_flow" | "equity";

export interface StatementPeriod {
  readonly col: number;
  /** ISO date when the header cell is an Excel date serial; otherwise the header text as written. */
  readonly label: string;
  /** Every value in the column is a formula while other columns hold typed values, as in a year-total column. */
  readonly derived: boolean;
}

export interface StatementLine {
  readonly sheetRow: number;
  readonly label: string;
  readonly kind: "heading" | "line" | "total";
  readonly values: readonly {
    readonly period: string;
    readonly amount: string;
    readonly raw: string;
    readonly formula: boolean;
  }[];
}

export interface StatementSheet {
  readonly sheetName: string;
  readonly statementType: StatementType;
  readonly periods: readonly StatementPeriod[];
  readonly lines: readonly StatementLine[];
  readonly skippedRows: number;
  readonly skippedCells: number;
}

export interface StatementWorkbook {
  readonly sheets: readonly StatementSheet[];
  readonly skippedSheets: readonly { readonly sheetName: string; readonly reason: string }[];
}

/** Excel's 1900 date system counts days from 1899-12-30. Serials in this range read as 1954–2119. */
const SERIAL_MIN = 20_000;
const SERIAL_MAX = 80_000;
const MAX_HEADER_SCAN_ROWS = 25;

export function parseStatementWorkbook(
  sheets: readonly Worksheet[],
  fileName: string,
): StatementWorkbook {
  const parsed: StatementSheet[] = [];
  const skippedSheets: { sheetName: string; reason: string }[] = [];
  for (const sheet of sheets) {
    const outcome = parseStatementSheet(sheet, fileName);
    if ("reason" in outcome) skippedSheets.push({ sheetName: sheet.name, reason: outcome.reason });
    else parsed.push(outcome);
  }
  return { sheets: parsed, skippedSheets };
}

export function parseStatementSheet(
  sheet: Worksheet,
  fileName: string,
): StatementSheet | { reason: string } {
  const rows = new Map<number, SheetCell[]>();
  for (const cell of sheet.cells) {
    const list = rows.get(cell.row) ?? [];
    list.push(cell);
    rows.set(cell.row, list);
  }
  const rowNumbers = [...rows.keys()].sort((a, b) => a - b);

  let headerRow: number | null = null;
  let periods: StatementPeriod[] = [];
  for (const rowNo of rowNumbers.slice(0, MAX_HEADER_SCAN_ROWS)) {
    const candidates = (rows.get(rowNo) ?? []).filter(
      (cell) => cell.col >= 2 && !(cell.kind === "string" && cell.text.trim().length === 0),
    );
    const read = candidates.map(periodLabel);
    if (read.length >= 2 && read.every((label) => label !== null)) {
      headerRow = rowNo;
      periods = candidates.map((cell, index) => ({
        col: cell.col,
        label: read[index] ?? "",
        derived: false,
      }));
      break;
    }
  }
  if (headerRow === null) {
    periods = unlabeledPeriods(rows);
    if (periods.length === 0 || classify(fileName, sheet.name, []) === null) {
      return {
        reason: "No header row of period dates or period labels was found in the first 25 rows",
      };
    }
    headerRow = 0;
  }
  const firstPeriodCol = Math.min(...periods.map((period) => period.col));
  const periodByCol = new Map(periods.map((period) => [period.col, period.label]));

  const lines: StatementLine[] = [];
  let skippedRows = 0;
  let skippedCells = 0;
  for (const rowNo of rowNumbers) {
    if (rowNo <= headerRow) continue;
    const cells = rows.get(rowNo) ?? [];
    const label = cells
      .filter((cell) => cell.col < firstPeriodCol && cell.kind === "string")
      .sort((a, b) => a.col - b.col)
      .map((cell) => cell.text.trim())
      .filter((text) => text.length > 0)
      .join(" ");
    const values: { period: string; amount: string; raw: string; formula: boolean }[] = [];
    for (const cell of cells) {
      const period = periodByCol.get(cell.col);
      if (period === undefined) continue;
      if (cell.kind === "string" && cell.text.trim().length === 0) continue;
      const displayed = cell.kind === "number" ? excelNumberToDecimal(cell.text) : null;
      const amount = displayed === null ? null : trimBinaryNoise(displayed);
      if (amount === null) {
        skippedCells += 1;
        continue;
      }
      values.push({ period, amount, raw: cell.text, formula: cell.formula });
    }
    if (label.length === 0) {
      if (values.length > 0) skippedRows += 1;
      continue;
    }
    const kind = values.length === 0 ? "heading" : /^total\b/i.test(label) ? "total" : "line";
    lines.push({ sheetRow: rowNo, label, kind, values });
  }

  if (!lines.some((line) => line.values.length > 0)) {
    return { reason: "The sheet has a period header but no labeled rows with numeric values" };
  }
  const statementType = classify(fileName, sheet.name, lines);
  if (statementType === null) {
    return {
      reason: "Could not tell whether this sheet is an income statement or a balance sheet",
    };
  }
  return {
    sheetName: sheet.name,
    statementType,
    periods: markDerived(periods, lines),
    lines,
    skippedRows,
    skippedCells,
  };
}

function markDerived(
  periods: readonly StatementPeriod[],
  lines: readonly StatementLine[],
): StatementPeriod[] {
  const allFormula = new Map<string, boolean>();
  for (const line of lines) {
    if (line.kind !== "line") continue;
    for (const value of line.values) {
      allFormula.set(value.period, (allFormula.get(value.period) ?? true) && value.formula);
    }
  }
  const typedColumns = periods.filter((period) => allFormula.get(period.label) === false).length;
  return periods.map((period) => ({
    ...period,
    derived: typedColumns > 0 && allFormula.get(period.label) === true,
  }));
}

function unlabeledPeriods(rows: ReadonlyMap<number, SheetCell[]>): StatementPeriod[] {
  const cols = new Set<number>();
  for (const cells of rows.values()) {
    for (const cell of cells) {
      if (cell.col >= 2 && cell.kind === "number") cols.add(cell.col);
    }
  }
  return [...cols]
    .sort((a, b) => a - b)
    .map((col) => ({ col, label: `Column ${col}`, derived: false }));
}

function periodLabel(cell: SheetCell): string | null {
  if (cell.kind === "number" && /^\d+$/.test(cell.text)) {
    const serial = Number.parseInt(cell.text, 10);
    if (serial < SERIAL_MIN || serial > SERIAL_MAX) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  if (cell.kind === "string") {
    const text = cell.text.replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.length > 48) return null;
    if (/^(current month|year to date)( (this year|last year))?$/i.test(text)) return text;
    if (/^(this year|last year|ytd)$/i.test(text)) return text;
    if (/^(19|20)\d{2}$/.test(text)) return text;
    if (/^[A-Za-z]+ \d{1,2}, \d{4}$/.test(text)) return text;
    if (
      /^(FY|Q[1-4]|H[12]|[A-Za-z]{3,9})?[\s\-/]*('?\d{2}|\d{4})([\s\-/]*(Q[1-4]|[A-Za-z]{3,9}|\d{1,2}))?$/i.test(
        text,
      ) &&
      /\d/.test(text)
    )
      return text;
    if (/^total$/i.test(text)) return text;
  }
  return null;
}

const INCOME_NAME = /income|\bIS\b|p\s*&\s*l|profit|\bpnl\b|operations/i;
const BALANCE_NAME = /balance|\bBS\b|financial position/i;
const INCOME_LABELS = /gross profit|net income|total income|revenue|cost of goods|net ordinary/i;
const BALANCE_LABELS = /total assets|total liabilities|\bequity\b|current assets/i;

function classify(
  fileName: string,
  sheetName: string,
  lines: readonly StatementLine[],
): StatementType | null {
  for (const name of [sheetName, fileName]) {
    const income = INCOME_NAME.test(name);
    const balance = BALANCE_NAME.test(name);
    if (income && !balance) return "income_statement";
    if (balance && !income) return "balance_sheet";
  }
  const incomeHits = lines.filter((line) => INCOME_LABELS.test(line.label)).length;
  const balanceHits = lines.filter((line) => BALANCE_LABELS.test(line.label)).length;
  if (incomeHits > 0 && balanceHits === 0) return "income_statement";
  if (balanceHits > 0 && incomeHits === 0) return "balance_sheet";
  return null;
}
