/**
 * Table version for the one-time currency-scale check.
 * The cutover time and the result come from the deploy run. They are not
 * stored here, and neither is an approver.
 */
export const CURRENCY_SCALE_TABLE_VERSION = "iso-4217";

export interface CurrencyScaleCutoverResult {
  readonly cutoverAt: string;
  readonly tableVersion: string;
  readonly result: "clear" | "refused";
  readonly approver: null;
  readonly shifted: readonly string[];
}
