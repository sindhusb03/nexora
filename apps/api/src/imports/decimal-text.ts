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
    const roundUp = (digits.charCodeAt(EXCEL_SIGNIFICANT_DIGITS) - 48) >= 5;
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
