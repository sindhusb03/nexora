type Order = "DMY" | "MDY";
export interface BankPeriod {
  start: string;
  end: string;
}
type Resolve = (raw: string, order: Order | "unknown") => string | null;

/** Both interpretations must satisfy the entire column, not just the current row. */
export function bankDates(
  tokens: readonly string[],
  context: string,
  currency: string | null,
  resolve: Resolve,
): { dates: string[]; period: BankPeriod | null } | null {
  const explicit = new Set<Order>();
  if (/\b(?:en-US|MM[/-]DD[/-]YYYY)\b/i.test(context)) explicit.add("MDY");
  if (/\b(?:en-GB|en-IN|en-AU|en-SG|DD[/-]MM[/-]YYYY)\b/i.test(context)) explicit.add("DMY");
  if (explicit.size > 1) return null;
  const ranges = [
    ...context.matchAll(/(?:statement\s+)?period\s*:?\s*(.+?)\s+(?:to|through|[-–])\s+([^\n]+)/gi),
  ];
  const candidates: { dates: string[]; period: BankPeriod | null; order: Order }[] = [];
  for (const order of ["DMY", "MDY"] as const) {
    if (explicit.size && !explicit.has(order)) continue;
    let period: BankPeriod | null = null;
    let invalid = false;
    for (const range of ranges) {
      const start = resolve(range[1]!.trim(), order);
      const end = resolve(range[2]!.trim(), order);
      if (
        !start ||
        !end ||
        start > end ||
        (period && (start !== period.start || end !== period.end))
      ) {
        invalid = true;
        break;
      }
      period = { start, end };
    }
    if (invalid) continue;
    const dates: string[] = [];
    for (const token of tokens) {
      let date = resolve(token, order);
      if (!date && period && /^\d{1,2}[-\s][a-z]{3,9}$/i.test(token)) {
        const possible: string[] = [];
        const startYear = Number(period.start.slice(0, 4));
        const endYear = Number(period.end.slice(0, 4));
        if (endYear - startYear > 5) {
          invalid = true;
          break;
        }
        for (let year = startYear; year <= endYear; year++) {
          const candidate = resolve(`${token} ${year}`, order);
          if (candidate && candidate >= period.start && candidate <= period.end)
            possible.push(candidate);
        }
        if (possible.length === 1) date = possible[0]!;
      }
      if (!date || (period && (date < period.start || date > period.end))) {
        invalid = true;
        break;
      }
      dates.push(date);
    }
    if (!invalid) candidates.push({ dates, period, order });
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) return null;
  if (
    JSON.stringify(candidates[0]!.dates) === JSON.stringify(candidates[1]!.dates) &&
    JSON.stringify(candidates[0]!.period) === JSON.stringify(candidates[1]!.period)
  )
    return candidates[0]!;
  // Only use ordering when one complete interpretation is monotonic. Two rows
  // alone can be ascending or descending under either interpretation.
  const monotonic = candidates.filter(
    (c) =>
      c.dates.length >= 3 &&
      (c.dates.every((d, i) => i === 0 || d >= c.dates[i - 1]!) ||
        c.dates.every((d, i) => i === 0 || d <= c.dates[i - 1]!)),
  );
  const regional: Order | null = ["INR", "GBP", "SGD", "AUD"].includes(currency ?? "")
    ? "DMY"
    : null;
  if (monotonic.length === 1) {
    if (regional && monotonic[0]!.order !== regional) return null;
    return monotonic[0]!;
  }
  if (regional) return candidates.find((c) => c.order === regional) ?? null;
  // USD/AED/EUR accounts are international; their currency alone cannot fix dates.
  return null;
}
