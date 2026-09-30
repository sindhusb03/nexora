import { getDocumentProxy } from "unpdf";

import { isPrintedAmount, printedAmountToDecimal } from "./decimal-text.js";

export interface PdfTextItem {
  readonly x: number;
  readonly text: string;
}

export interface PdfLine {
  readonly page: number;
  readonly y: number;
  readonly items: readonly PdfTextItem[];
}

export interface PdfText {
  readonly pages: number;
  readonly lines: readonly PdfLine[];
  readonly textItems: number;
}

export class PdfReadError extends Error {
  override readonly name = "PdfReadError";
}

/** Items within this vertical distance share a printed line. Wrapped description lines sit about 8 units apart. */
const LINE_TOLERANCE = 2;

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new PdfReadError("The file is not a readable PDF");
  }
  const lines: PdfLine[] = [];
  let textItems = 0;
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const items: { x: number; y: number; text: string }[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = item.str.replace(/\s+/g, " ").trim();
      if (text.length === 0) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      if (typeof x !== "number" || typeof y !== "number") continue;
      items.push({ x, y, text });
    }
    textItems += items.length;
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let current: { y: number; items: PdfTextItem[] } | null = null;
    for (const item of items) {
      if (!current || Math.abs(current.y - item.y) > LINE_TOLERANCE) {
        if (current)
          lines.push({
            page: pageNo,
            y: current.y,
            items: current.items.sort((a, b) => a.x - b.x),
          });
        current = { y: item.y, items: [] };
      }
      current.items.push({ x: item.x, text: item.text });
    }
    if (current)
      lines.push({ page: pageNo, y: current.y, items: current.items.sort((a, b) => a.x - b.x) });
  }
  await pdf.cleanup();
  return { pages: pdf.numPages, lines, textItems };
}

export type BankSign = "credit" | "debit" | "marked";
export type BankGroup = "deposits" | "withdrawals" | "miscellaneous" | "fees" | "transfers";

export interface BankRow {
  readonly rowNo: number;
  readonly date: string;
  readonly description: string;
  readonly reference: string | null;
  /** Signed decimal string: credits positive, debits negative, exactly as printed. */
  readonly amount: string;
  readonly section: string;
  readonly page: number;
}

/** A printed "NN Total de …" line compared with the rows read under the same heading. */
export interface BankTotalCheck {
  readonly label: string;
  readonly printedCount: number;
  readonly printedAmount: string;
  readonly parsedCount: number;
  readonly parsedAmount: string;
  readonly matches: boolean;
}

export interface BankStatement {
  readonly layout: "banco-popular-es";
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly accountNumber: string | null;
  readonly rows: readonly BankRow[];
  readonly skipped: readonly {
    readonly page: number;
    readonly text: string;
    readonly reason: string;
  }[];
  readonly totalChecks: readonly BankTotalCheck[];
}

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

interface Section {
  readonly pattern: RegExp;
  readonly name: string;
  readonly sign: BankSign;
  readonly group: BankGroup;
  readonly checks?: true;
}

const SECTIONS: readonly Section[] = [
  { pattern: /^dep[oó]sitos$/i, name: "Depósitos", sign: "credit", group: "deposits" },
  {
    pattern: /^hojas de dep[oó]sito$/i,
    name: "Hojas de depósito",
    sign: "credit",
    group: "deposits",
  },
  { pattern: /^otros cr[eé]ditos$/i, name: "Otros créditos", sign: "credit", group: "deposits" },
  { pattern: /^retiros$/i, name: "Retiros", sign: "debit", group: "withdrawals" },
  {
    pattern: /^cheques pagados$/i,
    name: "Cheques pagados",
    sign: "debit",
    group: "withdrawals",
    checks: true,
  },
  { pattern: /^otros d[eé]bitos$/i, name: "Otros débitos", sign: "debit", group: "withdrawals" },
  {
    pattern: /^cr[eé]ditos y d[eé]bitos miscel[aá]neos$/i,
    name: "Créditos y débitos misceláneos",
    sign: "marked",
    group: "miscellaneous",
  },
  {
    pattern: /^cargos por servicios$/i,
    name: "Cargos por servicios",
    sign: "debit",
    group: "fees",
  },
  {
    pattern: /^transferencias internas a /i,
    name: "Transferencias internas (entrada)",
    sign: "credit",
    group: "transfers",
  },
  {
    pattern: /^transferencias internas de /i,
    name: "Transferencias internas (salida)",
    sign: "debit",
    group: "transfers",
  },
];

