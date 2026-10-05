import {
  AnalyticalDecimal,
  canonicalAccount,
  mapLineLabel,
  mappingIsAutoAcceptable,
} from "@nexora/kernel";

import {
  excelNumberToDecimal,
  parseMoneyToken,
  numberConvention,
  type NumberConvention,
} from "./decimal-text.js";
import {
  datedRangePhrase,
  explicitYearEnd,
  parseLooseDate,
  isStatementPeriodLabel,
  isReportRunLine,
} from "./period.js";
import type { SheetCell, Worksheet } from "./xlsx.js";
import { annotationHeader, localizedStatementType, nonPeriodHeader } from "./statement-locales.js";
import { parseStatementBlocks } from "./statement-blocks.js";

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
    readonly col?: number;
    readonly location?: {
      readonly page: number;
      readonly bbox: {
        readonly x0: number;
        readonly y0: number;
        readonly x1: number;
        readonly y1: number;
      };
    };
  }[];
}

export interface StatementSheet {
  readonly sourceText?: string;
  readonly explicitType?: boolean;
  readonly periodContext?: string;
  readonly sheetName: string;
  readonly statementType: StatementType;
  readonly periods: readonly StatementPeriod[];
  readonly lines: readonly StatementLine[];
  readonly skippedRows: number;
  readonly skippedCells: number;
  readonly droppedAmounts: readonly DroppedAmount[];
}

export interface DroppedAmount {
  readonly raw: string;
  readonly page: number | null;
}

export interface StatementWorkbook {
  readonly sheets: readonly StatementSheet[];
  readonly skippedSheets: readonly { readonly sheetName: string; readonly reason: string }[];
  readonly droppedAmounts: readonly DroppedAmount[];
  readonly layoutUnresolved: boolean;
}

/** Excel's 1900 date system counts days from 1899-12-30. Serials in this range read as 1954–2119. */
const SERIAL_MIN = 20_000;
const SERIAL_MAX = 80_000;
const MAX_HEADER_SCAN_ROWS = 100;

export function parseStatementWorkbook(
  sheets: readonly Worksheet[],
  fileName: string,
): StatementWorkbook {
  const parsed: StatementSheet[] = [];
  const skippedSheets: { sheetName: string; reason: string }[] = [];
  const droppedAmounts: DroppedAmount[] = [];
  let layoutUnresolved = false;
  for (const sheet of sheets) {
    const blocks = parseStatementBlocks(sheet, parseStatementSheet);
    if (blocks && !("reason" in blocks)) {
      parsed.push(...blocks);
      droppedAmounts.push(...blocks.flatMap((s) => s.droppedAmounts));
      continue;
    }
    if (blocks && "reason" in blocks) {
      layoutUnresolved = true;
      skippedSheets.push({ sheetName: sheet.name, reason: blocks.reason });
      continue;
    }
    const outcome = parseStatementSheet(sheet, fileName);
    if ("reason" in outcome) {
      if (outcome.reason === "layout_unresolved") layoutUnresolved = true;
      skippedSheets.push({ sheetName: sheet.name, reason: outcome.reason });
      if ("droppedAmounts" in outcome) droppedAmounts.push(...outcome.droppedAmounts);
    } else {
      parsed.push(outcome);
      droppedAmounts.push(...outcome.droppedAmounts);
    }
  }
  if (layoutUnresolved) {
    return { sheets: [], skippedSheets, droppedAmounts, layoutUnresolved: true };
  }
  return { sheets: parsed, skippedSheets, droppedAmounts, layoutUnresolved: false };
}

