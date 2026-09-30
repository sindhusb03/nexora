import { statementAmountToDecimal } from "./decimal-text.js";
import type { PdfLine, PdfText } from "./bank-pdf.js";
import type { StatementLine, StatementPeriod, StatementSheet, StatementType, StatementWorkbook } from "./statement-xlsx.js";

const TITLES: readonly { readonly pattern: RegExp; readonly type: StatementType }[] = [
  { pattern: /^(balance sheet|statement of financial position|estado de situaci[oó]n(?: financiera)?)$/i, type: "balance_sheet" },
  {
    pattern: /^(income statement|statement of (loss and comprehensive income|comprehensive income|loss|income|operations)|estados? de ingresos(?: y gastos)?(?: y cambio en participacion)?)$/i,
    type: "income_statement",
  },
  { pattern: /^(statement of cash flows|estados? de flujos de efectivo)$/i, type: "cash_flow" },
  { pattern: /^statement of changes in (stockholders[’'] equity|equity)$/i, type: "equity" },
];

const DATE_TEXT = /\b(\d{1,2} de [A-Za-zÁÉÍÓÚáéíóú]+ de \d{4}|[A-Za-z]+ \d{1,2}, \d{4})\b/;

/**
 * Reads statement pages from PDF text. Amounts stay the printed decimal strings.
 * A page with no text layer never reaches this function.
 */
export function parseStatementPdf(text: PdfText, fileName: string): StatementWorkbook {
  const sections = collectSections(text.lines);
  const sheets: StatementSheet[] = [];
  const skippedSheets: { sheetName: string; reason: string }[] = [];
  sections.forEach((section, index) => {
    const sheet = sectionToSheet(section, index);
    if ("reason" in sheet) skippedSheets.push({ sheetName: section.title, reason: sheet.reason });
    else sheets.push(sheet);
  });
  if (sheets.length === 0 && skippedSheets.length === 0) {
    skippedSheets.push({
      sheetName: fileName,
      reason: "No balance sheet, income statement, cash flow, or equity statement heading was found",
    });
  }
  return { sheets, skippedSheets };
}

interface Section {
  readonly title: string;
  readonly type: StatementType;
  readonly preamble: readonly string[];
  readonly lines: readonly PdfLine[];
}

function collectSections(lines: readonly PdfLine[]): Section[] {
  const sections: Section[] = [];
  let current: { title: string; type: StatementType; preamble: string[]; lines: PdfLine[] } | null = null;
  const before: string[] = [];
  for (const line of lines) {
    const title = titleOf(line);
    if (title) {
      if (current && current.type === title.type) continue;
      if (current) sections.push(current);
      current = { title: lineText(line), type: title.type, preamble: before.slice(-6), lines: [] };
      continue;
    }
    if (/^notes? to the financial statements$/i.test(lineText(line))) {
      if (current) sections.push(current);
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
    else before.push(lineText(line));
  }
  if (current) sections.push(current);
  return sections;
}

function sectionToSheet(section: Section, index: number): StatementSheet | { reason: string } {
  const dated = [...section.preamble, ...section.lines.slice(0, 8).map(lineText)].map(findDate).find((date) => date !== null) ?? null;
  const split = section.lines.map(splitLine);
  const amountXs = split.flatMap((line) => line.amounts.map((amount) => amount.x));
  const centers = cluster(amountXs);
  if (centers.length === 0) return { reason: "The statement heading has no printed amounts under it" };

  const headerLines = split.filter((line) => line.amounts.length === 0).slice(0, 8);
  const periods: StatementPeriod[] = centers.map((center, column) => ({
    col: column + 1,
    label: columnLabel(center, headerLines, centers.length === 1 ? dated : null, column),
    derived: false,
  }));

  const lines: StatementLine[] = [];
  let skippedRows = 0;
  let skippedCells = 0;
  for (const line of split) {
    if (line.label.length > 90) {
      skippedRows += 1;
      continue;
    }
    const values: StatementLine["values"][number][] = [];
    const used = new Set<number>();
    for (const amount of line.amounts) {
      const column = nearest(amount.x, centers);
      if (column === null || used.has(column)) {
        skippedCells += 1;
        continue;
      }
      used.add(column);
      const period = periods[column]?.label;
      if (!period) {
        skippedCells += 1;
        continue;
      }
      values.push({ period, amount: amount.amount, raw: amount.amount, formula: false });
    }
    if (line.label.length === 0) {
      if (values.length > 0) skippedRows += 1;
      continue;
    }
    const kind = values.length === 0 ? "heading" : /^total\b/i.test(line.label) ? "total" : "line";
    lines.push({ sheetRow: lines.length + 1, label: line.label, kind, values });
  }
  if (!lines.some((line) => line.values.length > 0)) {
    return { reason: "The statement heading has labels but no amount columns this parser could keep" };
  }
  return {
    sheetName: section.title || `Statement ${index + 1}`,
    statementType: section.type,
    periods,
    lines,
    skippedRows,
    skippedCells,
  };
}

function columnLabel(center: number, headers: readonly Split[], singleDate: string | null, column: number): string {
  const phrases: string[] = [];
  for (const header of headers) {
    const phrase = header.items
      .filter((item) => item.text !== "$" && statementAmountToDecimal(item.text) === null && Math.abs(item.x - center) <= 55)
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (/^(current month|year to date)( (this year|last year))?$/i.test(phrase) || /^(this year|last year|ytd|(19|20)\d{2})$/i.test(phrase)) {
      phrases.push(phrase);
    }
  }
  if (phrases.length > 0) return phrases.join(" · ");
  if (singleDate) return singleDate;
  return `Column ${column + 1}`;
}

interface Split {
  readonly label: string;
  readonly amounts: readonly { readonly x: number; readonly amount: string }[];
  readonly items: PdfLine["items"];
}

function splitLine(line: PdfLine): Split {
  const amounts: { x: number; amount: string }[] = [];
  const label: string[] = [];
  for (const item of line.items) {
    if (item.text === "$") continue;
    const amount = statementAmountToDecimal(item.text);
    if (amount === null) label.push(item.text);
    else amounts.push({ x: item.x, amount });
  }
  return { label: label.join(" ").replace(/\s+/g, " ").trim(), amounts, items: line.items };
}

function titleOf(line: PdfLine): { type: StatementType } | null {
  if (line.items.some((item) => item.x > 450 && /^\d{1,3}$/.test(item.text))) return null;
  const text = lineText(line);
  if (text.length < 8 || text.length > 80 || line.items.length > 8) return null;
  const found = TITLES.find((title) => title.pattern.test(text));
  return found ? { type: found.type } : null;
}

function lineText(line: PdfLine): string {
  return line.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
}

function findDate(text: string): string | null {
  return DATE_TEXT.exec(text)?.[1] ?? null;
}

function cluster(xs: readonly number[]): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const centers: number[] = [];
  for (const x of sorted) {
    const last = centers[centers.length - 1];
    if (last === undefined || x - last > 48) centers.push(x);
    else centers[centers.length - 1] = last;
  }
  return centers;
}

function nearest(x: number, centers: readonly number[]): number | null {
  let best: number | null = null;
  let distance = 56;
  centers.forEach((center, index) => {
    const gap = Math.abs(center - x);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  });
  return best;
}
