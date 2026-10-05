import { parseMoneyToken, statementAmountToDecimal } from "./decimal-text.js";
import type { PdfLine, PdfText } from "./bank-pdf.js";
import {
  explicitYearEnd,
  parseLooseDate,
  isStatementPeriodLabel,
  isReportRunLine,
} from "./period.js";
import { parseStatementSheet, parseStatementWorkbook } from "./statement-xlsx.js";
import { amountColumnRole, blockTitle } from "./statement-blocks.js";
import type { SheetCell } from "./xlsx.js";
import { annotationHeader, localizedStatementType, nonPeriodHeader } from "./statement-locales.js";
import type {
  StatementLine,
  StatementPeriod,
  StatementSheet,
  StatementType,
  StatementWorkbook,
} from "./statement-xlsx.js";

/**
 * Reads statement pages from PDF text. Amounts stay the printed decimal strings.
 * A page with no text layer never reaches this function.
 */
export function parseStatementPdf(text: PdfText, fileName: string): StatementWorkbook {
  const multiBlock = semanticPdfWorkbook(text, fileName);
  if (multiBlock) return multiBlock;
  const sections = collectSections(text.lines);
  const sheets: StatementSheet[] = [];
  const skippedSheets: { sheetName: string; reason: string }[] = [];
  const droppedAmounts: { raw: string; page: number | null }[] = [];
  let layoutUnresolved = false;
  sections.forEach((section, index) => {
    const sheet = sectionToSheet(section, index);
    if ("reason" in sheet) {
      if (sheet.reason === "layout_unresolved") layoutUnresolved = true;
      skippedSheets.push({ sheetName: section.title, reason: sheet.reason });
      if ("droppedAmounts" in sheet) droppedAmounts.push(...sheet.droppedAmounts);
    } else {
      sheets.push(sheet.sheet);
      droppedAmounts.push(...sheet.droppedAmounts);
    }
  });
  if (sheets.length === 0 && skippedSheets.length === 0) {
    skippedSheets.push({
      sheetName: fileName,
      reason:
        "No balance sheet, income statement, cash flow, or equity statement heading was found",
    });
  }
  if (layoutUnresolved)
    return { sheets: [], skippedSheets, droppedAmounts, layoutUnresolved: true };
  return { sheets, skippedSheets, droppedAmounts, layoutUnresolved: false };
}

/** Keep both labels and all component amounts in geometric columns before splitting blocks. */
function semanticPdfWorkbook(text: PdfText, fileName: string): StatementWorkbook | null {
  const headers = text.lines.filter((line) =>
    line.items.some((i) =>
      /^(?:particulars|account(?: name)?|description|liabilities|assets|expenses|income|actif|passif)$/i.test(
        i.text.trim(),
      ),
    ),
  );
  const titleCount = text.lines.flatMap((line) =>
    line.items.filter((i) => blockTitle(i.text)),
  ).length;
  if (
    !headers.some(
      (line) =>
        line.items.some((i) => amountColumnRole(i.text)) ||
        line.items.filter((i) =>
          /^(?:particulars|liabilities|assets|expenses|income)$/i.test(i.text.trim()),
        ).length >= 2,
    ) &&
    titleCount < 2
  )
    return null;
  const xs = [
    ...new Set([
      ...headers.flatMap((line) => line.items.map((i) => i.x)),
      ...text.lines.flatMap((line) =>
        line.items
          .filter((i) => parseMoneyToken(i.text) !== null && !/^(19|20)\d{2}$/.test(i.text.trim()))
          .map((i) => i.x),
      ),
      ...text.lines.flatMap((line) => line.items.filter((i) => blockTitle(i.text)).map((i) => i.x)),
    ]),
  ].sort((a, b) => a - b);
  const cells: SheetCell[] = [];
  text.lines.forEach((line, row) => {
    const groups = new Map<number, string[]>();
    for (const item of line.items) {
      const col = nearest(item.x, xs);
      if (col === null) continue;
      const runs = groups.get(col + 1) ?? [];
      runs.push(item.text);
      groups.set(col + 1, runs);
    }
    for (const [col, runs] of groups)
      cells.push({ row: row + 1, col, kind: "string", text: runs.join(" "), formula: false });
  });
  const workbook = parseStatementWorkbook([{ name: fileName, cells }], fileName);
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => ({
      ...sheet,
      lines: sheet.lines.map((line) => ({
        ...line,
        values: line.values.map((value) => {
          const source = text.lines[line.sheetRow - 1];
          const item = source?.items.find(
            (i) =>
              nearest(i.x, xs) ===
                (value.col ?? sheet.periods.find((p) => p.label === value.period)!.col) - 1 &&
              i.text === value.raw,
          );
          return item && source
            ? {
                ...value,
                location: {
                  page: source.page,
                  bbox: {
                    x0: item.x,
                    y0: source.y,
                    x1: item.x + (item.width ?? 0),
                    y1: source.y + (item.height ?? 0),
                  },
                },
              }
            : value;
        }),
      })),
    })),
  };
}

