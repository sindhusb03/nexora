export interface YearEnd {
  readonly month: number;
  readonly day: number;
}

export interface LooseDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
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

/**
 * A bare year never becomes 31 December, and the words "fiscal year" never
 * become 31 March. `yearEnd` is an explicit document date or the org setting.
 */
export function normalizePeriod(
  label: string,
  annualHint: boolean,
  fiscalHint = false,
  yearEnd: YearEnd | null = null,
): {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  spanMonths: number;
} | null {
  const text = normalizeDateText(label).replace(/\s+/g, " ").trim();
  const phrase =
    /^(?:(\d+|three|six|nine|twelve)\s+months?\s+ended|(?:for the )?year ended|as at|as of)\s+(.+)$/i.exec(
      text,
    );
  if (phrase?.[2]) {
    const date = parseLooseDate(phrase[2].trim());
    if (!date) return null;
    return periodEnding(date.year, date.month, date.day, spanCount(phrase[1]));
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso?.[1] && iso[2] && iso[3]) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (annualHint) return periodEnding(year, month, day, 12);
    return {
      periodKey: text,
      periodStart: `${iso[1]}-${iso[2]}-01`,
      periodEnd: text,
      spanMonths: 1,
    };
  }
  const span = /^(?:FY\s*)?(\d{4})\s*[-/]\s*(\d{2,4})$/i.exec(text);
  if (span?.[1] && span[2]) {
    const startYear = Number(span[1]);
    const endYear =
      span[2].length === 2 ? Math.floor(startYear / 100) * 100 + Number(span[2]) : Number(span[2]);
    if (endYear === startYear + 1) {
      if (!yearEnd) return null;
      return periodEnding(endYear, yearEnd.month, yearEnd.day, 12);
    }
  }
  const shortFy = /^FY\s*(\d{2})$/i.exec(text);
  if (shortFy?.[1]) {
    const endYear = 2000 + Number(shortFy[1]);
    if (!yearEnd) return null;
    return periodEnding(endYear, yearEnd.month, yearEnd.day, 12);
  }
  if (/^(19|20)\d{2}$/.test(text)) {
    if (!yearEnd) return null;
    return periodEnding(Number(text), yearEnd.month, yearEnd.day, 12);
  }
  const numeric = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    const date = parseLooseDate(text);
    if (date) {
      const statutory = date.day === 31 && date.month === 3;
      return datedPeriod(
        text,
        date.year,
        date.month,
        date.day,
        annualHint || statutory,
        fiscalHint || statutory,
      );
    }
  }
  const dayMon = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s]((19|20)\d{2})$/.exec(text);
  if (dayMon?.[1] && dayMon[2] && dayMon[3] && !/^\d{1,2}\s+[A-Za-z]+\s+/.test(text)) {
    const monthNo = MONTHS[dayMon[2].toLowerCase()];
    if (monthNo) {
      const day = Number(dayMon[1]);
      const statutory = day === 31 && monthNo === 3;
      return datedPeriod(
        text,
        Number(dayMon[3]),
        monthNo,
        day,
        annualHint || statutory,
        fiscalHint || statutory,
      );
    }
  }
  const monYy = /^([A-Za-z]{3,9})[-\s](\d{2})$/.exec(text);
  if (monYy?.[1] && monYy[2]) {
    const monthNo = MONTHS[monYy[1].toLowerCase()];
    if (monthNo) {
      const year = 2000 + Number(monYy[2]);
      if (
        monthNo === 3 &&
        (annualHint || fiscalHint) &&
        (!yearEnd || (yearEnd.month === 3 && yearEnd.day === 31))
      ) {
        return indianFiscal(year - 1, year);
      }
      if (annualHint || (yearEnd !== null && yearEnd.month === monthNo)) {
        const day = yearEnd?.month === monthNo ? yearEnd.day : lastDay(year, monthNo);
        return periodEnding(year, monthNo, day, 12);
      }
      return {
        periodKey: text,
        periodStart: `${year}-${pad(monthNo)}-01`,
        periodEnd: monthEnd(year, monthNo),
        spanMonths: 1,
      };
    }
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+((19|20)\d{2})$/.exec(text);
  if (dayFirst?.[1] && dayFirst[2] && dayFirst[3]) {
    const monthNo = MONTHS[dayFirst[2].toLowerCase()];
    if (monthNo) {
      const day = Number(dayFirst[1]);
      const statutory = day === 31 && monthNo === 3;
      return datedPeriod(
        text,
        Number(dayFirst[3]),
        monthNo,
        day,
        annualHint || statutory,
        fiscalHint || statutory,
      );
    }
  }
  const month = /^([A-Za-z]+)\s+((19|20)\d{2})$/.exec(text);
  if (month?.[1] && month[2]) {
    const monthNo = MONTHS[month[1].toLowerCase()];
    if (monthNo) {
      return {
        periodKey: text,
        periodStart: `${month[2]}-${pad(monthNo)}-01`,
        periodEnd: monthEnd(Number(month[2]), monthNo),
        spanMonths: 1,
      };
    }
  }
  const quarter = /^Q([1-4])\s+((19|20)\d{2})$/i.exec(text);
  if (quarter?.[1] && quarter[2]) {
    const endMonth = Number(quarter[1]) * 3;
    return {
      periodKey: text.toUpperCase(),
      periodStart: `${quarter[2]}-${pad(endMonth - 2)}-01`,
      periodEnd: monthEnd(Number(quarter[2]), endMonth),
      spanMonths: 3,
    };
  }
  const long = /^([A-Za-z]+)\s+(\d{1,2}),\s*((19|20)\d{2})$/.exec(text);
  if (long?.[1] && long[2] && long[3]) {
    const monthNo = MONTHS[long[1].toLowerCase()];
    if (monthNo) {
      return datedPeriod(text, Number(long[3]), monthNo, Number(long[2]), annualHint, fiscalHint);
    }
  }
  return null;
}

