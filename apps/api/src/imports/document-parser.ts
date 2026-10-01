import { currencyEvidence } from "./currency.js";
import { excelNumberToDecimal, numberConvention, parseMoneyToken } from "./decimal-text.js";
import {
  canonicalAccount,
  mapLineLabel,
  statementRole,
  type AmountRole,
  type AmountScale,
} from "@nexora/kernel";

import { resolveStatementPeriods, parseLooseDate, type YearEnd } from "./period.js";

import {
  parseBankPdfLines,
  parseBankText,
  type BankIssue,
  type TabularBank,
} from "./bank-tabular.js";
import { extractPdfText, type PdfTextItem } from "./bank-pdf.js";
import { parseStatementCsvForIngestion } from "./statement-csv.js";
import { statementScales, unknownScale } from "./statement-locales.js";
import { htmlToWorksheets, looksLikeHtml } from "./statement-html.js";
import { parseStatementPdf } from "./statement-pdf.js";
import type {
  DroppedAmount,
  StatementLine,
  StatementSheet,
  StatementWorkbook,
} from "./statement-xlsx.js";
import { parseStatementWorkbook } from "./statement-xlsx.js";
import { readWorkbook, type Worksheet } from "./xlsx.js";

export interface CellBBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface ParsedCell {
  readonly statementType: "income_statement" | "balance_sheet" | "bank";
  readonly role: AmountRole;
  readonly label: string;
  readonly sectionId: string;
  readonly periodKey: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly spanMonths: number;
  readonly amount: string;
  readonly rawText: string;
  readonly page: number | null;
  readonly sheet: string | null;
  readonly row: number | null;
  readonly col: number | null;
  readonly bbox: CellBBox | null;
  readonly balanceKind: "closing" | "opening" | "movement";
  readonly currency: string | null;
  readonly scale: AmountScale;
  readonly txnDate: string | null;
}

export interface ParsedDocument {
  readonly parserId: string;
  readonly currency: string | null;
  readonly scale: AmountScale;
  readonly cells: readonly ParsedCell[];
  readonly issues: readonly BankIssue[];
}

export interface DocumentParser {
  readonly id: string;
  supports(input: { readonly fileName: string; readonly bytes: Uint8Array }): boolean;
  parse(input: {
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly yearEnd?: YearEnd | null;
    readonly functionalCurrency?: string | null;
  }): Promise<ParsedDocument>;
}

export { normalizePeriod } from "./period.js";

export function selectDocumentParser(fileName: string, bytes: Uint8Array): DocumentParser {
  const parser = DOCUMENT_PARSERS.find((candidate) => candidate.supports({ fileName, bytes }));
  if (!parser) {
    throw new ParserError(`${fileName} is not an xlsx, csv, or text-layer PDF`);
  }
  return parser;
}

export class ParserError extends Error {
  override readonly name = "ParserError";
}

export const xlsxDocumentParser: DocumentParser = {
  id: "xlsx-text-0.1.0",
  supports({ bytes }) {
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  },
  async parse({ fileName, bytes, yearEnd = null, functionalCurrency = null }) {
    const sheets = readWorkbook(bytes);
    const text = sheets.map((sheet) => sheetText(sheet)).join("\n");
    const statements = sheets.filter((s) => !looksLikeBank(sheetText(s)));
    const workbook = parseStatementWorkbook(statements, fileName);
    const issues = workbookIssues(workbook);
    const cells = workbook.layoutUnresolved
      ? []
      : workbookToCells(workbook, sheets, [], text, yearEnd, issues, functionalCurrency);
    for (const sheet of sheets) {
      if (!looksLikeBank(sheetText(sheet))) continue;
      const parsed = parseBankText(sheetText(sheet, true));
      if (parsed.bank) {
        cells.push(
          ...bankCells(
            parsed.bank,
            sheet.name,
            parsed.bank.currency ?? detectCurrency(sheetText(sheet), functionalCurrency),
            "units",
          ),
        );
      }
      issues.push(...parsed.issues);
    }
    return finish("xlsx-text-0.1.0", cells, text, issues, functionalCurrency);
  },
};