interface Section {
  readonly title: string;
  readonly type: StatementType;
  readonly preamble: readonly string[];
  readonly lines: readonly PdfLine[];
}

function collectSections(lines: readonly PdfLine[]): Section[] {
  const sections: Section[] = [];
  let current: { title: string; type: StatementType; preamble: string[]; lines: PdfLine[] } | null =
    null;
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

function sectionToSheet(
  section: Section,
  index: number,
):
  | { sheet: StatementSheet; droppedAmounts: { raw: string; page: number | null }[] }
  | { reason: string; droppedAmounts?: readonly { raw: string; page: number | null }[] } {
  const anchored = headerAnchoredSheet(section);
  if (anchored) return anchored;
  const end = explicitYearEnd(
    [section.title, ...section.preamble, ...section.lines.slice(0, 8).map(lineText)].join("\n"),
  );
  const titleDate = section.lines[0] ? lineText(section.lines[0]) : "";
  const dated = end
    ? `${end.year}-${String(end.month).padStart(2, "0")}-${String(end.day).padStart(2, "0")}`
    : parseLooseDate(titleDate)
      ? titleDate
      : null;
  const split = section.lines.map(splitLine);
  const amountXs = split.flatMap((line) => line.amounts.map((amount) => amount.x));
  const centers = cluster(amountXs);
  const droppedAmounts = split.flatMap((line) => line.dropped);
  if (centers.length === 0) {
    return { reason: "The statement heading has no printed amounts under it", droppedAmounts };
  }

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
      values.push({ period, amount: amount.amount, raw: amount.raw, formula: false });
    }
    if (line.label.length === 0) {
      if (values.length > 0) skippedRows += 1;
      continue;
    }
    const kind = values.length === 0 ? "heading" : /^total\b/i.test(line.label) ? "total" : "line";
    lines.push({ sheetRow: lines.length + 1, label: line.label, kind, values });
  }
  if (!lines.some((line) => line.values.length > 0)) {
    return {
      reason: "The statement heading has labels but no amount columns this parser could keep",
      droppedAmounts,
    };
  }
  return {
    sheet: {
      sheetName: section.title || `Statement ${index + 1}`,
      statementType: section.type,
      periods,
      periodContext: [
        section.title,
        ...section.preamble,
        ...section.lines.filter((line) => !line.items.some((item) => item.x > 150)).map(lineText),
      ].join("\n"),
      lines,
      skippedRows,
      skippedCells,
      droppedAmounts: split.flatMap((line) => line.dropped),
    },
    droppedAmounts: split.flatMap((line) => line.dropped),
  };
}

/** Use dated header geometry before inferring columns from printed amounts.
 * This admits integer text only within a known financial column, excludes note
 * numbers, and preserves split text runs instead of choosing the last token.
 */
function headerAnchoredSheet(
  section: Section,
):
  | { sheet: StatementSheet; droppedAmounts: { raw: string; page: number | null }[] }
  | { reason: string }
  | null {
  const headerIndex = section.lines.findIndex(
    (line) =>
      !isReportRunLine(lineText(line)) &&
      line.items.some(
        (i) =>
          i.x > 150 &&
          (/^(?:FY\s*)?(?:19|20)\d{2}$/.test(i.text.trim()) ||
            parseLooseDate(i.text) !== null ||
            isStatementPeriodLabel(i.text) ||
            /^(?:year ended|\d{4}年)$/i.test(i.text.trim())),
      ),
  );
  if (headerIndex < 0) return null;
  const header = section.lines[headerIndex]!;
  const anchors = header.items
    .filter(
      (i) =>
        /^(?:FY\s*)?(?:19|20)\d{2}$/.test(i.text.trim()) ||
        parseLooseDate(i.text) !== null ||
        isStatementPeriodLabel(i.text) ||
        annotationHeader(i.text) ||
        nonPeriodHeader(i.text) ||
        /^(?:year ended|\d{4}年)$/i.test(i.text.trim()),
    )
    .sort((a, b) => a.x - b.x);
  if (!anchors.length) return null;
  // A centered report date is not a column anchor. Retain the established
  // single-column fallback only when no note/component columns compete with it.
  if (
    anchors.length === 1 &&
    !section.lines.some((line) => line.items.some((item) => nonPeriodHeader(item.text))) &&
    !section.lines
      .slice(headerIndex + 1)
      .some((line) =>
        line.items.some(
          (item) =>
            parseMoneyToken(item.text) !== null &&
            Math.min(
              Math.abs(item.x - anchors[0]!.x),
              Math.abs(item.x + (item.width ?? 0) - anchors[0]!.x - (anchors[0]!.width ?? 0)),
            ) < 55,
        ),
      )
  )
    return null;
  const cells: SheetCell[] = [];
  for (const [index, line] of section.lines.slice(headerIndex).entries()) {
    const groups = new Map<number, string[]>();
    for (const item of line.items) {
      let col = 1;
      let distance = 55;
      anchors.forEach((anchor, i) => {
        const gap = Math.min(
          Math.abs(item.x - anchor.x),
          Math.abs(item.x + (item.width ?? 0) - anchor.x - (anchor.width ?? 0)),
        );
        if (gap < distance) {
          distance = gap;
          col = i + 2;
        }
      });
      const group = groups.get(col) ?? [];
      group.push(item.text);
      groups.set(col, group);
    }
    for (const [col, runs] of groups)
      cells.push({
        row: index + 1,
        col,
        text: runs.join(" ").trim(),
        kind: "string",
        formula: false,
      });
  }
  const sheet = parseStatementSheet({ name: section.title, cells }, section.title);
  return "reason" in sheet
    ? { reason: "layout_unresolved" }
    : {
        sheet: {
          ...sheet,
          periodContext: [
            sheet.periodContext ?? "",
            section.title,
            ...section.preamble,
            ...section.lines.slice(0, headerIndex).map(lineText),
          ].join("\n"),
        },
        droppedAmounts: [...sheet.droppedAmounts],
      };
}

