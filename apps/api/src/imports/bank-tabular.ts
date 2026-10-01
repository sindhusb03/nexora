import { AnalyticalDecimal } from "@nexora/kernel";

import { findMoneyTokens, parseMoneyToken } from "./decimal-text.js";
import type { PdfLine } from "./bank-pdf.js";

export interface TabularBankTransaction {
  readonly date: string;
  readonly description: string;
  readonly amount: string;
  readonly raw: string;
  readonly page: number | null;
  readonly row: number | null;
  readonly bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface BankIssue {
  readonly code:
    | "ambiguous_date"
    | "dropped_amount"
    | "zero_extraction"
    | "layout_unresolved"
    | "confirm_period_end"
    | "balance_mismatch";
  readonly message: string;
  readonly raw: string;
  readonly page: number | null;
}

export interface TabularBank {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string | null;
  readonly opening: string | null;
  readonly closing: string | null;
  readonly openingRaw: string;
  readonly closingRaw: string;
  readonly openingPage: number | null;
  readonly closingPage: number | null;
  readonly openingBBox: TabularBankTransaction["bbox"];
  readonly closingBBox: TabularBankTransaction["bbox"];
  readonly transactions: readonly TabularBankTransaction[];
  readonly issues: readonly BankIssue[];
}

interface SourceLine {
  readonly page: number | null;
  readonly row: number | null;
  readonly text: string;
  readonly cells: readonly string[];
  readonly bbox: TabularBankTransaction["bbox"];
}

export interface BankParse {
  readonly bank: TabularBank | null;
  readonly issues: readonly BankIssue[];
}

export function parseTabularBankText(lines: readonly string[]): TabularBank | null {
  return parseBankSource(lines.map((text, index) => sourceFromText(text, index + 1, null))).bank;
}

export function parseTabularBankPdf(lines: readonly PdfLine[]): TabularBank | null {
  return parseBankPdfLines(lines).bank;
}

export function parseBankPdfLines(lines: readonly PdfLine[]): BankParse {
  return parseBankSource(alignPdfBank(lines));
}

export function parseBankText(text: string): BankParse {
  return parseBankSource(
    text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line, index) => sourceFromText(line, index + 1, null)),
  );
}

export function parseBankSource(lines: readonly SourceLine[]): BankParse {
  const text = lines.map((line) => line.text).join("\n");
  const matrix = parseMatrix(lines, text);
  if (matrix && (matrix.bank || matrix.issues.length > 0)) return matrix;
  const inferred = inferMatrix(lines);
  if (inferred && (inferred.bank || inferred.issues.length > 0)) return inferred;
  return parseNarrative(lines, text);
}

export function decimalAmount(value: string): string | null {
  return findMoneyTokens(value)[0]?.amount ?? null;
}

function sourceFromText(text: string, row: number, page: number | null): SourceLine {
  return { page, row, text: text.trim(), cells: splitCsv(text), bbox: null };
}