export const csvDocumentParser: DocumentParser = {
  id: "csv-text-0.1.0",
  supports({ fileName, bytes }) {
    if (xlsxDocumentParser.supports({ fileName, bytes })) return false;
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
      return false;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (looksLikeHtml(text)) return false;
    return !text.includes("\u0000") && /[,;\t]/.test(text);
  },
  async parse({ fileName, bytes, yearEnd = null, functionalCurrency = null }) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
    const bank = looksLikeBank(text) ? parseBankText(text) : { bank: null, issues: [] };
    if (bank.bank || bank.issues.length > 0) {
      return finish(
        "csv-text-0.1.0",
        bank.bank
          ? bankCells(
              bank.bank,
              fileName,
              bank.bank.currency ?? detectCurrency(text, functionalCurrency),
              "units",
            )
          : [],
        text,
        [...bank.issues],
        functionalCurrency,
      );
    }
    const workbook = parseStatementCsvForIngestion(stripCurrencyMarks(text), fileName);
    const issues = [...bank.issues, ...workbookIssues(workbook)];
    return finish(
      "csv-text-0.1.0",
      workbook.layoutUnresolved
        ? []
        : workbookToCells(workbook, [], [], text, yearEnd, issues, functionalCurrency),
      text,
      issues,
      functionalCurrency,
    );
  },
};

export const htmlDocumentParser: DocumentParser = {
  id: "html-table-0.1.0",
  supports({ fileName, bytes }) {
    if (xlsxDocumentParser.supports({ fileName, bytes })) return false;
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return false;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return looksLikeHtml(text);
  },
  async parse({ fileName, bytes, yearEnd = null, functionalCurrency = null }) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const sheets = htmlToWorksheets(text);
    const joined = sheets
      .map((sheet) => sheet.cells.map((cell) => cell.text).join("\n"))
      .join("\n");
    const bank = looksLikeBank(joined) ? parseBankText(joined) : { bank: null, issues: [] };
    if (bank.bank || bank.issues.length > 0) {
      return finish(
        "html-table-0.1.0",
        bank.bank
          ? bankCells(
              bank.bank,
              fileName,
              bank.bank.currency ?? detectCurrency(text, functionalCurrency),
              "units",
            )
          : [],
        text,
        [...bank.issues],
        functionalCurrency,
      );
    }
    const workbook = parseStatementWorkbook([...sheets], fileName);
    const issues = [...workbookIssues(workbook)];
    return finish(
      "html-table-0.1.0",
      workbook.layoutUnresolved
        ? []
        : workbookToCells(workbook, [...sheets], [], text, yearEnd, issues, functionalCurrency),
      text,
      issues,
      functionalCurrency,
    );
  },
};

export const pdfDocumentParser: DocumentParser = {
  id: "pdf-text-layer-0.1.0",
  supports({ bytes }) {
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  },
  async parse({ fileName, bytes, yearEnd = null, functionalCurrency = null }) {
    const text = await extractPdfText(bytes);
    if (text.textItems === 0) {
      return finish("pdf-text-layer-0.1.0", [], fileName, [
        {
          code: "layout_unresolved",
          message: `${fileName} has no text layer, so it was routed to review`,
          raw: fileName,
          page: null,
        },
      ]);
    }
    const workbook = parseStatementPdf(text, fileName);
    const pdfItems = text.lines.flatMap((line) =>
      line.items.map((item) => ({ ...item, page: line.page })),
    );
    const joined = text.lines
      .map((line) => line.items.map((item) => item.text).join(" "))
      .join("\n");
    const issues = [...workbookIssues(workbook)];
    const cells = workbook.layoutUnresolved
      ? []
      : workbookToCells(workbook, [], pdfItems, joined, yearEnd, issues, functionalCurrency);
    const bank = parseBankPdfLines(text.lines);
    if (bank.bank) {
      cells.push(
        ...bankCells(
          bank.bank,
          fileName,
          bank.bank.currency ?? detectCurrency(joined, functionalCurrency),
          "units",
        ),
      );
    }
    issues.push(...bank.issues);
    return finish("pdf-text-layer-0.1.0", cells, joined, issues, functionalCurrency);
  },
};

