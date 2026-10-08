import { localizedAmountHeader } from "./statement-locales.js";

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
  const normalized = normalizeDateText(label).replace(/\s+/g, " ").trim();
  const text = datedRangePhrase(normalized) ?? normalized;
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
  const span = /^(?:FY\s*)?(\d{2}|\d{4})\s*[-/]\s*(\d{2,4})$/i.exec(text);
  if (span?.[1] && span[2]) {
    const startYear = Number(span[1]) + (span[1].length === 2 ? 2000 : 0);
    const endYear =
      span[2].length === 2 ? Math.floor(startYear / 100) * 100 + Number(span[2]) : Number(span[2]);
    if (endYear === startYear + 1) {
      if (!yearEnd) return null;
      return periodEnding(endYear, yearEnd.month, yearEnd.day, 12);
    }
  }
  const shortFy = /^FY\s*(\d{2}|\d{4})$/i.exec(text);
  if (shortFy?.[1]) {
    const endYear = Number(shortFy[1]) + (shortFy[1].length === 2 ? 2000 : 0);
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
  // A shared year applies to both endpoints only within that calendar year.
  // Cross-year ranges require two printed years or an explicit previous-year marker.
  const head = normalizeDateText(headText(text)).replace(
    /([A-Za-z]+)\s*\(?previous year\)?\s*(?:to|[-–—])\s*([A-Za-z]+)\s+(\d{4})/gi,
    (_, start: string, end: string, year: string) =>
      `${start} ${Number(year) - 1} to ${end} ${year}`,
  );
  const shared =
    /((?:\d{1,2}\s+)?[A-Za-z]+)\s*(?:to|through|bis|au|al|[-–—])\s*((?:\d{1,2}\s+)?[A-Za-z]+),?\s+(\d{4})/i;
  const expanded = head.replace(shared, (_, start: string, end: string, year: string) => {
    const startMonth = MONTHS[start.split(/\s+/).at(-1)!.toLowerCase()];
    const endMonth = MONTHS[end.split(/\s+/).at(-1)!.toLowerCase()];
    return startMonth && endMonth && startMonth <= endMonth
      ? `${start} ${year} to ${end} ${year}`
      : "UNRESOLVED RANGE";
  });
  const match = new RegExp(
    `(${DATE_TOKEN}|[A-Za-z]+\\s+\\d{4})\\s*(?:to|through|bis|au|al|から|至|[～〜–—-])\\s*(${DATE_TOKEN}|[A-Za-z]+\\s+\\d{4})`,
    "i",
  ).exec(expanded);
  if (!match?.[1] || !match[2]) return null;
  const parts = [match[1], match[2]];
  const numeric = parts.map((value) => /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value));
  const dmy = numeric.some((m) => m && Number(m[1]) > 12);
  const mdy = numeric.some((m) => m && Number(m[2]) > 12);
  if (dmy && mdy) return null;
  const dates = parts.map((value, i) => {
    const m = numeric[i];
    if (!m) {
      const month = /^([A-Za-z]+)\s+(\d{4})$/.exec(value);
      const monthNo = month?.[1] ? MONTHS[month[1].toLowerCase()] : undefined;
      if (monthNo && month?.[2])
        return {
          year: Number(month[2]),
          month: monthNo,
          day: i === 0 ? 1 : lastDay(Number(month[2]), monthNo),
        };
      return parseLooseDate(value) ?? parseLooseDate(value.replace(/[/-]/g, " "));
    }
    if (!dmy && !mdy && m[1] !== m[2]) return null;
    return parseLooseDate(`${m[3]}-${pad(Number(m[mdy ? 1 : 2]))}-${pad(Number(m[mdy ? 2 : 1]))}`);
  });
  const [start, end] = dates;
  if (!start || !end || start.day !== 1 || end.day !== lastDay(end.year, end.month)) return null;
  const span = (end.year - start.year) * 12 + (end.month - start.month) + 1;
  if (![3, 6, 9, 12].includes(span)) return null;
  const endText = `${end.day} ${MONTH_NAMES[end.month] ?? ""} ${end.year}`;
  return span === 12 ? `year ended ${endText}` : `${span} months ended ${endText}`;
}

