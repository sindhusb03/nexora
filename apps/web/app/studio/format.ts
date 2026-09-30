/** Presentation of server minor-unit strings. This does not add, allocate, or round money. */

export function minorToDisplay(minor: string): string {
  if (!/^-?\d+$/.test(minor)) return minor;
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(3, "0");
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fraction}`;
}

export function withCurrency(display: string, currency: string): string {
  if (currency === "USD") {
    const negative = display.startsWith("-");
    return `${negative ? "-" : ""}$${negative ? display.slice(1) : display}`;
  }
  return `${display} ${currency}`;
}

/** Chart axis scale only. Tooltips use the server display string, not this number. */
export function axisCurrency(value: number): string {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    return `${sign}$${millions.toFixed(millions >= 10 ? 0 : 1)}M`;
  }
  if (abs >= 1_000) {
    const thousands = abs / 1_000;
    return `${sign}$${thousands.toFixed(thousands >= 10 ? 0 : 1)}k`;
  }
  return `${sign}$${abs.toFixed(0)}`;
}

/** Replaces "15000000 minor-unit" phrases with currency. The stored minor string is unchanged. */
export function humanizeMinorPhrases(text: string, currency: string): string {
  return text.replace(/\b(\d+)\s+minor(?:-unit)?(?:\s+units?)?\b/g, (_match, digits: string) => withCurrency(minorToDisplay(digits), currency));
}

export function minorToAxis(minor: string): number {
  const negative = minor.startsWith("-");
  const digits = (negative ? minor.slice(1) : minor).replace(/\D/g, "");
  const padded = digits.padStart(3, "0");
  const value = Number(`${padded.slice(0, -2)}.${padded.slice(-2)}`);
  return negative ? -value : value;
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
  if (/[",\n]/.test(value)) return `"${value.replaceAll("\"", "\"\"")}"`;
  return value;
}
