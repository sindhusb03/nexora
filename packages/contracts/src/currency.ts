const CURRENCY_CODE = /^[A-Z]{3}$/;

// Mirrors the kernel currency scale table (packages/kernel/src/money.ts); guarded by an equality test in apps/web/test/ingestion-adapter.test.ts.
const SCALE_BY_CURRENCY: Record<string, number> = {
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  JPY: 0,
  KRW: 0,
  VND: 0,
};

export function currencyScale(currency: string): number {
  if (!CURRENCY_CODE.test(currency)) {
    throw new Error(`Invalid currency code ${currency}`);
  }
  return SCALE_BY_CURRENCY[currency] ?? 2;
}