const WORD_SPAN: Readonly<Record<string, number>> = { three: 3, six: 6, nine: 9, twelve: 12 };
const MONTH_NAMES = [
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
];

function spanCount(token: string | undefined): number {
  if (!token) return 12;
  const word = WORD_SPAN[token.toLowerCase()];
  if (word) return word;
  const count = Number(token);
  return count >= 1 && count <= 18 ? count : 12;
}

/**
 * "1-Apr-2024 to 31-Mar-2025" is a twelve-month span ending 31 March 2025.
 * Other lengths become "N months ended" only for 3, 6, and 9.
 */
export function datedRangePhrase(text: string): string | null {
  const match =
    /(\d{1,2}\s*[-/]\s*[A-Za-z]{3,9}\s*[-/]\s*\d{4})\s+to\s+(\d{1,2}\s*[-/]\s*[A-Za-z]{3,9}\s*[-/]\s*\d{4})/i.exec(
      text,
    );
  if (!match?.[1] || !match[2]) return null;
  const start = parseLooseDate(match[1].replace(/[/-]/g, " "));
  const end = parseLooseDate(match[2].replace(/[/-]/g, " "));
  if (!start || !end || start.day !== 1 || end.day !== lastDay(end.year, end.month)) return null;
  const span = (end.year - start.year) * 12 + (end.month - start.month) + 1;
  if (![3, 6, 9, 12].includes(span)) return null;
  const endText = `${end.day} ${MONTH_NAMES[end.month] ?? ""} ${end.year}`;
  return span === 12 ? `year ended ${endText}` : `${span} months ended ${endText}`;
}

function headText(text: string): string {
  return text
    .split(/\r?\n/)
    .slice(0, 100)
    .filter(
      (line) =>
        !/\b(?:print(?:ed)?|generated|run\s+(?:date|at)|report\s+date|prepared|downloaded)\b/i.test(
          line,
        ),
    )
    .join("\n");
}

/** Print, run, and generated dates are not the statement period. */
function isPrintPrefix(before: string): boolean {
  return /(?:printed|print(?:ed)?(?:\s+on|\s+date)?|generated|run\s+date|prepared|downloaded|report\s+date)\s*$/i.test(
    before,
  );
}

