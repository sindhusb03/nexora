import { AnalyticalDecimal } from "@nexora/kernel";

import { findMoneyTokens, parseMoneyToken, numberConvention } from "./decimal-text.js";
import { currencyEvidence } from "./currency.js";
import type { PdfLine } from "./bank-pdf.js";
import { parseGrid } from "./statement-csv.js";

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
    parseGrid(text).map((cells, index) => ({
      page: null,
      row: index + 1,
      text: cells.join(" "),
      cells,
      bbox: null,
    })),
  );
}

export function parseBankSource(lines: readonly SourceLine[]): BankParse {
  const text = lines.map((line) => line.text).join("\n");
  const matrix = parseMatrix(lines, text);
  if (matrix && (matrix.bank || matrix.issues.length > 0)) return matrix;
  // Numeric column order alone cannot establish debit, credit, or balance.
  return parseNarrative(lines, text);
}

export function decimalAmount(value: string): string | null {
  return findMoneyTokens(value)[0]?.amount ?? null;
}

function sourceFromText(text: string, row: number, page: number | null): SourceLine {
  return { page, row, text: text.trim(), cells: splitCsv(text), bbox: null };
}

function alignPdfBank(lines: readonly PdfLine[]): SourceLine[] {
  // PDF text runs may split a single heading into "Withdrawal" and "(Dr)".
  lines = lines.map((line) => {
    const items: PdfLine["items"][number][] = [];
    for (const item of line.items) {
      if (!item.text.trim()) continue;
      const previous = items.at(-1);
      const gap = previous ? item.x - previous.x - (previous.width ?? 0) : Infinity;
      const role = columnRole(item.text);
      const priorRole = previous ? columnRole(previous.text) : "unknown";
      if (
        previous &&
        gap >= 0 &&
        gap <= 14 &&
        previous.width !== undefined &&
        ((role === priorRole && role !== "unknown" && role !== "note") ||
          (priorRole === "unknown" && role !== "unknown" && role !== "note") ||
          /^(?:date|\(?dr\)?|\(?cr\)?|out|in)$/i.test(item.text.trim())) &&
        !findMoneyTokens(previous.text).length &&
        !findMoneyTokens(item.text).length
      ) {
        items[items.length - 1] = {
          ...previous,
          text: `${previous.text} ${item.text}`,
          width: item.x + (item.width ?? 0) - previous.x,
        };
      } else items.push(item);
    }
    return { ...line, items };
  });
  const header = lines.find((line) =>
    isHeader(line.items.map((item) => item.text).filter((text) => text.trim().length > 0)),
  );
  if (!header) return lines.map((line, index) => sourceFromPdf(line, index + 1));
  const columns = header.items
    .filter((item) => item.text.trim().length > 0)
    .map((item) => ({ x: item.x, right: item.x + (item.width ?? 0), text: item.text.trim() }));
  return lines.map((line, index) => {
    const cells = columns.map(() => "");
    for (const item of line.items) {
      const text = item.text.trim();
      if (text.length === 0) continue;
      let best = -1;
      let distance = 48;
      columns.forEach((column, columnIndex) => {
        const gap = Math.min(
          Math.abs(column.x - item.x),
          Math.abs(column.right - item.x - (item.width ?? 0)),
        );
        if (gap < distance) {
          distance = gap;
          best = columnIndex;
        }
      });
      if (best >= 0) cells[best] = [cells[best], text].filter(Boolean).join(" ");
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

function parseMatrix(lines: readonly SourceLine[], text: string): BankParse | null {
  const headerIndex = lines.findIndex((line) => isHeader(line.cells));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex]?.cells ?? [];
  const roles = header.map(columnRole);
  if (
    ["amount", "debit", "credit", "balance", "sign", "fee", "posting_date", "value_date"].some(
      (r) => roles.filter((role) => role === r).length > 1,
    )
  ) {
    return {
      bank: null,
      issues: [
        {
          code: "layout_unresolved",
          message: "Duplicate bank amount or direction columns require confirmation",
          raw: header.join(" "),
          page: null,
        },
      ],
    };
  }
  const hasDate = roles.some((r) => r === "date" || r === "value_date" || r === "posting_date");
  const hasFlow = roles.includes("debit") || roles.includes("credit") || roles.includes("amount");
  const classified = roles.map((role) =>
    role === "unknown" && hasDate && hasFlow ? "note" : role,
  );
  const postingDate = classified.findIndex((role) => role === "posting_date");
  const valueDate = classified.findIndex((role) => role === "value_date");
  const genericDate = classified.findIndex((role) => role === "date");
  const dateCol = postingDate >= 0 ? postingDate : valueDate >= 0 ? valueDate : genericDate;
  const narrationCol = classified.findIndex((role) => role === "narration");
  const withdrawalCol = classified.findIndex((role) => role === "debit");
  const depositCol = classified.findIndex((role) => role === "credit");
  const amountCol = classified.findIndex((role) => role === "amount");
  const balanceCol = classified.findIndex((role) => role === "balance");
  const signCol = classified.findIndex((role) => role === "sign");
  const feeCol = classified.findIndex((role) => role === "fee");
  const currencyCol = classified.findIndex((role) => role === "currency");
  const accountCurrency = currencyOf(text);
  const rowCurrencies =
    currencyCol < 0
      ? []
      : lines
          .slice(headerIndex + 1)
          .filter((line) => !isHeader(line.cells))
          .map((line) => line.cells[currencyCol]?.trim() ?? "")
          .filter(Boolean);
  const currencies = new Set(rowCurrencies.map((raw) => currencyEvidence(raw).currency));
  if (accountCurrency) currencies.add(accountCurrency);
  if (
    currencies.size > 1 ||
    currencies.has(null) ||
    rowCurrencies.some((raw) => currencyEvidence(raw).conflict)
  ) {
    return {
      bank: null,
      issues: [
        {
          code: "layout_unresolved",
          message: "Account and row currencies conflict or are unresolved",
          raw: rowCurrencies.join(" | "),
          page: null,
        },
      ],
    };
  }
  const currency = [...currencies][0] ?? accountCurrency;
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
  const moneyCols = roles.flatMap((role, index) =>
    ["amount", "debit", "credit", "balance", "fee"].includes(role) ? [index] : [],
  );
  const tokens = lines
    .slice(headerIndex + 1)
    .filter((line) => !isHeader(line.cells))
    .flatMap((line) => moneyCols.map((col) => line.cells[col] ?? ""))
    .filter((t) => t.trim() && !/^[-–—]$/.test(t));
  const convention = numberConvention(
    tokens,
    lines
      .slice(0, headerIndex)
      .map((l) => l.text)
      .join("\n"),
  );
  if (convention === "conflict" || tokens.some((t) => parseMoneyToken(t, convention) === null)) {
    return {
      bank: null,
      issues: [
        {
          code: "layout_unresolved",
          message: "Bank number convention or amount is unresolved",
          raw: tokens.join(" | "),
          page: null,
        },
      ],
    };
  }
  const money = (raw: string) => parseMoneyToken(raw, convention);
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
    if (isHeader(line.cells)) continue;
    const cells = line.cells;
    const dateToken = cells[dateCol]?.trim() ?? "";
    const narration = (cells[narrationCol] ?? "").trim();
    if (/^(?:grand\s+)?total(?:s|\s|$)/i.test(narration)) continue;
    const resolved = dateToken ? resolveDate(dateToken, locale) : null;
    if (resolved === "ambiguous") {
      issues.push({
        code: "ambiguous_date",
        message: `Date ${dateToken} is ambiguous without a locale`,
        raw: line.text,
        page: line.page,
      });
      continue;
    }
    const balance = balanceCol >= 0 ? money(cells[balanceCol] ?? "") : null;
    const withdrawal = withdrawalCol >= 0 ? money(cells[withdrawalCol] ?? "") : null;
    const deposit = depositCol >= 0 ? money(cells[depositCol] ?? "") : null;
    const unsigned =
      amountCol >= 0 ? money(cells[amountCol] ?? "") : signedFlow(withdrawal, deposit);
    let amount = unsigned && signCol >= 0 ? applyDrCr(unsigned, cells[signCol] ?? "") : unsigned;
    const fee = feeCol >= 0 ? money(cells[feeCol] ?? "") : null;
    if (amount && fee !== null) {
      if (new AnalyticalDecimal(fee).isNegative() || /\bnet\b/i.test(header[amountCol] ?? "")) {
        issues.push({
          code: "dropped_amount",
          message: "Fee sign or net inclusion needs confirmation",
          raw: line.text,
          page: line.page,
        });
        continue;
      }
      amount = new AnalyticalDecimal(amount).sub(fee).toFixed();
    }
    if (
      /opening|beginning|balance\s+(?:brought\s+forward|b\/?f)/i.test(narration || dateToken) &&
      balance
    ) {
      opening = balance;
      openingRaw = line.text;
      openingPage = line.page;
      openingBBox = line.bbox;
      running = new AnalyticalDecimal(balance);
      if (resolved) dates.push(resolved);
      continue;
    }
    if (/closing|ending/i.test(narration) && balance) {
      closing = balance;
      closingRaw = line.text;
      closingPage = line.page;
      closingBBox = line.bbox;
      if (resolved) dates.push(resolved);
      continue;
    }
    if (!resolved) {
      if (amount)
        issues.push({
          code: "ambiguous_date",
          message: "A flow has no valid posting date",
          raw: line.text,
          page: line.page,
        });
      continue;
    }
    if (!amount) {
      if (unsigned && signCol >= 0)
        issues.push({
          code: "dropped_amount",
          message: "Unknown transaction direction",
          raw: line.text,
          page: line.page,
        });
      continue;
    }
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
  if (
    opening === null ||
    closing === null ||
    !new AnalyticalDecimal(opening).add(sumAmounts(transactions)).eq(closing)
  ) {
    issues.push({
      code: "balance_mismatch",
      message:
        "Bank requires independently stated opening and closing balances that reconcile with transactions",
      raw: closingRaw,
      page: closingPage,
    });
  }
  const periodStart = dates.slice().sort()[0];
  const periodEnd = dates.slice().sort().at(-1);
  if (!periodStart || !periodEnd) return { bank: null, issues };
  if (transactions.length === 0 && (!opening || !closing)) return { bank: null, issues };
  return {
    bank: {
      periodStart,
      periodEnd,
      currency,
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
      const amount = parseMoneyToken(openingMatch[1]);
      if (amount !== null) {
        opening = amount;
        openingRaw = line.text;
        openingPage = line.page;
        openingBBox = line.bbox;
        continue;
      }
    }
    const closingMatch = /closing balance\s+(.+)$/i.exec(line.text);
    if (closingMatch?.[1]) {
      const amount = parseMoneyToken(closingMatch[1]);
      if (amount !== null) {
        closing = amount;
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
    if (!resolved) continue;
    if (tokens.length !== 1) {
      issues.push({
        code: "dropped_amount",
        message: "Narrative transaction amount is ambiguous",
        raw: line.text,
        page: line.page,
      });
      continue;
    }
    const amount = tokens[0];
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
  if (!new AnalyticalDecimal(opening).add(sumAmounts(transactions)).eq(closing))
    issues.push({
      code: "balance_mismatch",
      message: "Narrative bank balances do not reconcile",
      raw: closingRaw,
      page: closingPage,
    });
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
  if (isoPrefix?.[1]) {
    const [year, month, day] = isoPrefix[1].split("-");
    return iso(year!, Number(month), Number(day));
  }
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
  | "posting_date"
  | "narration"
  | "debit"
  | "credit"
  | "amount"
  | "balance"
  | "sign"
  | "fee"
  | "currency"
  | "note"
  | "unknown" {
  const text = cell
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (text.length === 0) return "note";
  if (/^(?:currency|ccy|curr|account currency)$/.test(text)) return "currency";
  if (/^(dr cr|cr dr|direction|credit debit indicator|transaction type)$/.test(text)) return "sign";
  if (/\b(?:completed|completion|booked|booking|posting|posted)\b/.test(text))
    return "posting_date";
  if (/\bvalue date\b/.test(text)) return "value_date";
  if (/\b(?:started|created|initiated|authori[sz]ed)\b/.test(text)) return "note";
  if (/\bdate\b/.test(text)) return "date";
  if (/\b(?:fee|fees|charges?|commission)\b/.test(text)) return "fee";
  if (
    /\b(narration|narrative|description|particulars|particular|details|payee|beneficiary|remarks)\b/.test(
      text,
    )
  ) {
    return "narration";
  }
  if (/\b(balance|bal)\b/.test(text)) return "balance";
  if (/\bamount\b/.test(text) && /\bdr\b.*\bcr\b|\bcr\b.*\bdr\b/.test(text)) return "amount";
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

function applyDrCr(amount: string, sign: string): string | null {
  const token = sign.trim().toLowerCase();
  if (/^(dr|debit|withdrawal)$/.test(token)) {
    return amount.startsWith("-") ? amount : `-${amount}`;
  }
  if (/^(cr|credit|deposit)$/.test(token)) return amount.replace(/^-/, "");
  return null;
}

function iso(year: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (new Date(Date.UTC(Number(year), month - 1, day)).getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isHeader(cells: readonly string[]): boolean {
  const roles = cells.map(columnRole);
  const hasDate = roles.some((r) => r === "date" || r === "value_date" || r === "posting_date");
  const hasFlow = roles.includes("debit") || roles.includes("credit") || roles.includes("amount");
  return hasDate && hasFlow;
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

function currencyOf(text: string): string | null {
  return currencyEvidence(text).currency;
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