export function parseStatementSheet(
  sheet: Worksheet,
  fileName: string,
): StatementSheet | { reason: string; droppedAmounts?: readonly DroppedAmount[] } {
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
    const row = rows.get(rowNo) ?? [];
    if (isReportRunLine(row.map((c) => c.text).join(" "))) continue;
    const candidates = (rows.get(rowNo) ?? [])
      .map((cell) => {
        if (cell.kind !== "string") return cell;
        const below = rows.get(rowNo + 1)?.find((c) => c.col === cell.col)?.text ?? "";
        const combined = `${cell.text.trim()} ${below.trim()}`;
        return /^(?:\d{4}年|Year ended)$/i.test(cell.text.trim()) &&
          isStatementPeriodLabel(combined)
          ? { ...cell, text: combined }
          : cell;
      })
      .filter(
        (cell) => cell.col >= 2 && !(cell.kind === "string" && cell.text.trim().length === 0),
      );
    if (candidates.length === 0) continue;
    const periodCells = candidates.filter((cell) => headerRole(cell) === "period");
    if (periodCells.length === 0) continue;
    if (
      periodCells.every((cell) => {
        const merge = sheet.merges?.find((m) => m.row === cell.row && m.col === cell.col);
        return !sheet.cells.some(
          (c) =>
            c.row > (merge?.endRow ?? cell.row) &&
            c.col >= cell.col &&
            c.col <= (merge?.endCol ?? cell.col) &&
            (c.kind === "number" ? excelNumberToDecimal(c.text) : parseMoneyToken(c.text)) !== null,
        );
      })
    )
      continue;
    const nextNo = rowNumbers.find((candidate) => candidate > rowNo);
    const nextPeriods =
      nextNo === undefined
        ? []
        : (rows.get(nextNo) ?? []).filter((cell) => cell.col >= 2 && headerRole(cell) === "period");
    const nextLabel = nextNo === undefined ? undefined : rows.get(nextNo)?.find((c) => c.col === 1);
    const useNext =
      nextPeriods.length > periodCells.length ||
      (nextPeriods.length === periodCells.length &&
        (!nextLabel || headerRole(nextLabel) === "label"));
    const chosen = useNext ? nextPeriods : periodCells;
    headerRow = useNext && nextNo !== undefined ? nextNo : rowNo;
    const following = rowNumbers.find((candidate) => headerRow !== null && candidate > headerRow);
    const preceding = [...rowNumbers]
      .reverse()
      .find((candidate) => headerRow !== null && candidate < headerRow);
    const below = following === undefined ? undefined : rows.get(following);
    const above = preceding === undefined ? undefined : rows.get(preceding);
    periods = chosen
      .filter(
        (cell) =>
          ![
            cell.text,
            above?.find((c) => c.col === cell.col)?.text ?? "",
            below?.find((c) => c.col === cell.col)?.text ?? "",
          ].some(nonPeriodHeader),
      )
      .map((cell) => {
        const merge = sheet.merges?.find((m) => m.row === cell.row && m.col === cell.col);
        const bodyCols = merge
          ? [
              ...new Set(
                sheet.cells
                  .filter(
                    (c) =>
                      c.row > merge.endRow &&
                      c.col >= merge.col &&
                      c.col <= merge.endCol &&
                      (c.kind === "number"
                        ? excelNumberToDecimal(c.text)
                        : parseMoneyToken(c.text)) !== null,
                  )
                  .map((c) => c.col),
              ),
            ]
          : [];
        // A merged year can cover a spacer and one amount column, never two competing amounts.
        if (merge && bodyCols.length > 1) return { col: -1, label: "UNRESOLVED", derived: false };
        return {
          col: bodyCols[0] ?? cell.col,
          label: composePeriod(periodLabel(cell) ?? "", above, below, cell.col),
          derived: false,
        };
      });
    if (periods.length === 0 || periods.some((p) => p.col < 0))
      return { reason: "layout_unresolved" };
    break;
  }
  if (headerRow === null) {
    const tally = parseTallySheet(sheet, rows, rowNumbers, fileName);
    if (tally) return tally;
    if (hasNumericAmount(rows)) return { reason: "layout_unresolved" };
    return {
      reason: "No header row of period dates or period labels was found in the first 25 rows",
    };
  }
  if (new Set(periods.map((p) => p.label)).size !== periods.length)
    return { reason: "layout_unresolved" };
  const firstPeriodCol = Math.min(...periods.map((period) => period.col));
  const periodByCol = new Map(periods.map((period) => [period.col, period.label]));
  const amountTokens = sheet.cells
    .filter(
      (c) =>
        c.row > headerRow! &&
        periodByCol.has(c.col) &&
        c.kind === "string" &&
        /\d/.test(c.text) &&
        !periodLabel(c),
    )
    .map((c) => c.text);
  const convention = numberConvention(amountTokens, sheet.cells.map((c) => c.text).join("\n"));
  if (convention === "conflict") return { reason: "layout_unresolved" };
  const annotationCols = new Set(
    sheet.cells
      .filter((cell) => cell.row <= headerRow)
      .filter(
        (cell) =>
          nonPeriodHeader(cell.text) &&
          (headerRole(cell) !== "annotation" || referenceColumn(cell.col, rows, headerRow)),
      )
      .map((cell) => cell.col),
  );

  const lines: StatementLine[] = [];
  const droppedAmounts: DroppedAmount[] = [];
  let skippedRows = 0;
  let skippedCells = 0;
  for (const rowNo of rowNumbers) {
    if (rowNo <= headerRow) continue;
    const cells = rows.get(rowNo) ?? [];
    const periodTexts = cells
      .filter((cell) => cell.col >= firstPeriodCol)
      .map((cell) => cell.text.trim())
      .filter((text) => text.length > 0);
    if (
      periodTexts.length > 0 &&
      periodTexts.every((text) => /^(19|20)\d{2}$/.test(text)) &&
      cells
        .filter((c) => c.col < firstPeriodCol)
        .every((c) => !c.text.trim() || headerRole(c) === "label")
    )
      continue;
    const label = cells
      .filter(
        (cell) =>
          cell.col < firstPeriodCol && cell.kind === "string" && !annotationCols.has(cell.col),
      )
      .sort((a, b) => a.col - b.col)
      .map((cell) => cell.text.trim())
      .filter((text) => text.length > 0)
      .join(" ");
    const values: { period: string; amount: string; raw: string; formula: boolean }[] = [];
    for (const cell of cells) {
      const period = periodByCol.get(cell.col);
      if (period === undefined) continue;
      if (cell.kind === "string" && cell.text.trim().length === 0) continue;
      const amount = statementCellAmount(cell.kind, cell.text, label, convention);
      if (amount === null) {
        if (
          cell.kind === "string" &&
          convention === "unknown" &&
          parseMoneyToken(cell.text) !== null
        )
          return { reason: "layout_unresolved" };
        if (cell.kind === "string" && looksLikeMoney(cell.text)) {
          droppedAmounts.push({ raw: cell.text, page: null });
        }
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
    return {
      reason: "The sheet has a period header but no labeled rows with numeric values",
      droppedAmounts,
    };
  }
  const statementType =
    classify(fileName, sheet.name, lines) ??
    classify(
      fileName,
      sheet.cells
        .filter((c) => c.row <= headerRow!)
        .map((c) => c.text)
        .join("\n"),
      lines,
    );
  if (statementType === null) {
    return {
      reason: "Could not tell whether this sheet is an income statement or a balance sheet",
    };
  }
  return {
    sheetName: sheet.name,
    statementType,
    periods: markDerived(periods, lines),
    periodContext: rowNumbers
      .filter((r) => r <= headerRow!)
      .map((r) =>
        (rows.get(r) ?? [])
          .filter((c) => r < headerRow! || c.col < firstPeriodCol)
          .filter(
            (c) =>
              !periods.some(
                (p) =>
                  p.col === c.col &&
                  p.label !== c.text.trim() &&
                  p.label.startsWith(`${c.text.trim()} `),
              ),
          )
          .map((c) => c.text)
          .join(" "),
      )
      .join("\n"),
    lines,
    skippedRows,
    skippedCells,
    droppedAmounts,
  };
}

function statementCellAmount(
  kind: SheetCell["kind"],
  text: string,
  label = "",
  convention?: NumberConvention,
): string | null {
  const direction = /\s*(DR|CR)\s*$/i.exec(text);
  if (direction) {
    const debitNormal = accountDebitNormal(label);
    const amount = parseMoneyToken(text.replace(/\s*(DR|CR)\s*$/i, ""), convention);
    if (debitNormal === null || amount === null || new AnalyticalDecimal(amount).isNegative())
      return null;
    return (direction[1]?.toUpperCase() === "DR") === debitNormal
      ? amount
      : new AnalyticalDecimal(amount).neg().toFixed();
  }
  if (kind === "number") {
    const displayed = excelNumberToDecimal(text);
    return displayed;
  }
  return printedStatementAmount(text, convention);
}

function accountDebitNormal(label: string): boolean | null {
  const mapping = mapLineLabel(label);
  if (!mapping || !mappingIsAutoAcceptable(mapping.confidence)) return null;
  const account = canonicalAccount(mapping.accountCode);
  if (!account || account.contra) return null;
  return (
    account.report === "asset" || account.report === "expense" || account.code === "distributions"
  );
}

function printedStatementAmount(text: string, convention?: NumberConvention): string | null {
  const trimmed = text.trim();
  if (/^[-\u2013\u2014]$/.test(trimmed)) return "0";
  return parseMoneyToken(trimmed, convention);
}

function looksLikeMoney(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length <= 40 &&
    /^(?:[$€£₹¥]|S\$|A\$|US\$|C\$|HK\$|Rs\.?|INR|AED|USD|EUR|GBP|SGD|AUD|JPY)?\s*\(?-?\d[\d,]*(?:\.\d+)?\)?(?:\s*(?:CR|DR))?(?:\s*(?:INR|AED|USD|EUR|GBP|SGD|AUD|JPY))?$/i.test(
      trimmed,
    )
  );
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

function parseTallySheet(
  sheet: Worksheet,
  rows: ReadonlyMap<number, SheetCell[]>,
  rowNumbers: readonly number[],
  fileName: string,
): StatementSheet | { reason: string } | null {
  let rememberedLabel: number | undefined;
  for (const rowNo of rowNumbers.slice(0, MAX_HEADER_SCAN_ROWS)) {
    const cells = rows.get(rowNo) ?? [];
    const roles = new Map(cells.map((cell) => [cell.col, tallyRole(cell)]));
    const foundLabel = [...roles.entries()].find(([, role]) => role === "label")?.[0];
    if (foundLabel !== undefined) rememberedLabel = foundLabel;
    const labelCol = foundLabel ?? rememberedLabel;
    const debitCol = [...roles.entries()].find(([, role]) => role === "debit")?.[0];
    const creditCol = [...roles.entries()].find(([, role]) => role === "credit")?.[0];
    const amountCol = [...roles.entries()].find(([, role]) => role === "amount")?.[0];
    if (
      labelCol === undefined ||
      (debitCol === undefined && creditCol === undefined && amountCol === undefined)
    ) {
      continue;
    }
    const joined = [...rows.values()]
      .flat()
      .map((cell) => cell.text)
      .join("\n");
    const textAmounts = sheet.cells
      .filter(
        (c) =>
          c.row > rowNo &&
          [debitCol, creditCol, amountCol].includes(c.col) &&
          c.kind === "string" &&
          c.text.trim() &&
          !/^[-–—]$/.test(c.text.trim()),
      )
      .map((c) => c.text);
    const convention = numberConvention(textAmounts, joined);
    if (
      convention === "conflict" ||
      textAmounts.some((raw) => parseMoneyToken(raw, convention) === null)
    )
      return { reason: "layout_unresolved" };
    const dated = explicitYearEnd(joined);
    const period = dated
      ? `Year ended ${dated.day} ${monthName(dated.month)} ${dated.year}`
      : (datedRangePhrase(joined) ?? "UNRESOLVED");
    const lines: StatementLine[] = [];
    const droppedAmounts: DroppedAmount[] = [];
    for (const dataRow of rowNumbers) {
      if (dataRow <= rowNo) continue;
      const row = rows.get(dataRow) ?? [];
      const label = row
        .filter((cell) => cell.col === labelCol && cell.kind === "string")
        .map((cell) => cell.text.trim())
        .join(" ");
      const debit = debitCol === undefined ? null : amountAt(row, debitCol, convention);
      const credit = creditCol === undefined ? null : amountAt(row, creditCol, convention);
      const single = amountCol === undefined ? null : amountAt(row, amountCol, convention, label);
      let amount = single;
      if (!amount && (debit || credit)) {
        const debitNormal = accountDebitNormal(label);
        if (debitNormal === null) {
          droppedAmounts.push({
            raw: `${label}: ${debit?.raw ?? ""} / ${credit?.raw ?? ""}`,
            page: null,
          });
          continue;
        }
        const net = new AnalyticalDecimal(debit?.amount ?? "0").sub(credit?.amount ?? "0");
        amount = {
          amount: (debitNormal ? net : net.neg()).toFixed(),
          raw: `${debit?.raw ?? ""} Dr / ${credit?.raw ?? ""} Cr`,
        };
      }
      if (label.length === 0 || !amount) continue;
      lines.push({
        sheetRow: dataRow,
        label,
        kind: /^total\b/i.test(label) ? "total" : "line",
        values: [{ period, amount: amount.amount, raw: amount.raw, formula: false }],
      });
    }
    if (!lines.some((line) => line.values.length > 0)) return null;
    const statementType = classify(fileName, sheet.name, lines);
    if (!statementType) return null;
    return {
      sheetName: sheet.name,
      statementType,
      periods: [{ col: amountCol ?? debitCol ?? creditCol ?? 2, label: period, derived: false }],
      lines,
      skippedRows: 0,
      skippedCells: 0,
      droppedAmounts,
    };
  }
  return null;
}

function tallyRole(cell: SheetCell): "label" | "debit" | "credit" | "amount" | "other" {
  if (cell.kind !== "string") return "other";
  const text = cell.text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (
    /^(particulars|particular|account|account name|ledger|ledger name|account head|name|description)$/.test(
      text,
    )
  ) {
    return "label";
  }
  if (/^(debit|dr|withdrawals?)$/.test(text)) return "debit";
  if (/^(credit|cr|deposits?)$/.test(text)) return "credit";
  if (/^(amount|closing balance|balance)$/.test(text)) return "amount";
  return "other";
}

function amountAt(
  row: readonly SheetCell[],
  col: number,
  convention: NumberConvention,
  label = "",
): { amount: string; raw: string } | null {
  const cell = row.find((candidate) => candidate.col === col);
  if (!cell) return null;
  const amount = statementCellAmount(cell.kind, cell.text, label, convention);
  if (!amount) return null;
  return { amount, raw: cell.text };
}

function monthName(month: number): string {
  return (
    [
      "",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ][month] ?? ""
  );
}

function headerRole(cell: SheetCell): "period" | "label" | "annotation" | "unknown" {
  if (annotationHeader(cell.text)) return "annotation";
  if (nonPeriodHeader(cell.text)) return "unknown";
  if (periodLabel(cell)) return "period";
  const text = cell.kind === "string" ? cell.text : "";
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (
    /^(particulars|particular|description|account|account name|ledger|name|narration|line item)$/.test(
      normalized,
    )
  ) {
    return "label";
  }
  if (/^(note|notes|note no|sch|schedule|ref|sr|remarks|unit|units)$/.test(normalized)) {
    return "annotation";
  }
  return "unknown";
}

/** A note header whose body is account names is the label column, not a reference column. */
function referenceColumn(
  col: number,
  rows: ReadonlyMap<number, SheetCell[]>,
  headerRow: number,
): boolean {
  const samples: string[] = [];
  for (const [rowNo, cells] of rows) {
    if (rowNo <= headerRow) continue;
    const text = cells.find((candidate) => candidate.col === col)?.text.trim() ?? "";
    if (text.length > 0) samples.push(text);
  }
  if (samples.length === 0) return true;
  const references = samples.filter(
    (sample) => /^[\d.,()-]+$/.test(sample) || /^[A-Za-z]{0,3}\d+[A-Za-z0-9]*$/.test(sample),
  );
  return references.length * 2 >= samples.length;
}

function hasNumericAmount(rows: ReadonlyMap<number, SheetCell[]>): boolean {
  for (const cells of rows.values()) {
    for (const cell of cells) {
      if (cell.col >= 2 && cell.kind === "number") return true;
      if (cell.col >= 2 && cell.kind === "string" && looksLikeMoney(cell.text)) return true;
    }
  }
  return false;
}

function periodLabel(cell: SheetCell): string | null {
  if (cell.kind === "number" && /^\d+$/.test(cell.text)) {
    if (/^(19|20)\d{2}$/.test(cell.text)) return cell.text;
    if (!cell.dateFormat) return null;
    const serial = Number.parseInt(cell.text, 10);
    if (serial < SERIAL_MIN || serial > SERIAL_MAX) return null;
    return new Date(
      (cell.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + serial * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
  }
  if (cell.kind === "string") {
    const text = cell.text.replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.length > 160) return null;
    if (isStatementPeriodLabel(text)) return text;
    if (parseLooseDate(text)) return text;
    if (/^(current month|year to date)( (this year|last year))?$/i.test(text)) return text;
    if (/^(this year|last year|ytd)$/i.test(text)) return text;
    if (/^(19|20)\d{2}$/.test(text)) return text;
    if (/^[A-Za-z]+ \d{1,2}, \d{4}$/.test(text)) return text;
    if (/^\d{1,2} [A-Za-z]{3,9} \d{4}$/.test(text)) return text;
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(text)) return text;
    if (/^\d{1,2}-[A-Za-z]{3,9}-\d{4}$/.test(text)) return text;
    if (/^(?:FY\s*)?(?:19|20)\d{2}\s*[-/]\s*\d{2,4}$/i.test(text)) return text;
    if (/^FY\s*\d{2}(?:-\d{2})?$/i.test(text)) return text;
    if (/^[A-Za-z]{3,9}[-\s]\d{2}$/.test(text)) return text;
    if (
      /^(?:(?:for the )?year ended|(?:three|six|nine|twelve|\d+)\s+months?\s+ended|as at|as of|quarter ended|half[-\s]?year ended)\b/i.test(
        text,
      ) &&
      /\d/.test(text)
    ) {
      return text;
    }
    if (
      /^(?:FY\s*(?:19|20)\d{2}|(?:Q[1-4]|H[12]|[A-Za-z]{3,9})[\s/-]+(?:19|20)\d{2})$/i.test(text) &&
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
    const localized = localizedStatementType(name);
    if (localized) return localized;
    const income = INCOME_NAME.test(name);
    const balance = BALANCE_NAME.test(name);
    if (income && !balance) return "income_statement";
    if (balance && !income) return "balance_sheet";
  }
  const incomeHits = lines.filter((line) => INCOME_LABELS.test(line.label)).length;
  const balanceHits = lines.filter((line) => BALANCE_LABELS.test(line.label)).length;
  if (incomeHits > 0 && balanceHits === 0) return "income_statement";
  if (balanceHits > 0 && incomeHits === 0) return "balance_sheet";
  let income = 0;
  let balance = 0;
  for (const line of lines) {
    const code = mapLineLabel(line.label)?.accountCode;
    const account = code ? canonicalAccount(code) : undefined;
    if (!account) continue;
    if (account.report === "revenue" || account.report === "expense") income += 1;
    else balance += 1;
  }
  if (income > 0 && balance === 0) return "income_statement";
  if (balance > 0) return "balance_sheet";
  return null;
}

function composePeriod(
  label: string,
  above: readonly SheetCell[] | undefined,
  below: readonly SheetCell[] | undefined,
  col: number,
): string {
  const aboveText = above?.find((cell) => cell.col === col)?.text.trim() ?? "";
  const belowText = below?.find((cell) => cell.col === col)?.text.trim() ?? "";
  if (!/(19|20)\d{2}/.test(label) && /^(19|20)\d{2}$/.test(belowText))
    return `${label} ${belowText}`;
  if (
    (/^(19|20)\d{2}$/.test(label) || parseLooseDate(label)) &&
    /(?:year ended|months ended|as at|as of)/i.test(aboveText) &&
    !parseLooseDate(aboveText.replace(/^.*(?:ended|as at|as of)\s*/i, ""))
  ) {
    return `${aboveText} ${label}`;
  }
  return label;
}