function collectStatementDates(text: string): { dates: LooseDate[]; conflict: boolean } {
  const head = normalizeDateText(headText(text));
  const dates: LooseDate[] = [];
  const pattern =
    /(?:(?:\d+|three|six|nine|twelve)\s+months?\s+ended|(?:for the )?year ended|as at|as of)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?[\s-]+[A-Za-z]+[\s,-]+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})/gi;
  for (const match of head.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (isPrintPrefix(head.slice(Math.max(0, index - 48), index))) continue;
    const raw = (match[1] ?? "").trim().replace(/"(?:[,;\t].*)?$/, "");
    const date = parseLooseDate(raw.replace(/[,;].*$/, "").trim()) ?? parseLooseDate(raw);
    if (!date) continue;
    const key = `${date.month}-${date.day}`;
    if (!dates.some((found) => `${found.month}-${found.day}` === key)) dates.push(date);
  }
  return { dates, conflict: dates.length > 1 };
}

/**
 * A date tied to the statement title or a column header. A bare year, a print
 * date, and two disagreeing statement dates do not resolve.
 */
export function explicitYearEnd(text: string): LooseDate | null {
  const found = collectStatementDates(text);
  if (found.conflict) return null;
  return found.dates[0] ?? null;
}

/** True when statement dates disagree, or an interim length cannot be one span. */
export function periodDatesConflict(text: string): boolean {
  return collectStatementDates(text).conflict || statementSpan(text) === -1;
}

/** 3, 6, 9, or 12 when the header says so. -1 when lengths disagree or the span is YTD. */
export function statementSpan(text: string): number | null {
  const head = headText(text).replace(/(three|six|nine|twelve|\d+)-months?/gi, "$1 months");
  const found = new Set<number>();
  for (const match of head.matchAll(/\b(\d+)\s+months?\s+ended\b/gi)) found.add(Number(match[1]));
  if (/\b(?:one\s+)?month ended\b|\bmonthly\b/i.test(head)) found.add(1);
  if (/\b(?:three|3)\s+months?\s+ended\b|\bquarters?\b|\bQ[1-4]\b/i.test(head)) found.add(3);
  if (/\b(?:six|6)\s+months?\s+ended\b|\bhalf[\s-]?years?\b/i.test(head)) found.add(6);
  if (/\b(?:nine|9)\s+months?\s+ended\b/i.test(head)) found.add(9);
  const annualHead = head.replace(/\bhalf[\s-]?years?\b/gi, " ");
  if (/\b(?:twelve|12)\s+months?\s+ended\b|\byear ended\b|\bfor the year\b/i.test(annualHead)) {
    found.add(12);
  }
  const ytd = /\bytd\b|\byear to date\b/i.test(head);
  if (ytd && found.size > 0) return -1;
  if (found.size > 1) return -1;
  if (found.size === 1) return [...found][0] ?? null;
  if (ytd) return -1;
  return null;
}

/** Month and day from "three months ended March 31", even when the year is on the column. */
export function interimMonthDay(text: string): { month: number; day: number } | null {
  const match = /(?:months?\s+ended|quarter ended|(?:half[\s-]?)?year ended)\s+([^\n]{3,40})/i.exec(
    headText(text),
  );
  if (!match?.[1]) return null;
  const raw = match[1].trim();
  const dated = parseLooseDate(raw.replace(/[,;].*$/, "").trim()) ?? parseLooseDate(raw);
  if (dated) return { month: dated.month, day: dated.day };
  return parseMonthDay(raw.replace(/[,;].*$/, "").trim());
}

export function interimColumnLabel(
  year: string,
  span: number,
  end: { month: number; day: number },
): string {
  return `${span} months ended ${MONTH_NAMES[end.month] ?? ""} ${end.day}, ${year}`;
}

function parseMonthDay(text: string): { month: number; day: number } | null {
  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})\b/.exec(text);
  if (monthFirst?.[1] && monthFirst[2]) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (month) return { month, day: Number(monthFirst[2]) };
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)/.exec(text);
  if (dayFirst?.[1] && dayFirst[2]) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (month) return { month, day: Number(dayFirst[1]) };
  }
  return null;
}

