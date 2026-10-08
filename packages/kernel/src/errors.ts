export const KERNEL_ERROR_CODES = [
  "FIN_UNBALANCED_JOURNAL",
  "FIN_INVALID_JOURNAL_LINE",
  "FIN_PERIOD_CLOSED",
  "FIN_INVALID_PERIOD",
  "FIN_OVERLAPPING_PERIOD",
  "FIN_VERSION_CONFLICT",
  "FIN_AMOUNT_SCALE",
  "FIN_CURRENCY_MISMATCH",
  "FIN_CURRENCY_UNSUPPORTED",
  "FIN_IMMUTABLE_RECORD",
  "FIN_STATEMENT_IMBALANCE",
  "FIN_NOT_FOUND",
  "FIN_IDEMPOTENCY_MISMATCH",
  "FIN_LIMIT_EXCEEDED",
  "AUTH_SCOPE_DENIED",
  "FX_RATE_MISSING",
  "FX_INVALID_RATE",
  "CALC_CYCLE_DETECTED",
  "CALC_FAILED",
  "CALC_INVALID_NODE",
  "VALUATION_INVALID_ASSUMPTION",
  "PUBLISH_BLOCKED",
  "REGION_MISMATCH",
  "TENANT_REGION_CONFLICT",
  "TENANT_SUSPENDED",
  "TENANT_ISOLATION",
] as const;

export type KernelErrorCode = (typeof KERNEL_ERROR_CODES)[number];

export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = "KernelError";
    this.code = code;
  }
}

export function isKernelError(error: unknown): error is KernelError {
  return error instanceof KernelError;
}