/** Single words that print on their own line inside a table header or as an account caption, not as a new heading. */
const HEADER_FRAGMENTS = /^(efectividad|cheque)$/i;
const FOOTER = /^ADS\w*-\d{1,2}\/\d{1,2}\/\d{2}-\d+$/;
const PRINTED_TOTAL = /^(\d{1,3}) (total de .+|cheques pagados)$/i;
const TOTAL_GROUPS: readonly { readonly pattern: RegExp; readonly group: BankGroup }[] = [
  { pattern: /^total de dep[oó]sitos$/i, group: "deposits" },
  { pattern: /^total de retiros$/i, group: "withdrawals" },
];

const DATE_COLUMN_MAX_X = 90;
/** Headings print flush left at about x=50; indented single lines are notes inside a section. */
const HEADING_MAX_X = 60;
const AMOUNT_COLUMN_MIN_X = 350;
const REFERENCE_COLUMN_MAX_X = 185;
const CONTINUATION_MIN_X = 180;
const CONTINUATION_MAX_GAP = 12;

/**
 * Reads Banco Popular (Spanish) statement lines into dated rows. Only lines inside "Detalle de la actividad" and
 * under a known credit or debit heading become rows; any dated line that cannot be read is skipped and reported.
 */
export function parseBankStatement(text: PdfText): BankStatement {
  const fullDates: { year: number; month: number; day: number }[] = [];
  let accountNumber: string | null = null;
  for (const line of text.lines) {
    if (line.page !== 1) continue;
    for (const item of line.items) {
      const date = readSpanishDate(item.text);
      if (date) fullDates.push(date);
      if (!accountNumber && /^\d{3}-\d{6}$/.test(item.text)) accountNumber = item.text;
    }
  }
  const start = fullDates[0] ?? null;
  const end = fullDates[1] ?? null;

  const rows: BankRow[] = [];
  const groups: BankGroup[] = [];
  const skipped: { page: number; text: string; reason: string }[] = [];
  const printedTotals: { label: string; count: number; amount: string }[] = [];
  let inDetail = false;
  let section: Section | null = null;
  let last: { page: number; y: number } | null = null;

  for (const rawLine of text.lines) {
    const line: PdfLine = {
      ...rawLine,
      items: rawLine.items.filter((item) => !FOOTER.test(item.text)),
    };
    const joined = line.items.map((item) => item.text).join(" ");
    const first = line.items[0];
    if (!first) continue;

    if (/^detalle de la actividad/i.test(joined)) {
      inDetail = true;
      section = null;
      last = null;
      continue;
    }
    if (/^historial de balance diario/i.test(joined)) {
      inDetail = false;
      last = null;
      continue;
    }
    if (!inDetail) continue;

    const lastItem = line.items[line.items.length - 1];
    const hasAmount =
      lastItem !== undefined && lastItem.x >= AMOUNT_COLUMN_MIN_X && isPrintedAmount(lastItem.text);

    if (line.items.length === 1 && first.x <= HEADING_MAX_X) {
      const heading = joined.replace(/\s*\(continuaci[oó]n\)\s*$/i, "").trim();
      if (HEADER_FRAGMENTS.test(heading)) continue;
      section = SECTIONS.find((candidate) => candidate.pattern.test(heading)) ?? null;
      last = null;
      continue;
    }

    const printedTotal = PRINTED_TOTAL.exec(first.text);
    if (printedTotal && hasAmount && lastItem) {
      const amount = printedAmountToDecimal(lastItem.text);
      if (amount)
        printedTotals.push({
          label: printedTotal[2] ?? "",
          count: Number.parseInt(printedTotal[1] ?? "", 10),
          amount,
        });
      last = null;
      continue;
    }

    if (section?.checks && /^\d{5,}$/.test(first.text)) {
      const outcome = readCheckLine(line, section, start, end, rows.length);
      for (const row of outcome.rows) {
        rows.push(row);
        groups.push(section.group);
      }
      for (const reason of outcome.problems)
        skipped.push({ page: line.page, text: joined, reason });
      last = null;
      continue;
    }

    if (/^\d{2}-\d{2}$/.test(first.text) && first.x < DATE_COLUMN_MAX_X) {
      last = null;
      if (!section) {
        skipped.push({
          page: line.page,
          text: joined,
          reason: "Dated line outside a known deposit or withdrawal heading",
        });
        continue;
      }
      if (!hasAmount || !lastItem) {
        skipped.push({
          page: line.page,
          text: joined,
          reason: "No printed amount in the amount column",
        });
        continue;
      }
      const date = isoDate(first.text, start, end);
      const amount = printedAmountToDecimal(lastItem.text);
      if (!date || !amount) {
        skipped.push({
          page: line.page,
          text: joined,
          reason: date ? "Amount could not be read" : "Date is outside the statement period",
        });
        continue;
      }
      const middle = line.items.slice(1, -1);
      const marker = middle.find(
        (item) => item.x >= AMOUNT_COLUMN_MIN_X - 20 && (item.text === "+" || item.text === "-"),
      );
      let negative: boolean;
      if (section.sign === "marked") {
        if (!marker) {
          skipped.push({
            page: line.page,
            text: joined,
            reason: "Miscellaneous line without a + or - marker",
          });
          continue;
        }
        negative = marker.text === "-";
      } else {
        negative = section.sign === "debit";
      }
      const referenceItem = middle.find(
        (item) => item.x < REFERENCE_COLUMN_MAX_X && /^\d+$/.test(item.text),
      );
      const description = middle
        .filter((item) => item !== referenceItem && item !== marker)
        .map((item) => item.text)
        .join(" ")
        .trim();
      rows.push({
        rowNo: rows.length + 1,
        date,
        description: description.length > 0 ? description : section.name,
        reference: referenceItem?.text ?? null,
        amount: negative && amount !== "0.00" ? `-${amount}` : amount,
        section: section.name,
        page: line.page,
      });
      groups.push(section.group);
      last = { page: line.page, y: line.y };
      continue;
    }

    if (
      section?.group === "fees" &&
      hasAmount &&
      lastItem &&
      first.x <= HEADING_MAX_X &&
      !/^total\b/i.test(first.text)
    ) {
      if (printedAmountToDecimal(lastItem.text) !== "0.00") {
        skipped.push({
          page: line.page,
          text: joined,
          reason: "Service charge printed without a posting date",
        });
      }
      last = null;
      continue;
    }

    const previous = rows[rows.length - 1];
    if (
      last &&
      previous &&
      !hasAmount &&
      last.page === line.page &&
      last.y - line.y <= CONTINUATION_MAX_GAP &&
      first.x >= CONTINUATION_MIN_X &&
      !/^(\d+ )?(total|balance)\b/i.test(joined)
    ) {
      rows[rows.length - 1] = {
        ...previous,
        description: `${previous.description} ${joined}`.trim(),
      };
      last = { page: line.page, y: line.y };
      continue;
    }
    last = null;
  }

  return {
    layout: "banco-popular-es",
    periodStart: start ? isoFromParts(start.year, start.month, start.day) : null,
    periodEnd: end ? isoFromParts(end.year, end.month, end.day) : null,
    accountNumber,
    rows,
    skipped,
    totalChecks: checkTotals(printedTotals, rows, groups),
  };
}