function columnLabel(
  center: number,
  headers: readonly Split[],
  singleDate: string | null,
  column: number,
): string {
  const phrases: string[] = [];
  for (const header of headers) {
    if (isReportRunLine(header.items.map((item) => item.text).join(" "))) continue;
    const phrase = header.items
      .filter(
        (item) =>
          item.text !== "$" &&
          statementAmountToDecimal(item.text) === null &&
          Math.abs(item.x - center) <= 55,
      )
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (
      /^(current month|year to date)( (this year|last year))?$/i.test(phrase) ||
      /^(this year|last year|ytd|(19|20)\d{2})$/i.test(phrase) ||
      /(?:year ended|months ended|as at|as of)/i.test(phrase) ||
      /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/i.test(phrase) ||
      /^[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}$/i.test(phrase)
    ) {
      phrases.push(phrase);
    }
  }
  if (phrases.length > 0) return phrases.join(" · ");
  if (singleDate) return singleDate;
  return `Column ${column + 1}`;
}

interface Split {
  readonly label: string;
  readonly amounts: readonly {
    readonly x: number;
    readonly amount: string;
    readonly raw: string;
  }[];
  readonly items: PdfLine["items"];
  readonly dropped: readonly { readonly raw: string; readonly page: number | null }[];
}

function splitLine(line: PdfLine): Split {
  const amounts: { x: number; amount: string; raw: string }[] = [];
  const dropped: { raw: string; page: number | null }[] = [];
  const label: string[] = [];
  for (const item of line.items) {
    if (item.text === "$") continue;
    const amount = pdfAmount(item.text);
    if (amount === null) {
      if (looksLikeMoney(item.text)) dropped.push({ raw: item.text, page: line.page });
      else label.push(item.text);
    } else amounts.push({ x: item.x, amount, raw: item.text });
  }
  return {
    label: label.join(" ").replace(/\s+/g, " ").trim(),
    amounts,
    items: line.items,
    dropped,
  };
}

function pdfAmount(text: string): string | null {
  const trimmed = text.trim();
  if (!/[(),.]|\b(?:CR|DR)\b/i.test(trimmed)) return statementAmountToDecimal(trimmed);
  if (/^(19|20)\d{2}$/.test(trimmed)) return null;
  return parseMoneyToken(trimmed) ?? statementAmountToDecimal(trimmed);
}

function looksLikeMoney(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length <= 40 &&
    /^(?:[$€£₹]|S\$|A\$)?\s*\(?-?\d[\d,]*(?:\.\d+)?\)?(?:\s*(?:CR|DR))?$/i.test(trimmed)
  );
}

function titleOf(line: PdfLine): { type: StatementType } | null {
  if (line.items.some((item) => item.x > 450 && /^\d{1,3}$/.test(item.text))) return null;
  const text = lineText(line);
  if (text.length < 2 || text.length > 140 || line.items.length > 12) return null;
  if (line.items.some((item) => pdfAmount(item.text) !== null && /\d/.test(item.text))) return null;
  const localized = localizedStatementType(text);
  if (localized) return { type: localized };
  if (/balance sheets?|financial position/i.test(text)) return { type: "balance_sheet" };
  if (/statements? of cash flows?|cash flow/i.test(text)) return { type: "cash_flow" };
  if (/changes in .*equity|stockholders|shareholders/i.test(text)) return { type: "equity" };
  if (
    /income statements?|statements? of (?:operations|income|earnings)|profit and loss|comprehensive income|profit or loss/i.test(
      text,
    )
  ) {
    return { type: "income_statement" };
  }
  return null;
}

function lineText(line: PdfLine): string {
  return line.items
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