export function parseLooseDate(text: string): LooseDate | null {
  const date = uncheckedDate(text);
  if (
    !date ||
    date.month < 1 ||
    date.month > 12 ||
    date.day < 1 ||
    date.day > lastDay(date.year, date.month)
  )
    return null;
  return date;
}

function uncheckedDate(text: string): LooseDate | null {
  const trimmed = normalizeDateText(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.)]$/, "")
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso?.[1] && iso[2] && iso[3]) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+),?\s+((19|20)\d{2})$/.exec(trimmed);
  if (dayFirst?.[1] && dayFirst[2] && dayFirst[3]) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    if (!month) return null;
    return { year: Number(dayFirst[3]), month, day: Number(dayFirst[1]) };
  }
  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2}),?\s+((19|20)\d{2})$/.exec(trimmed);
  if (monthFirst?.[1] && monthFirst[2] && monthFirst[3]) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    if (!month) return null;
    return { year: Number(monthFirst[3]), month, day: Number(monthFirst[2]) };
  }
  const numeric = /^(\d{1,2})[./-](\d{1,2})[./-]((19|20)\d{2})$/.exec(trimmed);
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if (first > 12 && second <= 12) return { year: Number(numeric[3]), month: second, day: first };
    if (second > 12 && first <= 12) return { year: Number(numeric[3]), month: first, day: second };
    return null;
  }
  const dayMon = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s]((19|20)\d{2})$/.exec(trimmed);
  if (dayMon?.[1] && dayMon[2] && dayMon[3]) {
    const month = MONTHS[dayMon[2].toLowerCase()];
    if (!month) return null;
    return { year: Number(dayMon[3]), month, day: Number(dayMon[1]) };
  }
  return null;
}

/** Exact month names, not a jurisdiction-derived fiscal year end. */
function normalizeDateText(text: string): string {
  const months: Record<string, string> = {
    janvier: "January",
    fevrier: "February",
    mars: "March",
    avril: "April",
    mai: "May",
    juin: "June",
    juillet: "July",
    aout: "August",
    septembre: "September",
    octobre: "October",
    novembre: "November",
    decembre: "December",
    januar: "January",
    februar: "February",
    marz: "March",
    juni: "June",
    juli: "July",
    oktober: "October",
    dezember: "December",
  };
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b[a-z]+\b/gi, (word) => months[word.toLowerCase()] ?? word)
    .replace(/(\d{1,2})\.\s+([A-Za-z]+)/g, "$1 $2")
    .replace(
      /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
      (_, y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    );
}

function indianFiscal(startYear: number, endYear: number) {
  return {
    periodKey: `FY${startYear}-${String(endYear).slice(2)}`,
    periodStart: `${startYear}-04-01`,
    periodEnd: `${endYear}-03-31`,
    spanMonths: 12,
  };
}

function datedPeriod(
  text: string,
  year: number,
  monthNo: number,
  day: number,
  annualHint: boolean,
  fiscalHint: boolean,
) {
  if (monthNo === 3 && day === 31 && (annualHint || fiscalHint)) {
    return indianFiscal(year - 1, year);
  }
  if (annualHint) return periodEnding(year, monthNo, day, 12);
  return {
    periodKey: text,
    periodStart: `${year}-${pad(monthNo)}-01`,
    periodEnd: `${year}-${pad(monthNo)}-${pad(day)}`,
    spanMonths: 1,
  };
}

function periodEnding(year: number, month: number, day: number, spanMonths: number) {
  const end = `${year}-${pad(month)}-${pad(day)}`;
  let start: string;
  if (day === lastDay(year, month)) {
    let startMonth = month - spanMonths + 1;
    let startYear = year;
    while (startMonth <= 0) {
      startMonth += 12;
      startYear -= 1;
    }
    start = `${startYear}-${pad(startMonth)}-01`;
  } else {
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCMonth(date.getUTCMonth() - spanMonths);
    date.setUTCDate(date.getUTCDate() + 1);
    start = date.toISOString().slice(0, 10);
  }
  return {
    periodKey: spanMonths === 12 ? String(year) : end,
    periodStart: start,
    periodEnd: end,
    spanMonths,
  };
}

function monthEnd(year: number, month: number): string {
  return `${year}-${pad(month)}-${pad(lastDay(year, month))}`;
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
