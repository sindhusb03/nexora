import { AnalyticalDecimal } from "./money.js";

/** Exact printed-statement reconciliation. No binary floats or tolerance. */
export function statementAmountsEqual(left: readonly string[], right: readonly string[]): boolean {
  const sum = (values: readonly string[]) =>
    values.reduce((total, value) => total.plus(value), new AnalyticalDecimal(0));
  return sum(left).eq(sum(right));
}