export const DOCUMENT_PARSERS: readonly DocumentParser[] = [
  xlsxDocumentParser,
  pdfDocumentParser,
  htmlDocumentParser,
  csvDocumentParser,
];

function finish(
  parserId: string,
  cells: ParsedCell[],
  text: string,
  issues: BankIssue[] = [],
  functionalCurrency: string | null = null,
): ParsedDocument {
  // Bank column inference already separates account from original/foreign currency.
  // Re-scanning those headers would turn a valid FX export into a currency conflict.
  const bankOnly = cells.length > 0 && cells.every((cell) => cell.statementType === "bank");
  const bankCurrencies = new Set(cells.map((cell) => cell.currency).filter(Boolean));
  const resolvedBankCurrency = bankOnly && bankCurrencies.size === 1;
  const currency = resolvedBankCurrency
    ? ([...bankCurrencies][0] ?? null)
    : detectCurrency(text, functionalCurrency);
  const scale = detectScale(text);
  const normalized = cells.map((cell) => ({
    ...cell,
    currency: cell.currency ?? currency,
  }));
  const recorded = [...issues];
  if (
    bankCurrencies.size > 1 ||
    (!resolvedBankCurrency && currencyEvidence(text, functionalCurrency).conflict)
  )
    recorded.push({
      code: "layout_unresolved",
      message: "Conflicting statement currencies require confirmation",
      raw: text.slice(0, 240),
      page: null,
    });
  if (recorded.some((issue) => issue.code === "layout_unresolved")) {
    return {
      parserId,
      currency,
      scale,
      cells: [],
      issues: recorded.filter((issue) => issue.code === "layout_unresolved"),
    };
  }
  if (
    normalized.length === 0 &&
    !recorded.some(
      (issue) =>
        issue.code === "ambiguous_date" ||
        issue.code === "dropped_amount" ||
        issue.code === "confirm_period_end" ||
        issue.code === "balance_mismatch",
    )
  ) {
    recorded.push({
      code: "zero_extraction",
      message: "No statement or bank values were extracted",
      raw: text.slice(0, 240),
      page: null,
    });
  }
  return { parserId, currency, scale, cells: normalized, issues: recorded };
}

function workbookIssues(workbook: {
  readonly droppedAmounts: readonly DroppedAmount[];
  readonly layoutUnresolved: boolean;
}): BankIssue[] {
  const issues = droppedIssues(workbook.droppedAmounts);
  if (workbook.layoutUnresolved) {
    issues.push({
      code: "layout_unresolved",
      message: "The table layout could not be classified, so nothing was extracted",
      raw: "",
      page: null,
    });
  }
  return issues;
}

function droppedIssues(dropped: readonly DroppedAmount[]): BankIssue[] {
  return dropped.map((item) => ({
    code: "dropped_amount" as const,
    message: `Amount ${item.raw} was not extracted`,
    raw: item.raw,
    page: item.page,
  }));
}

function statementTypeFor(
  label: string,
  fallback: StatementSheet["statementType"],
): "income_statement" | "balance_sheet" {
  const code = mapLineLabel(label)?.accountCode;
  const account = code ? canonicalAccount(code) : undefined;
  if (account?.report === "revenue" || account?.report === "expense") return "income_statement";
  if (account) return "balance_sheet";
  return fallback === "income_statement" ? "income_statement" : "balance_sheet";
}

