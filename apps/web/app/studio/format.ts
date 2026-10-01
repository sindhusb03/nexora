/** Presentation of server minor-unit strings. This does not add, allocate, or round money. */

const currencyFormats = new Map<string, Intl.NumberFormat>();

function currencyFormat(currency: string): Intl.NumberFormat {
  let format = currencyFormats.get(currency);
  if (!format) {
    format = new Intl.NumberFormat("en", { style: "currency", currency });
    currencyFormats.set(currency, format);
  }
  return format;
}

function minorDigits(currency: string): number {
  return currencyFormat(currency).resolvedOptions().maximumFractionDigits ?? 0;
}

export function minorToDisplay(minor: string, currency = "USD"): string {
  if (!/^-?\d+$/.test(minor)) return minor;
  const negative = minor.startsWith("-");
  const scale = minorDigits(currency);
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(scale + 1, "0");
  const whole = scale ? padded.slice(0, -scale) : padded;
  const fraction = scale ? `.${padded.slice(-scale)}` : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction}`;
}

export function withCurrency(display: string, currency: string): string {
  const negative = display.startsWith("-");
  let inserted = false;
  return currencyFormat(currency)
    .formatToParts(negative ? -1 : 1)
    .map((part) => {
      if (["integer", "group", "decimal", "fraction"].includes(part.type)) {
        if (inserted) return "";
        inserted = true;
        return negative ? display.slice(1) : display;
      }
      return part.value;
    })
    .join("");
}

/** Chart axis scale only. Tooltips use exact strings. */
export function axisCurrency(value: number, currency = "USD"): string {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    return withCurrency(`${sign}${millions.toFixed(millions >= 10 ? 0 : 1)}M`, currency);
  }
  if (abs >= 1_000) {
    const thousands = abs / 1_000;
    return withCurrency(`${sign}${thousands.toFixed(thousands >= 10 ? 0 : 1)}k`, currency);
  }
  return withCurrency(`${sign}${abs.toFixed(0)}`, currency);
}

/** Replaces minor-unit phrases; the stored minor string is unchanged. */
export function humanizeMinorPhrases(text: string, currency: string): string {
  return text.replace(/\b(\d+)\s+minor(?:-unit)?(?:\s+units?)?\b/g, (_match, digits: string) =>
    withCurrency(minorToDisplay(digits, currency), currency),
  );
}

export function minorToAxis(minor: string, currency = "USD"): number {
  if (!/^-?\d+$/.test(minor)) return Number.NaN;
  return Number(minorToDisplay(minor, currency).replaceAll(",", ""));
}

/** Moves a kernel ratio two decimal places for display. "0.0533" becomes "5.33%". */
export function percentFromRatio(ratio: string | null): string {
  if (ratio === null || !/^-?\d+(\.\d+)?$/.test(ratio)) return "—";
  const negative = ratio.startsWith("-");
  const raw = negative ? ratio.slice(1) : ratio;
  const [whole, fraction = ""] = raw.split(".");
  const padded = fraction.padEnd(2, "0");
  const percentWhole = `${whole ?? "0"}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, "") || "0";
  return `${negative ? "-" : ""}${percentWhole}.${padded.slice(2, 4)}%`;
}

export function shortHash(value: string): string {
  return value.slice(0, 10);
}

export function csvCell(value: string): string {
  // Only a complete plain decimal can be emitted as a numeric cell.
  if (/^[=+@\t\r-]/.test(value) && !/^-?\d+(?:\.\d+)?$/.test(value)) value = `'${value}`;
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}
