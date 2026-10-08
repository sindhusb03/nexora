import { lookupCurrencyScale } from "@nexora/currency";
import Decimal from "decimal.js";

import { KernelError } from "./errors.js";

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Process-local analytical decimal. Ledger math does not use this type. */
export const AnalyticalDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export interface Money {
  readonly currency: string;
  /** Integer minor units. Never a float. */
  readonly minor: string;
  readonly scale: number;
}

export function currencyScale(currency: string): number {
  return requireCurrency(currency).scale;
}

export function assertCurrency(currency: string): string {
  return requireCurrency(currency).code;
}

function requireCurrency(currency: string): { code: string; scale: number } {
  const found = lookupCurrencyScale(currency);
  if (!found.ok) {
    if (found.reason === "unsupported") {
      throw new KernelError("FIN_CURRENCY_UNSUPPORTED", `Currency ${currency} has no minor unit`);
    }
    throw new KernelError("FIN_CURRENCY_MISMATCH", `Invalid currency code ${currency}`);
  }
  return found;
}

export function money(currency: string, minor: bigint | string): Money {
  const code = assertCurrency(currency);
  const value = typeof minor === "bigint" ? minor : parseMinor(minor);
  return { currency: code, minor: value.toString(), scale: currencyScale(code) };
}

export function zeroMoney(currency: string): Money {
  return money(currency, 0n);
}

export function parseMinor(value: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new KernelError("FIN_AMOUNT_SCALE", `Minor units must be an integer string: ${value}`);
  }
  return BigInt(value);
}

export function moneyFromDecimal(currency: string, amount: string): Money {
  if (!PLAIN_DECIMAL.test(amount)) {
    throw new KernelError("FIN_AMOUNT_SCALE", `Amount must be a plain decimal string: ${amount}`);
  }
  const scale = currencyScale(currency);
  const decimal = new AnalyticalDecimal(amount);
  if (decimal.decimalPlaces() > scale) {
    throw new KernelError(
      "FIN_AMOUNT_SCALE",
      `Amount ${amount} exceeds scale ${scale} for ${currency}`,
    );
  }
  const minor = decimal.mul(new AnalyticalDecimal(10).pow(scale)).toFixed(0);
  return money(currency, minor);
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency || left.scale !== right.scale) {
    throw new KernelError(
      "FIN_CURRENCY_MISMATCH",
      `Cannot combine ${left.currency} and ${right.currency}`,
    );
  }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.currency, parseMinor(left.minor) + parseMinor(right.minor));
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.currency, parseMinor(left.minor) - parseMinor(right.minor));
}

export function negateMoney(value: Money): Money {
  return money(value.currency, -parseMinor(value.minor));
}

export function compareMoney(left: Money, right: Money): number {
  assertSameCurrency(left, right);
  const delta = parseMinor(left.minor) - parseMinor(right.minor);
  if (delta === 0n) {
    return 0;
  }
  return delta > 0n ? 1 : -1;
}

export function isZeroMoney(value: Money): boolean {
  return parseMinor(value.minor) === 0n;
}

export function isNegativeMinor(value: string): boolean {
  return parseMinor(value) < 0n;
}

export function formatMinor(minor: string, scale: number): string {
  const value = parseMinor(minor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function assertNonNegativeMinor(value: string, label: string): bigint {
  const minor = parseMinor(value);
  if (minor < 0n) {
    throw new KernelError("FIN_INVALID_JOURNAL_LINE", `${label} cannot be negative`);
  }
  return minor;
}