function checkTotals(
  printed: readonly { label: string; count: number; amount: string }[],
  rows: readonly BankRow[],
  groups: readonly BankGroup[],
): BankTotalCheck[] {
  const checks: BankTotalCheck[] = [];
  for (const { pattern, group } of TOTAL_GROUPS) {
    const matching = printed.filter((total) => pattern.test(total.label));
    if (matching.length === 0) continue;
    const printedCount = matching.reduce((sum, total) => sum + total.count, 0);
    const printedMinor = matching.reduce((sum, total) => sum + toMinor(total.amount), 0n);
    const inGroup = rows.filter((_, index) => groups[index] === group);
    const parsedMinor = inGroup.reduce(
      (sum, row) => sum + toMinor(row.amount.replace(/^-/, "")),
      0n,
    );
    checks.push({
      label: matching[0]?.label ?? group,
      printedCount,
      printedAmount: fromMinor(printedMinor),
      parsedCount: inGroup.length,
      parsedAmount: fromMinor(parsedMinor),
      matches: printedCount === inGroup.length && printedMinor === parsedMinor,
    });
  }
  return checks;
}

/** Printed statement amounts always carry exactly two decimals, so the digits are the cents. */
function toMinor(decimal: string): bigint {
  return BigInt(decimal.replace(".", ""));
}