function alignPdfBank(lines: readonly PdfLine[]): SourceLine[] {
  const header = lines.find((line) =>
    isHeader(line.items.map((item) => item.text).filter((text) => text.trim().length > 0)),
  );
  if (!header) return lines.map((line, index) => sourceFromPdf(line, index + 1));
  const columns = header.items
    .filter((item) => item.text.trim().length > 0)
    .map((item) => ({ x: item.x, text: item.text.trim() }));
  return lines.map((line, index) => {
    const cells = columns.map(() => "");
    for (const item of line.items) {
      const text = item.text.trim();
      if (text.length === 0) continue;
      let best = -1;
      let distance = 48;
      columns.forEach((column, columnIndex) => {
        const gap = Math.abs(column.x - item.x);
        if (gap < distance) {
          distance = gap;
          best = columnIndex;
        }
      });
      if (best >= 0) cells[best] = text;
    }
    return {
      page: line.page ?? null,
      row: index + 1,
      text: line.items
        .map((item) => item.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      cells,
      bbox: amountBBox(line),
    };
  });
}

function amountBBox(line: PdfLine): SourceLine["bbox"] {
  const amountItem = [...line.items]
    .reverse()
    .find((item) => findMoneyTokens(item.text).length > 0);
  const anchor = amountItem ?? line.items[0];
  if (!anchor || anchor.y === undefined) return null;
  return {
    x0: anchor.x,
    y0: anchor.y,
    x1: anchor.x + (anchor.width ?? 0),
    y1: anchor.y + (anchor.height ?? 0),
  };
}

function sourceFromPdf(line: PdfLine, row: number): SourceLine {
  const cells =
    line.items.length > 1 ? line.items.map((item) => item.text) : splitCsv(lineText(line));
  const amountItem = [...line.items]
    .reverse()
    .find((item) => findMoneyTokens(item.text).length > 0);
  const anchor = amountItem ?? line.items[0];
  const bbox =
    anchor && anchor.y !== undefined
      ? {
          x0: anchor.x,
          y0: anchor.y,
          x1: anchor.x + (anchor.width ?? 0),
          y1: anchor.y + (anchor.height ?? 0),
        }
      : null;
  return { page: line.page, row, text: lineText(line), cells, bbox };
}

function lineText(line: PdfLine): string {
  return line.items
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferMatrix(lines: readonly SourceLine[]): BankParse | null {
  const body = lines.filter((line) =>
    line.cells.some((cell) =>
      /^(\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{4}-\d{2}-\d{2})$/.test(cell.trim()),
    ),
  );
  if (body.length === 0) return null;
  const width = Math.max(...body.map((line) => line.cells.length));
  const roles = Array.from({ length: width }, (_, index) => relaxRole("unknown", index, body));
  if (!roles.includes("date")) return null;
  const amountIndexes = roles.flatMap((role, index) => (role === "amount" ? [index] : []));
  if (amountIndexes.length === 0) return null;
  const header = roles.map((role, index) => {
    if (role === "date") return "Date";
    if (role === "narration") return "Description";
    if (role !== "amount") return "Note";
    if (amountIndexes.length >= 3 && index === amountIndexes[0]) return "Debit";
    if (amountIndexes.length >= 3 && index === amountIndexes[1]) return "Credit";
    if (amountIndexes.length >= 2 && index === amountIndexes[amountIndexes.length - 1])
      return "Balance";
    return "Amount";
  });
  return parseMatrix(
    [{ page: null, row: 0, text: header.join(","), cells: header, bbox: null }, ...body],
    body.map((line) => line.text).join("\n"),
  );
}

function parseMatrix(lines: readonly SourceLine[], text: string): BankParse | null {
  const headerIndex = lines.findIndex((line) => isHeader(line.cells));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex]?.cells ?? [];
  const roles = header.map(columnRole);
  const hasDate = roles.includes("date") || roles.includes("value_date");
  const hasFlow = roles.includes("debit") || roles.includes("credit") || roles.includes("amount");
  const classified = roles.map((role) =>
    role === "unknown" && hasDate && hasFlow ? "note" : role,
  );
  const postingDate = classified.findIndex((role) => role === "date");
  const valueDate = classified.findIndex((role) => role === "value_date");
  const dateCol = postingDate >= 0 ? postingDate : valueDate;
  const narrationCol = classified.findIndex((role) => role === "narration");
  const withdrawalCol = classified.findIndex((role) => role === "debit");
  const depositCol = classified.findIndex((role) => role === "credit");
  const amountCol = classified.findIndex((role) => role === "amount");
  const balanceCol = classified.findIndex((role) => role === "balance");
  const signCol = classified.findIndex((role) => role === "sign");
  if (dateCol < 0 || (amountCol < 0 && withdrawalCol < 0 && depositCol < 0)) {
    if (roles.some((role) => role === "unknown")) {
      return {
        bank: null,
        issues: [
          {
            code: "layout_unresolved",
            message: "Bank columns could not be classified, so nothing was extracted",
            raw: header.join(","),
            page: lines[headerIndex]?.page ?? null,
          },
        ],
      };
    }
    return null;
  }
  const dateTokens = lines
    .slice(headerIndex + 1)
    .map((line) => line.cells[dateCol]?.trim() ?? "")
    .filter((token) => token.length > 0);
  const locale = inferDateLocale(dateTokens);
  const issues: BankIssue[] = [];
  const transactions: TabularBankTransaction[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  let openingRaw = "";
  let closingRaw = "";
  let openingPage: number | null = null;
  let closingPage: number | null = null;
  let openingBBox: TabularBankTransaction["bbox"] = null;
  let closingBBox: TabularBankTransaction["bbox"] = null;
  const dates: string[] = [];
  let running: InstanceType<typeof AnalyticalDecimal> | null = null;
  let balanceBroken = false;
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.cells;
    const dateToken = cells[dateCol]?.trim() ?? "";
    if (!dateToken) continue;
    const resolved = resolveDate(dateToken, locale);
    if (resolved === "ambiguous") {
      issues.push({
        code: "ambiguous_date",
        message: `Date ${dateToken} is ambiguous without a locale`,
        raw: line.text,
        page: line.page,
      });
      continue;
    }
    if (!resolved) continue;
    const narration = (cells[narrationCol] ?? "").trim();
    const balance = balanceCol >= 0 ? moneyCell(cells[balanceCol] ?? "") : null;
    const withdrawal = withdrawalCol >= 0 ? moneyCell(cells[withdrawalCol] ?? "") : null;
    const deposit = depositCol >= 0 ? moneyCell(cells[depositCol] ?? "") : null;
    const unsigned =
      amountCol >= 0 ? moneyCell(cells[amountCol] ?? "") : signedFlow(withdrawal, deposit);
    const amount = unsigned && signCol >= 0 ? applyDrCr(unsigned, cells[signCol] ?? "") : unsigned;
    if (/opening|beginning/i.test(narration) && balance) {
      opening = balance;
      openingRaw = line.text;
      openingPage = line.page;
      openingBBox = line.bbox;
      running = new AnalyticalDecimal(balance);
      dates.push(resolved);
      continue;
    }
    if (/closing|ending/i.test(narration) && balance) {
      closing = balance;
      closingRaw = line.text;
      closingPage = line.page;
      closingBBox = line.bbox;
      dates.push(resolved);
      continue;
    }
    if (!amount) continue;
    if (running && balance && !balanceBroken) {
      const next = running.add(amount);
      if (!next.eq(new AnalyticalDecimal(balance))) {
        balanceBroken = true;
        issues.push({
          code: "balance_mismatch",
          message: "Running balance does not roll forward from the prior row",
          raw: line.text,
          page: line.page,
        });
      }
      running = next;
    } else if (running) {
      running = running.add(amount);
    }
    if (balance) {
      closing = balance;
      closingRaw = line.text;
      closingPage = line.page;
      closingBBox = line.bbox;
    }
    dates.push(resolved);
    transactions.push({
      date: resolved,
      description: narration || "Transaction",
      amount,
      raw: line.text,
      page: line.page,
      row: line.row,
      bbox: line.bbox,
    });
  }
  if (!opening && transactions[0] && closing) {
    const first = transactions[0];
    opening = subtract(closingFrom(transactions, closing), sumAmounts(transactions));
    openingRaw = first.raw;
    openingPage = first.page;
    openingBBox = first.bbox;
  }
  const periodStart = dates.slice().sort()[0];
  const periodEnd = dates.slice().sort().at(-1);
  if (!periodStart || !periodEnd) return { bank: null, issues };
  if (transactions.length === 0 && (!opening || !closing)) return { bank: null, issues };
  return {
    bank: {
      periodStart,
      periodEnd,
      currency: currencyOf(text),
      opening,
      closing,
      openingRaw,
      closingRaw,
      openingPage,
      closingPage,
      openingBBox,
      closingBBox,
      transactions,
      issues,
    },
    issues,
  };
}

function parseNarrative(lines: readonly SourceLine[], text: string): BankParse {
  if (!/opening balance/i.test(text) || !/closing balance/i.test(text)) {
    return { bank: null, issues: [] };
  }
  const period = /period\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through)\s+(\d{4}-\d{2}-\d{2})/i.exec(text);
  const locale = inferDateLocale(
    lines
      .map((line) => /^(\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{4}-\d{2}-\d{2})/.exec(line.text)?.[1] ?? "")
      .filter((token) => token.length > 0),
  );
  const issues: BankIssue[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  let openingRaw = "";
  let closingRaw = "";
  let openingPage: number | null = null;
  let closingPage: number | null = null;
  let openingBBox: TabularBankTransaction["bbox"] = null;
  let closingBBox: TabularBankTransaction["bbox"] = null;
  const transactions: TabularBankTransaction[] = [];
  for (const line of lines) {
    const openingMatch = /opening balance\s+(.+)$/i.exec(line.text);
    if (openingMatch?.[1]) {
      const amount = findMoneyTokens(openingMatch[1])[0];
      if (amount) {
        opening = amount.amount;
        openingRaw = line.text;
        openingPage = line.page;
        openingBBox = line.bbox;
        continue;
      }
    }
    const closingMatch = /closing balance\s+(.+)$/i.exec(line.text);
    if (closingMatch?.[1]) {
      const amount = findMoneyTokens(closingMatch[1])[0];
      if (amount) {
        closing = amount.amount;
        closingRaw = line.text;
        closingPage = line.page;
        closingBBox = line.bbox;
        continue;
      }
    }
    const txn = /^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+(.+)$/.exec(line.text.trim());
    if (!txn) continue;
    const resolved = resolveDate(txn[1] ?? "", locale);
    if (resolved === "ambiguous") {
      issues.push({
        code: "ambiguous_date",
        message: `Date ${txn[1] ?? ""} is ambiguous without a locale`,
        raw: line.text,
        page: line.page,
      });
      continue;
    }
    const tokens = findMoneyTokens(txn[2] ?? "");
    if (!resolved || tokens.length === 0) continue;
    const amount = tokens.length >= 2 ? tokens[tokens.length - 2] : tokens[0];
    if (!amount) continue;
    transactions.push({
      date: resolved,
      description: (txn[2] ?? "").replace(amount.raw, "").trim() || "Transaction",
      amount: amount.amount,
      raw: line.text.trim(),
      page: line.page,
      row: line.row,
      bbox: line.bbox,
    });
  }
  if (!opening || !closing || !period?.[1] || !period[2]) return { bank: null, issues };
  return {
    bank: {
      periodStart: period[1],
      periodEnd: period[2],
      currency: currencyOf(text),
      opening,
      closing,
      openingRaw,
      closingRaw,
      openingPage,
      closingPage,
      openingBBox,
      closingBBox,
      transactions,
      issues,
    },
    issues,
  };
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function resolveDate(
  value: string,
  locale: "DMY" | "MDY" | "unknown",
): string | "ambiguous" | null {
  const trimmed = value.trim();
  const isoPrefix = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(trimmed);
  if (isoPrefix?.[1]) return isoPrefix[1];
  const named = namedDate(trimmed);
  if (named) return named;
  const parts = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(trimmed);
  if (!parts?.[1] || !parts[2] || !parts[3]) return null;
  const year = expandYear(parts[3]);
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  if (first > 12 && second <= 12) return iso(year, second, first);
  if (second > 12 && first <= 12) return iso(year, first, second);
  if (first > 12 || second > 12) return null;
  if (locale === "DMY") return iso(year, second, first);
  if (locale === "MDY") return iso(year, first, second);
  return "ambiguous";
}

function expandYear(year: string): string {
  if (year.length === 4) return year;
  const value = Number(year);
  return String(value <= 69 ? 2000 + value : 1900 + value);
}

function namedDate(value: string): string | null {
  const dayFirst = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]?(\d{2,4})$/.exec(value);
  if (dayFirst?.[1] && dayFirst[2] && dayFirst[3]) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (month) return iso(expandYear(dayFirst[3]), month, Number(dayFirst[1]));
  }
  const monthFirst = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(value);
  if (monthFirst?.[1] && monthFirst[2] && monthFirst[3]) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month) return iso(expandYear(monthFirst[3]), month, Number(monthFirst[2]));
  }
  return null;
}

