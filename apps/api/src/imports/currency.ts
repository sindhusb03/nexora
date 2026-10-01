const ISO = /\b(?:USD|EUR|GBP|INR|AED|SGD|AUD|JPY|CAD|NZD|HKD|CHF|CNY|SEK|NOK|DKK|ZAR)\b/gi;

/** Bank narration describes counterparties, not the denomination of the account. */
export function currencyEvidence(
  text: string,
  functionalCurrency: string | null = null,
): { currency: string | null; conflict: boolean } {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex(
    (line) =>
      /\bdate\b/i.test(line) &&
      /\b(?:amount|debit|credit|dr|cr|withdrawals?|deposits?|paid in|paid out)\b/i.test(line),
  );
  const metadata = (header >= 0 ? lines.slice(0, header + 1) : lines).join("\n");
  const codes = new Set([...metadata.matchAll(ISO)].map((m) => m[0].toUpperCase()));
  if (codes.size > 1) return { currency: null, conflict: true };
  const symbols = new Set<string>();
  for (const [pattern, currency] of [
    [/US\$/, "USD"],
    [/(?<![A-Za-z])S\$/, "SGD"],
    [/(?<![A-Za-z])A\$/, "AUD"],
    [/(?<![A-Za-z])C\$/, "CAD"],
    [/NZ\$/, "NZD"],
    [/HK\$/, "HKD"],
    [/₹/, "INR"],
    [/€/, "EUR"],
    [/£/, "GBP"],
  ] as const) {
    if (pattern.test(metadata)) symbols.add(currency);
  }
  const currency = [...codes][0] ?? functionalCurrency ?? [...symbols][0] ?? null;
  // An explicit foreign-currency statement keeps its denomination; the kernel's
  // currency check holds it before posting into a different functional currency.
  const evidence = new Set([
    ...codes,
    ...symbols,
    ...(!codes.size && functionalCurrency ? [functionalCurrency] : []),
  ]);
  // Rank to identify the candidate, but never commit contradictory denominations.
  return { currency, conflict: evidence.size > 1 };
}