const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\s-]+[A-Za-z]+[\s,-]+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{4})`;

export function isReportRunLine(line: string): boolean {
  return (
    /\b(?:print(?:ed)?|generated|run\s+(?:date|at)|report\s+date|prepared|downloaded)\b/i.test(
      line,
    ) ||
    /印刷日|印刷日時|出力日|作成日/.test(line) ||
    /\b(?:basis|accrual|cash)\b.*\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b.*\d{1,2}:\d{2}/i.test(
      line,
    )
  );
}

function headText(text: string): string {
  return text
    .split(/\r?\n/)
    .slice(0, 100)
    .filter((line) => !isReportRunLine(line))
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
  const head = normalizeDateText(headText(text)).replace(
    /(three|six|nine|twelve|\d+)-months?/gi,
    "$1 months",
  );
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

/** Only explicit statement phrases/ranges are evidence; unrelated dates are not. */
function statementPeriods(text: string) {
  const head = normalizeDateText(headText(text));
  const found: NonNullable<ReturnType<typeof normalizePeriod>>[] = [];
  for (const line of head.split(/\r?\n/)) {
    const printedDate = parseLooseDate(line.trim());
    if (printedDate) {
      found.push(periodEnding(printedDate.year, printedDate.month, printedDate.day, 12));
      continue;
    }
    const range = datedRangePhrase(line);
    if (range) {
      const period = normalizePeriod(range, true);
      if (period) found.push(period);
      continue;
    }
    const pattern = new RegExp(
      `(?:(?:\\d+|three|six|nine|twelve)\\s+months?\\s+ended|(?:for the )?year ended|as at|as of)\\s+${DATE_TOKEN}`,
      "gi",
    );
    for (const match of line.matchAll(pattern)) {
      const period = normalizePeriod(match[0], true);
      if (period) found.push(period);
    }
  }
  return found.filter(
    (p, i) =>
      found.findIndex(
        (other) => other.periodEnd === p.periodEnd && other.spanMonths === p.spanMonths,
      ) === i,
  );
}

export function isStatementPeriodLabel(text: string): boolean {
  return (
    statementPeriods(text).length > 0 ||
    localizedAmountHeader(text) ||
    /^(?:FY\s*\d{2,4}(?:[-/]\d{2,4})?|Neto\s+\d{4}|\d{4}[-/]\d{2,4}|selected period|total|amount|balance|comparison|previous year|prior year|last year|N|N-1|Vorjahr|year to date\s*\(prior\))$/i.test(
      normalizeDateText(text).trim(),
    ) ||
    /[A-Za-z]+\s*(?:to|through|bis|au|al|[-–—])\s*(?:\d{1,2}\s+)?[A-Za-z]+,?\s+\d{4}/i.test(
      normalizeDateText(text),
    ) ||
    new RegExp(`${DATE_TOKEN}\\s*(?:to|bis|au|al|から|至|[～〜–—-])\\s*${DATE_TOKEN}`, "i").test(
      normalizeDateText(text),
    )
  );
}

/** Resolve each column independently, with title evidence scoped to this table. */
export function resolveStatementPeriods(
  labels: readonly string[],
  title: string,
  orgYearEnd: YearEnd | null,
) {
  const numeric = [
    ...headText([title, ...labels].join("\n")).matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-]\d{4}\b/g),
  ];
  const dmy = numeric.some((m) => Number(m[1]) > 12);
  const mdy = numeric.some((m) => Number(m[2]) > 12);
  if (dmy && mdy) return labels.map(() => null);
  const ordered = (text: string) =>
    text.replace(
      /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g,
      (raw, first: string, second: string, year: string) =>
        dmy || mdy
          ? `${year}-${pad(Number(mdy ? first : second))}-${pad(Number(mdy ? second : first))}`
          : raw,
    );
  title = ordered(title);
  labels = labels.map(ordered);
  const normalizedTitle = normalizeDateText(headText(title));
  // An unspecified flow duration must not inherit an annual organization calendar.
  if (
    /\b(?:Erfolgsrechnung\s+per|Periodo\s+findo\s+em)\b/i.test(
      normalizeDateText([title, ...labels].join("\n")),
    )
  )
    return labels.map(() => null);
  const asAtTitle = new RegExp(`\\bas (?:at|of)\\s+${DATE_TOKEN}`, "i").exec(normalizedTitle);
  const netoEnd = asAtTitle ? normalizePeriod(asAtTitle[0], true) : null;
  const latestNetoYear = Math.max(
    ...labels.flatMap((label) => {
      const neto = /^Neto\s+(\d{4})$/i.exec(label.trim());
      return neto ? [Number(neto[1])] : [];
    }),
  );
  const titles = statementPeriods(title);
  const titleSpan = statementSpan(datedRangePhrase(title) ?? title);
  if (titleSpan !== null && titleSpan !== 12) return labels.map(() => null);
  const titleConflict = new Set(titles.map((p) => p.periodEnd.slice(5))).size > 1;
  const explicit = titles[0];
  const titleEnds = normalizeDateText(headText(title))
    .split(/\r?\n/)
    .flatMap((line) => {
      const end = interimMonthDay(line);
      return end ? [end] : [];
    });
  const monthDay = titleEnds[0] ?? null;
  const headerEnds = labels.flatMap((label) => {
    const end = statementSpan(label) === 12 ? interimMonthDay(normalizeDateText(label)) : null;
    return end ? [end] : [];
  });
  const sharedHeaderEnd =
    new Set(headerEnds.map((end) => `${end.month}-${end.day}`)).size === 1 ? headerEnds[0] : null;
  if (new Set([...titleEnds, ...headerEnds].map((end) => `${end.month}-${end.day}`)).size > 1)
    return labels.map(() => null);
  const yearEnd = explicit
    ? { month: Number(explicit.periodEnd.slice(5, 7)), day: Number(explicit.periodEnd.slice(8)) }
    : (monthDay ?? sharedHeaderEnd ?? orgYearEnd);
  const own = labels.map((label) => {
    const neto = /^Neto\s+(\d{4})$/i.exec(label.trim());
    if (neto) {
      if (!netoEnd || latestNetoYear !== Number(netoEnd.periodEnd.slice(0, 4))) return null;
      return normalizePeriod(`FY ${neto[1]}`, true, false, {
        month: Number(netoEnd.periodEnd.slice(5, 7)),
        day: Number(netoEnd.periodEnd.slice(8)),
      });
    }
    const phrases = statementPeriods(label);
    return (
      normalizePeriod(label, titleSpan === 12 || /\bas (?:at|of)\b/i.test(title), false, yearEnd) ??
      (phrases.length === 1 ? phrases[0]! : null)
    );
  });
  const established = explicit ?? own.find((p) => p?.spanMonths === 12);
  const explicitColumns = own.filter((p) => p !== null);
  // Different annual flow calendars require review. Point-in-time "as at"
  // columns can legitimately compare distinct reporting dates.
  const annualEnds = labels.flatMap((label, i) =>
    statementSpan(datedRangePhrase(label) ?? label) === 12 && own[i]
      ? [own[i]!.periodEnd.slice(5)]
      : [],
  );
  if (new Set(annualEnds).size > 1) return labels.map(() => null);
  return labels.map((label, i) => {
    if (titleConflict) return null;
    const prior =
      /\b(?:previous year|prior year|last year|N-1|Vorjahr)\b|\byear to date\s*\(prior\)/i.test(
        label.trim(),
      );
    let period = own[i] ?? null;
    if (!period && prior && established) {
      const end = parseLooseDate(established.periodEnd)!;
      const day = Math.min(end.day, lastDay(end.year - 1, end.month));
      period = periodEnding(end.year - 1, end.month, day, established.spanMonths);
    }
    if (
      !period &&
      (/^(?:selected period|total|amount|balance|N)$/i.test(label.trim()) ||
        (labels.length === 1 && localizedAmountHeader(label))) &&
      titles.length === 1
    )
      period = explicit ?? null;
    const localSpan = statementSpan(datedRangePhrase(label) ?? label);
    // Existing ingestion stores annual observations only. Retain interim columns in review.
    if (localSpan !== null && localSpan !== 12 && !prior) return null;
    if (!period) return null;
    if (explicit && !prior) {
      // A sole conflicting year is not a comparative. Multiple dated columns must
      // include the stated current period before other years can be accepted.
      if (
        !titles.some((p) => p.periodEnd === period.periodEnd) &&
        !explicitColumns.some((p) => p.periodEnd === explicit.periodEnd)
      )
        return null;
    }
    return period;
  });
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
    dicembre: "December",
    dezembro: "December",
    januari: "January",
    februari: "February",
    maart: "March",
    april: "April",
    mei: "May",
    augustus: "August",
    gennaio: "January",
    febbraio: "February",
    aprile: "April",
    maggio: "May",
    giugno: "June",
    luglio: "July",
    settembre: "September",
    ottobre: "October",
    novembro: "November",
    janeiro: "January",
    fevereiro: "February",
    marco: "March",
    maio: "May",
    junho: "June",
    julho: "July",
    setembro: "September",
    outubro: "October",
    enero: "January",
    febrero: "February",
    marzo: "March",
    abril: "April",
    mayo: "May",
    junio: "June",
    julio: "July",
    agosto: "August",
    septiembre: "September",
    octubre: "October",
    noviembre: "November",
    diciembre: "December",
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
    .normalize("NFC")
    .replace(
      /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/g,
      (_, y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    )
    .replace(/(\d{4}-\d{2}-\d{2})부터\s*(\d{4}-\d{2}-\d{2})까지/g, "$1 to $2")
    .replace(
      /令和\s*(元|\d{1,2})\s*年/g,
      (_, year: string) => `${2018 + (year === "元" ? 1 : Number(year))}年`,
    )
    .replace(/(\d{4})年\s*(\d{1,2})月期/g, (_, year: string, month: string) => {
      const m = Number(month);
      return m >= 1 && m <= 12
        ? `year ended ${year}-${pad(m)}-${lastDay(Number(year), m)}`
        : "UNRESOLVED";
    })
    .replace(/\b[a-z]+\b/gi, (word) => months[word.toLowerCase()] ?? word)
    .replace(/\b(\d{1,2})er\b/gi, "$1")
    .replace(/(\d{1,2})\.\s+([A-Za-z]+)/g, "$1 $2")
    .replace(/\bde\s+(?=[A-Za-z]+|\d{4})/gi, "")
    .replace(
      /\b(?:fiscal\s+year\s+ended|Geschaftsjahr\s+(?:zum|zum Ende des)|Jahr\s+zum|Exercice\s+clos\s+(?:le|au)|Ejercicio\s+(?:terminado|finalizado|cerrado)\s+(?:el|al)|Esercizio\s+(?:chiuso|terminato)\s+al|Boekjaar\s+(?:eindigend op|geeindigd op)|Exercicio\s+(?:encerrado|findo)\s+em)\s*/gi,
      "year ended ",
    )
    .replace(
      /\b(?:Erfolgsrechnung\s+per|Periodo\s+findo\s+em)\s+(?=(?:31\s+December\s+\d{4}|31[./-]12[./-]\d{4}|\d{4}-12-31)\b)/gi,
      "year ended ",
    )
    .replace(/\bBalance\s+(?:de\s+)?situacion\s+al\s+/gi, "as at ")
    .replace(/\b(?:Bilanz\s+zum)\s+(?=\d{1,2}\s)/gi, "as at ")
    .replace(/\b(?:Bilan\s+au|Balance\s+al)\s+/gi, "as at ")
    .replace(/(^|\n)\s*(?:zum|au|al)\s+(?=\d{1,2}[\s./-]|\d{4}-\d{2}-\d{2})/gi, "$1as at ")
    .replace(
      /\b(?:Geschaftsjahr|GJ|Exercice|Ejercicio|Esercizio|Exercicio|Boekjaar)\s+(\d{4})\b/gi,
      "FY $1",
    )
    .replace(/(\d{4})年度/g, "FY $1")
    .replace(/\bquarter\s+ended/gi, "3 months ended")
    .replace(/\bfiscal\s+year[ -]end\s*:?\s*(?=\d|[A-Za-z]+\s+\d)/gi, "year ended ")
    .replace(/\bhalf[ -]?year\s+ended/gi, "6 months ended")
    .replace(
      /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g,
      (_, y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    )
    .replace(
      /(?:当事業年度|前事業年度|当連結会計年度|前連結会計年度)\s*\(?\s*(\d{4}-\d{2}-\d{2})\s*\)?/g,
      "year ended $1",
    )
    .replace(/(\d{4}-\d{2}-\d{2})(?:に終了する事業年度|に終了する年度|終了年度)/g, "year ended $1")
    .replace(/(\d{4}-\d{2}-\d{2})(?:現在|時点)/g, "as at $1");
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
