/**
 * One-time cutover for the ISO 4217 minor-unit table.
 * Migrations do not run this check. The check script reads this record and
 * looks only at rows created before cutoverAt, so a later zero-decimal or
 * three-decimal entity does not block a deploy.
 */
export const CURRENCY_SCALE_CUTOVER = {
  cutoverAt: "2026-10-09T00:00:00.000Z",
  tableVersion: "iso-4217",
  result: "clear",
  approver: "Sindhu Bharadwaj",
} as const;

export interface CurrencyScaleCutoverResult {
  readonly cutoverAt: string;
  readonly tableVersion: string;
  readonly result: "clear" | "refused";
  readonly approver: string;
  readonly shifted: readonly string[];
}
