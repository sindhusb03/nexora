/**
 * String-only decimal handling for imported files. Nothing here converts an amount to a JS number.
 */

const EXCEL_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/;

/** Excel shows at most 15 significant digits; the file stores the IEEE double behind that display. */
const EXCEL_SIGNIFICANT_DIGITS = 15;

/**
 * Turns the raw `<v>` text of a numeric cell (for example `8798.4699999999993`) into the decimal Excel displays
 * (`8798.47`) by rounding half-up to 15 significant digits on the digit string. Returns null for anything else.
 */
export function excelNumberToDecimal(raw: string): string | null {
  const match = EXCEL_NUMBER.exec(raw.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  const intPart = match[2] ?? "";
  const fracPart = match[3] ?? "";
  const exponent = match[4] ? Number.parseInt(match[4], 10) : 0;

  let digits = intPart + fracPart;
  let point = intPart.length + exponent;
  const leading = /^0*/.exec(digits)?.[0].length ?? 0;
  if (leading === digits.length) return "0";
  digits = digits.slice(leading);
  point -= leading;

  if (digits.length > EXCEL_SIGNIFICANT_DIGITS) {
    const roundUp = digits.charCodeAt(EXCEL_SIGNIFICANT_DIGITS) - 48 >= 5;
    digits = digits.slice(0, EXCEL_SIGNIFICANT_DIGITS);
    if (roundUp) {
      digits = incrementDigits(digits);
      if (digits.length > EXCEL_SIGNIFICANT_DIGITS) {
        digits = digits.slice(0, EXCEL_SIGNIFICANT_DIGITS);
        point += 1;
      }
    }
  }

  let text: string;
  if (point <= 0) text = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) text = digits + "0".repeat(point - digits.length);
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  if (/^0(\.0*)?$/.test(text)) return "0";
  return negative ? `-${text}` : text;
}

/**
 * Removes binary residue left by spreadsheet arithmetic, such as `938349.170000002` → `938349.17`. It only acts when at
 * least four 0s or four 9s follow the minor-unit digits; any other sub-cent digits are kept as written.
 */
export function trimBinaryNoise(decimal: string, scale = 2): string {
  const match = /^(-?)(\d+)\.(\d+)$/.exec(decimal);
  if (!match) return decimal;
  const sign = match[1] ?? "";
  let whole = match[2] ?? "0";
  const frac = match[3] ?? "";
  if (frac.length <= scale) return decimal;
  let kept = frac.slice(0, scale);
  const rest = frac.slice(scale);
  if (/^9{4,}/.test(rest)) {
    const bumped = incrementDigits(whole + kept);
    whole = bumped.slice(0, bumped.length - scale);
    kept = bumped.slice(bumped.length - scale);
  } else if (!/^0{4,}/.test(rest)) {
    return decimal;
  }
  const trimmed = kept.replace(/0+$/, "");
  const text = trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
  return text === "0" ? "0" : `${sign}${text}`;
}

function incrementDigits(digits: string): string {
  const out = digits.split("");
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if (out[index] === "9") {
      out[index] = "0";
    } else {
      out[index] = String.fromCharCode((out[index] ?? "0").charCodeAt(0) + 1);
      return out.join("");
    }
  }
  return `1${out.join("")}`;
}

const STATEMENT_PRINT = /^(\()?(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(\))?$/;

/**
 * A statement amount as printed: `1,526,602`, `119,668.99`, `(88,988)`, or `-0-`.
 * Whole numbers without a thousands separator are refused so a year or a page number is not stored as money.
 */
export function statementAmountToDecimal(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "-0-") return "0";
  const match = STATEMENT_PRINT.exec(trimmed);
  if (!match) return null;
  const open = match[1] === "(";
  const close = match[5] === ")";
  if (open !== close) return null;
  const grouped = (match[3] ?? "").includes(",");
  const decimals = match[4];
  if (!grouped && decimals === undefined && trimmed !== "0") return null;
  const negative = open || match[2] === "-";
  const digits = `${(match[3] ?? "").replace(/,/g, "")}${decimals ?? ""}`.replace(/^0+(?=\d)/, "");
  if (digits === "0") return "0";
  return negative ? `-${digits}` : digits;
}

const STATEMENT_AMOUNT = /^\$?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/;