function workbookToCells(
  workbook: StatementWorkbook,
  sheets: readonly Worksheet[],
  pdfItems: readonly PdfTextItem[] = [],
  documentText = "",
  orgYearEnd: YearEnd | null = null,
  issues: BankIssue[] = [],
  functionalCurrency: string | null = null,
): ParsedCell[] {
  const cells: ParsedCell[] = [];
  const unresolved = new Set<string>();
  const conventions = new Set<string>();
  for (const sheet of workbook.sheets) {
    const source = sheets.find((candidate) => candidate.name === sheet.sheetName);
    const text = source
      ? [sheetText(source), ...(sheets.length === 1 ? [documentText] : [])].join("\n")
      : documentText;
    const scale = detectScale(text);
    const currency = detectCurrency(text, functionalCurrency);
    if (
      detectedScales(text).length > 1 ||
      unknownScale(text) ||
      /\bbillions?\b|\btrillions?\b|\bin hundreds\b|\bbn\b|(?<!百)万円|億円/i.test(text)
    ) {
      issues.push({
        code: "layout_unresolved",
        message: "Conflicting amount scales require confirmation",
        raw: text.slice(0, 240),
        page: null,
      });
      continue;
    }
    const isNativeNumber = (line: StatementLine, value: StatementLine["values"][number]) =>
      source?.cells.some(
        (c) =>
          c.row === line.sheetRow &&
          c.col === sheet.periods.find((p) => p.label === value.period)?.col &&
          c.kind === "number",
      ) ?? false;
    const rawAmounts = sheet.lines
      .flatMap((line) => line.values.filter((value) => !isNativeNumber(line, value)))
      .filter((value) => !/\sDr \/ .* Cr$/.test(value.raw))
      .map((v) => v.raw);
    const convention = numberConvention(rawAmounts, text);
    if (convention === "dot" || convention === "comma") conventions.add(convention);
    const reparsed = new Map(
      rawAmounts.map((raw) => [
        raw,
        /^[-–—]$/.test(raw.trim()) ? "0" : parseMoneyToken(raw, convention),
      ]),
    );
    if (
      conventions.size > 1 ||
      convention === "conflict" ||
      [...reparsed.values()].some((amount) => amount === null)
    ) {
      issues.push({
        code: "layout_unresolved",
        message: "Number convention cannot be established from the document",
        raw: rawAmounts.join(" | "),
        page: null,
      });
      continue;
    }
    const resolved = resolveStatementPeriods(
      sheet.periods.map((p) => p.label),
      sheet.periodContext ?? text,
      orgYearEnd,
    );
    sheet.lines.forEach((line, lineIndex) => {
      const role = statementRole(line.label);
      if (role === "heading") return;
      line.values.forEach((value, valueIndex) => {
        const rawLabel = value.period.trim();
        const period = resolved[sheet.periods.findIndex((p) => p.label === value.period)];
        if (!period || !parseLooseDate(period.periodEnd)) {
          if (rawLabel.length > 0) unresolved.add(rawLabel);
          return;
        }
        const located = locateAmount(value.raw, source, pdfItems);
        cells.push({
          statementType: statementTypeFor(line.label, sheet.statementType),
          role,
          label: line.label,
          sectionId: `s${lineIndex}`,
          ...period,
          amount: isNativeNumber(line, value)
            ? value.amount
            : /\b(?:DR|CR)\s*$/i.test(value.raw)
              ? `${value.amount.startsWith("-") ? "-" : ""}${(reparsed.get(value.raw) ?? value.amount).replace(/^-/, "")}`
              : (reparsed.get(value.raw) ?? value.amount),
          rawText: value.raw,
          page: located.page,
          sheet: sheet.sheetName,
          row: line.sheetRow,
          col: sheet.periods.find((p) => p.label === value.period)?.col ?? valueIndex + 2,
          bbox: located.bbox,
          balanceKind: balanceKind(sheet, line, value.period),
          currency,
          scale,
          txnDate: null,
        });
      });
    });
  }
  for (const raw of unresolved) {
    issues.push({
      code: "confirm_period_end",
      message: "Confirm period end before this column can post",
      raw,
      page: null,
    });
  }
  return cells;
}

function balanceKind(
  sheet: StatementSheet,
  line: StatementLine,
  period: string,
): "closing" | "opening" | "movement" {
  if (sheet.statementType === "income_statement") return "movement";
  if (/opening|beginning/i.test(line.label) || /opening|beginning/i.test(period)) return "opening";
  return "closing";
}