function fromMinor(minor: bigint): string {
  const digits = minor.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function readCheckLine(
  line: PdfLine,
  section: (typeof SECTIONS)[number],
  start: { year: number; month: number } | null,
  end: { year: number; month: number } | null,
  offset: number,
): { rows: BankRow[]; problems: string[] } {
  const rows: BankRow[] = [];
  const problems: string[] = [];
  const items = line.items;
  let index = 0;
  while (index < items.length) {
    const checkNo = items[index];
    const dateItem = items[index + 1];
    if (
      !checkNo ||
      !dateItem ||
      !/^\d{5,}$/.test(checkNo.text) ||
      !/^\d{2}-\d{2}$/.test(dateItem.text)
    ) {
      index += 1;
      continue;
    }
    let cursor = index + 2;
    let reference: string | null = null;
    const maybeReference = items[cursor];
    if (
      maybeReference &&
      /^\d+$/.test(maybeReference.text) &&
      !isPrintedAmount(maybeReference.text)
    ) {
      reference = maybeReference.text;
      cursor += 1;
    }
    const amountItem = items[cursor];
    const amount = amountItem ? printedAmountToDecimal(amountItem.text) : null;
    const date = isoDate(dateItem.text, start, end);
    if (!amount || !date) {
      problems.push(
        amount ? "Check date is outside the statement period" : "Check has no readable amount",
      );
      index = cursor + 1;
      continue;
    }
    rows.push({
      rowNo: offset + rows.length + 1,
      date,
      description: `Cheque ${checkNo.text.replace(/^0+(?=\d)/, "")}`,
      reference,
      amount: amount === "0.00" ? amount : `-${amount}`,
      section: section.name,
      page: line.page,
    });
    index = cursor + 1;
  }
  return { rows, problems };
}

function readSpanishDate(text: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{1,2}) de ([a-záéíóú]+) de (\d{4})$/i.exec(text.trim());
  if (!match) return null;
  const month = MONTHS[(match[2] ?? "").toLowerCase()];
  if (!month) return null;
  return {
    year: Number.parseInt(match[3] ?? "", 10),
    month,
    day: Number.parseInt(match[1] ?? "", 10),
  };
}

/** Statement lines print MM-DD. The year comes from the statement period; a period that crosses New Year splits by month. */
function isoDate(
  monthDay: string,
  start: { year: number; month: number } | null,
  end: { year: number; month: number } | null,
): string | null {
  if (!start || !end) return null;
  const [mm, dd] = monthDay.split("-");
  const month = Number.parseInt(mm ?? "", 10);
  const day = Number.parseInt(dd ?? "", 10);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const year = start.year !== end.year && month > end.month ? start.year : end.year;
  if (start.year === end.year && (month < start.month || month > end.month)) return null;
  return isoFromParts(year, month, day);
}

function isoFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