/** Reads a printed bank amount such as `$1,024.46` into `1024.46`. Returns null unless it has exactly two decimals. */
export function printedAmountToDecimal(text: string): string | null {
  const match = STATEMENT_AMOUNT.exec(text.trim());
  if (!match) return null;
  const whole = (match[1] ?? "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
  return `${whole}.${match[2] ?? "00"}`;
}

export function isPrintedAmount(text: string): boolean {
  return STATEMENT_AMOUNT.test(text.trim());
}

const GROUPED_NUMBER = "\\d{1,3}(?:,\\d{2})*,\\d{3}|\\d{1,3}(?:,\\d{3})+|\\d+";
const CURRENCY_PREFIX =
  "S\\$|A\\$|US\\$|C\\$|NZ\\$|HK\\$|R\\$|₹|¥|£|€|\\$|Rs\\.?|INR|AED|USD|EUR|GBP|SGD|AUD|JPY";
const MONEY_SOURCE = `((?:\\((?:${GROUPED_NUMBER})(?:\\.\\d+)?\\)|-?(?:${GROUPED_NUMBER})(?:\\.\\d+)?)-?)(?:\\s*(CR|DR))?`;

function stripCurrency(value: string): string {
  return value
    .replace(new RegExp(`^(?:${CURRENCY_PREFIX})\\s*`, "i"), "")
    .replace(/\s*(?:INR|AED|USD|EUR|GBP|SGD|AUD|JPY)$/i, "")
    .trim();
}

/** Full amount token. `1223456.78` stays intact; Indian and western grouping, brackets, and CR/DR are accepted. */
export type NumberConvention = "dot" | "comma" | "unknown" | "conflict";

/** Infer once from amount cells, never from years, reference numbers, or currency alone. */
export function numberConvention(values: readonly string[], context = ""): NumberConvention {
  const evidence = new Set<"dot" | "comma">();
  if (/\b(?:de-DE|de-AT|fr-FR|it-IT|es-ES|pt-PT|nl-NL)\b|Dezember|décembre/i.test(context))
    evidence.add("comma");
  if (/\b(?:en-US|en-GB|en-IN|en-AU|ja-JP)\b/i.test(context)) evidence.add("dot");
  for (const raw of values) {
    const token = stripCurrency(raw.normalize("NFKC")).replace(/[()\s+-]|CR|DR/gi, "");
    if (/^\d{1,3}(?:\.\d{3}){2,}(?:,\d+)?$/.test(token) || /^\d[\d.]*,\d{1,2}$/.test(token))
      evidence.add("comma");
    if (
      /^\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?$/.test(token) ||
      /^\d[\d,]*\.\d{1,2}$/.test(token) ||
      /^\d+\.\d{4,}$/.test(token)
    )
      evidence.add("dot");
    if (/^\d{1,3}(?:,\d{2})+,\d{3}(?:\.\d+)?$/.test(token)) evidence.add("dot");
  }
  return evidence.size > 1 ? "conflict" : ([...evidence][0] ?? "unknown");
}

export function parseMoneyToken(value: string, convention?: NumberConvention): string | null {
  let text = stripCurrency(value.normalize("NFKC").replace(/\u2212/g, "-")).trim();
  text = text.replace(/(\d)[ '\u2019](?=\d{3}(?:[ '\u2019.,)]|$))/g, "$1");
  if (convention === "conflict") return null;
  if (convention === "unknown" && /\d[.,]\d{3}(?:\)|-|\s*(?:CR|DR))?$/i.test(text)) return null;
  if (convention === "comma" || /\d{1,3}(?:\.\d{3}){2,}/.test(text)) {
    if (!/^(?:\(?-?)(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?(?:\)|-|\s*(?:CR|DR))?$/i.test(text))
      return null;
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (convention === "dot" && /,\d{1,2}(?:\)|-|\s*(?:CR|DR))?$/i.test(text)) return null;
  // A decimal comma is unambiguous with one or two fractional digits. Three digits
  // remain grouping; never remove an arbitrary comma as CSV previously did.
  if (/\d,\d{1,2}(?:\)|-|\s*(?:CR|DR))?$/i.test(text)) {
    if (/^(?:\(?-?)(?:\d{1,3}(?:\.\d{3})+|\d+),\d{1,2}(?:\)|-|\s*(?:CR|DR))?$/i.test(text)) {
      text = text.replace(/\./g, "").replace(",", ".");
    }
  }
  if (/^\(?-?\d+,\d{2}\)?$/.test(text)) text = text.replace(",", ".");
  const match = new RegExp(`^\\s*${MONEY_SOURCE}\\s*$`, "i").exec(text);
  if (!match?.[1]) return null;
  return signedMoney(match[1], match[2] ?? null);
}

export function findMoneyTokens(text: string): { raw: string; amount: string }[] {
  const found: { raw: string; amount: string }[] = [];
  const pattern = new RegExp(
    `(?<![\\w.,/-])(?:${CURRENCY_PREFIX}\\s*)?${MONEY_SOURCE}(?:\\s*(?:INR|AED|USD|EUR|GBP|SGD|AUD|JPY))?(?![\\w/.,])`,
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    const raw = match[0] ?? "";
    const amount = parseMoneyToken(raw);
    if (!amount) continue;
    found.push({ raw, amount });
  }
  return found;
}

function signedMoney(body: string, marker: string | null): string | null {
  let negative = false;
  let number = body.trim();
  if (number.startsWith("(") && number.endsWith(")")) {
    negative = true;
    number = number.slice(1, -1).trim();
  }
  if (number.startsWith("-")) {
    negative = true;
    number = number.slice(1).trim();
  }
  if (number.endsWith("-")) {
    negative = true;
    number = number.slice(0, -1).trim();
  }
  if (!isGroupedNumber(number)) return null;
  if (marker && /^DR$/i.test(marker)) negative = true;
  const digits = number.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const normalized = digits.length === 0 ? "0" : digits;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function isGroupedNumber(value: string): boolean {
  return (
    /^\d+(\.\d+)?$/.test(value) ||
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value) ||
    /^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?$/.test(value)
  );
}