function locateAmount(
  raw: string,
  sheet: Worksheet | undefined,
  pdfItems: readonly PdfTextItem[],
): { page: number | null; bbox: CellBBox | null } {
  if (sheet) return { page: null, bbox: null };
  const item = pdfItems.find((candidate) => candidate.text === raw || candidate.text.includes(raw));
  if (!item || item.y === undefined) return { page: item?.page ?? null, bbox: null };
  const width = item.width ?? 0;
  const height = item.height ?? 0;
  return {
    page: item.page ?? null,
    bbox: { x0: item.x, y0: item.y, x1: item.x + width, y1: item.y + height },
  };
}

function bankCells(
  bank: TabularBank,
  sheet: string,
  currency: string | null,
  scale: AmountScale,
): ParsedCell[] {
  const cells: ParsedCell[] = [];
  if (bank.opening !== null) {
    cells.push({
      statementType: "bank",
      role: "line",
      label: "Opening balance",
      sectionId: "bank",
      periodKey: bank.periodStart,
      periodStart: bank.periodStart,
      periodEnd: bank.periodEnd,
      spanMonths: 1,
      amount: bank.opening,
      rawText: bank.openingRaw,
      page: bank.openingPage,
      sheet,
      row: 1,
      col: 1,
      bbox: bank.openingBBox,
      balanceKind: "opening",
      currency,
      scale,
      txnDate: null,
    });
  }
  if (bank.closing !== null) {
    cells.push({
      statementType: "bank",
      role: "line",
      label: "Closing balance",
      sectionId: "bank",
      periodKey: bank.periodEnd,
      periodStart: bank.periodStart,
      periodEnd: bank.periodEnd,
      spanMonths: 1,
      amount: bank.closing,
      rawText: bank.closingRaw,
      page: bank.closingPage,
      sheet,
      row: 2,
      col: 1,
      bbox: bank.closingBBox,
      balanceKind: "closing",
      currency,
      scale,
      txnDate: null,
    });
  }
  for (const transaction of bank.transactions) {
    cells.push({
      statementType: "bank",
      role: "line",
      label: transaction.description,
      sectionId: "bank",
      periodKey: transaction.date,
      periodStart: bank.periodStart,
      periodEnd: bank.periodEnd,
      spanMonths: 1,
      amount: transaction.amount,
      rawText: transaction.raw,
      page: transaction.page,
      sheet,
      row: transaction.row,
      col: 1,
      bbox: transaction.bbox,
      balanceKind: "movement",
      currency,
      scale,
      txnDate: transaction.date,
    });
  }
  return cells;
}

function looksLikeBank(text: string): boolean {
  const header =
    /\bdate\b/i.test(text) &&
    /withdrawal|deposit|\bdebit\b|\bcredit\b|\bdr\b|\bcr\b|\bamount\b|money out|money in|paid out|paid in/i.test(
      text,
    );
  const narrative = /opening balance/i.test(text) && /closing balance/i.test(text);
  return header || narrative;
}

export function detectCurrency(
  text: string,
  functionalCurrency: string | null = null,
): string | null {
  return currencyEvidence(text, functionalCurrency).currency;
}

export function detectScale(text: string): AmountScale {
  return detectedScales(text)[0] ?? "units";
}

function detectedScales(text: string): AmountScale[] {
  return statementScales(text);
}

function sheetText(sheet: Worksheet, dates = false): string {
  const rows = new Map<number, string[]>();
  for (const cell of sheet.cells) {
    const row = rows.get(cell.row) ?? [];
    row[cell.col - 1] =
      dates && cell.kind === "number" && cell.dateFormat
        ? new Date(
            (cell.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) +
              Number(cell.text) * 86_400_000,
          )
            .toISOString()
            .slice(0, 10)
        : cell.kind === "number"
          ? (excelNumberToDecimal(cell.text) ?? cell.text)
          : cell.text;
    rows.set(cell.row, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row.join("\t"))
    .join("\n");
}

function stripCurrencyMarks(text: string): string {
  return text.replace(/₹/g, "").replace(/\bRs\.?\b/gi, "");
}