export function inferDateLocale(values: readonly string[]): "DMY" | "MDY" | "unknown" {
  let dayFirst = false;
  let monthFirst = false;
  for (const value of values) {
    const parts = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(value.trim());
    if (!parts?.[1] || !parts[2]) continue;
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    if (first > 12 && second <= 12) dayFirst = true;
    if (second > 12 && first <= 12) monthFirst = true;
  }
  if (dayFirst && !monthFirst) return "DMY";
  if (monthFirst && !dayFirst) return "MDY";
  return "unknown";
}

function columnRole(
  cell: string,
):
  | "date"
  | "value_date"
  | "narration"
  | "debit"
  | "credit"
  | "amount"
  | "balance"
  | "sign"
  | "note"
  | "unknown" {
  const text = cell
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (text.length === 0) return "note";
  if (text === "dr cr" || text === "cr dr") return "sign";
  if (/\bvalue date\b/.test(text)) return "value_date";
  if (/\bdate\b/.test(text)) return "date";
  if (
    /\b(narration|narrative|description|particulars|particular|details|payee|beneficiary|remarks)\b/.test(
      text,
    )
  ) {
    return "narration";
  }
  if (/\b(withdrawal|withdrawals|debit|money out|paid out|dr)\b/.test(text)) {
    return "debit";
  }
  if (/\b(deposit|deposits|credit|money in|paid in|cr)\b/.test(text) && !/\blimit\b/.test(text)) {
    return "credit";
  }
  if (/\bamount\b/.test(text)) return "amount";
  if (/\b(balance|running bal|running balance)\b/.test(text)) return "balance";
  if (/\b(cheque|chq|note|notes|ref|reference|utr|branch)\b/.test(text)) return "note";
  return "unknown";
}

function looksLikeDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value) ||
    /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(value) ||
    /^\d{1,2}[-\s][A-Za-z]{3,9}[-\s,]?\d{2,4}$/.test(value) ||
    /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}$/.test(value)
  );
}

function relaxRole(
  role: ReturnType<typeof columnRole>,
  index: number,
  body: readonly SourceLine[],
): ReturnType<typeof columnRole> {
  if (role !== "unknown") return role;
  const values = body
    .map((line) => line.cells[index]?.trim() ?? "")
    .filter((value) => value.length > 0);
  if (values.length === 0) return "note";
  const dates = values.filter((value) => looksLikeDate(value));
  if (dates.length >= Math.ceil(values.length * 0.6)) return "date";
  const amounts = values.filter((value) => moneyCell(value) !== null);
  if (amounts.length >= Math.ceil(values.length * 0.6)) return "amount";
  return "narration";
}

function applyDrCr(amount: string, sign: string): string {
  const token = sign.trim().toLowerCase();
  if (/^(dr|debit|withdrawal)$/.test(token)) {
    return amount.startsWith("-") ? amount : `-${amount}`;
  }
  if (/^(cr|credit|deposit)$/.test(token)) return amount.replace(/^-/, "");
  return amount;
}

function iso(year: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isHeader(cells: readonly string[]): boolean {
  const roles = cells.map(columnRole);
  const hasDate = roles.includes("date") || roles.includes("value_date");
  const hasFlow = roles.includes("debit") || roles.includes("credit") || roles.includes("amount");
  return hasDate && hasFlow;
}

function moneyCell(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "—") return null;
  return parseMoneyToken(trimmed);
}

function signedFlow(withdrawal: string | null, deposit: string | null): string | null {
  if (deposit && withdrawal) return subtract(deposit, withdrawal);
  if (deposit) return deposit;
  if (withdrawal) return withdrawal.startsWith("-") ? withdrawal : `-${withdrawal}`;
  return null;
}

function subtract(left: string, right: string): string {
  return new AnalyticalDecimal(left).sub(right).toFixed();
}

function sumAmounts(transactions: readonly TabularBankTransaction[]): string {
  return transactions.reduce((sum, txn) => sum.add(txn.amount), new AnalyticalDecimal(0)).toFixed();
}

function closingFrom(transactions: readonly TabularBankTransaction[], closing: string): string {
  void transactions;
  return closing;
}

function currencyOf(text: string): string | null {
  if (/₹|\bINR\b|\bRs\.?\b/i.test(text)) return "INR";
  if (/\bUSD\b/.test(text)) return "USD";
  return null;
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
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
    if (char === ",") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
