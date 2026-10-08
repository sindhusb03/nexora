import { minorToDisplay, withCurrency } from "../studio/format";

/** Presentation only. Amounts stay integer minor-unit strings from the kernel. */

const MINOR = /^-?\d+$/;

export type RateType = "closing" | "historical" | "average";

export interface SourceLine {
  readonly accountId: string;
  readonly rateType: RateType;
  readonly debitPositiveMinor: string;
}

export interface TranslatedLine {
  readonly accountId: string;
  readonly debitPositiveMinor: string;
}

export interface EntityTranslation {
  readonly entityId: string;
  readonly periodId: string;
  readonly sourceCurrency: string;
  readonly ctaMinor: string;
  readonly sourceLines: readonly SourceLine[];
  readonly lines: readonly TranslatedLine[];
}

export interface TranslationView {
  readonly groupCurrency: string;
  readonly ctaAccountId: string;
  readonly ctaMinor: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly calculationRunId: string;
  readonly engineVersion: string | null;
  readonly formulaVersion: string | null;
  readonly lines: readonly TranslatedLine[];
  readonly entities: readonly EntityTranslation[];
}

export interface RateTripleInput {
  readonly closing: string;
  readonly historical: string;
  readonly average: string;
}

export interface TranslateRequest {
  readonly ctaAccountId: string;
  readonly entities: readonly { readonly entityId: string; readonly periodId: string }[];
  readonly rates: readonly {
    readonly sourceCurrency: string;
    readonly closing: RateBody;
    readonly historical: RateBody;
    readonly average: RateBody;
  }[];
}

interface RateBody {
  readonly rateSetId: string;
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly rounding: "half_even";
}

export interface DisplayRow {
  readonly key: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly entityLabel: string;
  readonly sourceMinor: string | null;
  readonly sourceCurrency: string | null;
  readonly rateType: RateType | "cta";
  readonly rate: string | null;
  readonly translatedMinor: string;
  readonly cta: boolean;
}

export function formatMinorAccounting(minor: string | null, currency: string): string {
  if (minor === null || !MINOR.test(minor)) return "—";
  const negative = minor.startsWith("-");
  const display = minorToDisplay(negative ? minor.slice(1) : minor, currency);
  const formatted = withCurrency(display, currency);
  return negative ? `(${formatted})` : formatted;
}

/** Sums server lines with integer minor units. This checks the kernel total; it does not translate. */
export function controlTotal(lines: readonly TranslatedLine[]): {
  readonly minor: string;
  readonly balances: boolean;
} {
  let total = 0n;
  for (const line of lines) {
    if (!MINOR.test(line.debitPositiveMinor)) {
      return { minor: "0", balances: false };
    }
    total += BigInt(line.debitPositiveMinor);
  }
  return { minor: total.toString(), balances: total === 0n };
}

export function buildTranslateRequest(input: {
  readonly ctaAccountId: string;
  readonly reportingCurrency: string;
  readonly entities: readonly {
    readonly entityId: string;
    readonly periodId: string;
    readonly currency: string;
  }[];
  readonly rates: Readonly<Record<string, RateTripleInput>>;
}): TranslateRequest {
  const currencies = [...new Set(input.entities.map((entity) => entity.currency))].sort();
  return {
    ctaAccountId: input.ctaAccountId.trim(),
    entities: input.entities.map((entity) => ({
      entityId: entity.entityId,
      periodId: entity.periodId,
    })),
    rates: currencies.map((currency) => {
      const entered = input.rates[currency];
      return {
        sourceCurrency: currency,
        closing: rateBody(currency, input.reportingCurrency, entered?.closing ?? ""),
        historical: rateBody(currency, input.reportingCurrency, entered?.historical ?? ""),
        average: rateBody(currency, input.reportingCurrency, entered?.average ?? ""),
      };
    }),
  };
}

export function displayRows(
  view: TranslationView,
  names: {
    readonly entityName: (entityId: string) => string;
    readonly accountName: (accountId: string) => string;
    readonly rateFor: (currency: string, rateType: RateType) => string | null;
  },
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const entity of view.entities) {
    const translated = new Map(
      entity.lines.map((line) => [line.accountId, line.debitPositiveMinor]),
    );
    for (const source of entity.sourceLines) {
      if (source.accountId === view.ctaAccountId) continue;
      rows.push({
        key: `${entity.entityId}:${source.accountId}`,
        accountId: source.accountId,
        accountLabel: names.accountName(source.accountId),
        entityLabel: names.entityName(entity.entityId),
        sourceMinor: source.debitPositiveMinor,
        sourceCurrency: entity.sourceCurrency,
        rateType: source.rateType,
        rate: names.rateFor(entity.sourceCurrency, source.rateType),
        translatedMinor: translated.get(source.accountId) ?? "0",
        cta: false,
      });
    }
  }
  rows.push({
    key: `cta:${view.ctaAccountId}`,
    accountId: view.ctaAccountId,
    accountLabel: "Cumulative translation adjustment",
    entityLabel: "Group",
    sourceMinor: null,
    sourceCurrency: null,
    rateType: "cta",
    rate: null,
    translatedMinor: view.ctaMinor,
    cta: true,
  });
  return rows;
}

export function explainConsolidationError(
  status: number,
  code: string,
  message: string,
): { readonly title: string; readonly detail: string } {
  if (code === "FX_RATE_MISSING") {
    return {
      title: "A rate is missing",
      detail:
        "Enter a closing rate, a historical rate, and an average rate for every source currency. When the entity already uses the group currency, each of those rates is 1.",
    };
  }
  if (code === "FX_INVALID_RATE" && /exactly 1/i.test(message)) {
    return {
      title: "Identity rate must be 1",
      detail:
        "This entity already reports in the group currency. The closing, historical, and average rates must each be exactly 1.",
    };
  }
  if (code === "FX_INVALID_RATE") {
    return {
      title: "Those rates cannot be used",
      detail:
        message ||
        "Each rate must convert the entity currency into the group reporting currency, and the CTA account must not already be an account in the books.",
    };
  }
  if (status === 422 && code === "FIN_INVALID_PERIOD") {
    return {
      title: "The periods do not match",
      detail:
        "Every entity in the translation must use a period with the same start date and the same end date.",
    };
  }
  if (status === 422 && code === "FIN_STATEMENT_IMBALANCE") {
    return {
      title: "The posted books cannot be translated",
      detail:
        message || "The posted journals for this period do not produce a balanced trial balance.",
    };
  }
  if (status === 422 && code === "FIN_INVALID_JOURNAL_LINE") {
    return {
      title: "The entity scope is not valid",
      detail: message || "Each entity can appear once in the translation.",
    };
  }
  if (status === 400 && code === "VALIDATION_FAILED") {
    return {
      title: "The translation request is incomplete",
      detail:
        "Choose a group, at least one entity and its period, a CTA account, and a closing, historical, and average rate for each source currency. Rates are positive decimals such as 0.90 or 1.",
    };
  }
  if (code === "CALLER_TRIAL_BALANCE_REJECTED") {
    return {
      title: "Trial balance lines were rejected",
      detail:
        "The server builds the trial balance from posted journals. This screen does not send amounts.",
    };
  }
  if (status === 400 || status === 422) {
    return {
      title: status === 422 ? "Translation was refused" : "Translation was rejected",
      detail: message || "The kernel did not translate this group.",
    };
  }
  return {
    title: "Translation failed",
    detail: message || "The kernel did not translate this group.",
  };
}

export function decodeTranslation(value: unknown): TranslationView | null {
  if (!isRecord(value)) return null;
  const groupCurrency = str(value, "groupCurrency");
  const ctaAccountId = str(value, "ctaAccountId");
  const ctaMinor = str(value, "ctaMinor");
  const inputHash = str(value, "inputHash");
  const outputHash = str(value, "outputHash");
  const calculationRunId = str(value, "calculationRunId");
  const lines = decodeTranslatedLines(value.lines);
  const entities = decodeEntities(value.entities);
  if (
    groupCurrency === null ||
    ctaAccountId === null ||
    ctaMinor === null ||
    inputHash === null ||
    outputHash === null ||
    calculationRunId === null ||
    lines === null ||
    entities === null
  ) {
    return null;
  }
  return {
    groupCurrency,
    ctaAccountId,
    ctaMinor,
    inputHash,
    outputHash,
    calculationRunId,
    engineVersion: str(value, "engineVersion"),
    formulaVersion: str(value, "formulaVersion"),
    lines,
    entities,
  };
}

export function rateTypeLabel(rateType: RateType | "cta"): string {
  switch (rateType) {
    case "closing":
      return "Closing";
    case "historical":
      return "Historical";
    case "average":
      return "Average";
    case "cta":
      return "CTA";
  }
}

function rateBody(base: string, quote: string, rate: string): RateBody {
  return {
    rateSetId: `${base}-${quote}`,
    base,
    quote,
    rate: rate.trim(),
    rounding: "half_even",
  };
}

function decodeEntities(value: unknown): EntityTranslation[] | null {
  if (!Array.isArray(value)) return null;
  const entities: EntityTranslation[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const entityId = str(item, "entityId");
    const periodId = str(item, "periodId");
    const sourceCurrency = str(item, "sourceCurrency");
    const ctaMinor = str(item, "ctaMinor");
    const sourceLines = decodeSourceLines(item.sourceLines);
    const lines = decodeTranslatedLines(item.lines);
    if (
      entityId === null ||
      periodId === null ||
      sourceCurrency === null ||
      ctaMinor === null ||
      sourceLines === null ||
      lines === null
    ) {
      return null;
    }
    entities.push({ entityId, periodId, sourceCurrency, ctaMinor, sourceLines, lines });
  }
  return entities;
}

function decodeSourceLines(value: unknown): SourceLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: SourceLine[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const accountId = str(item, "accountId");
    const rateType = str(item, "rateType");
    const debitPositiveMinor = str(item, "debitPositiveMinor");
    if (
      accountId === null ||
      debitPositiveMinor === null ||
      (rateType !== "closing" && rateType !== "historical" && rateType !== "average")
    ) {
      return null;
    }
    lines.push({ accountId, rateType, debitPositiveMinor });
  }
  return lines;
}

function decodeTranslatedLines(value: unknown): TranslatedLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: TranslatedLine[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const accountId = str(item, "accountId");
    const debitPositiveMinor = str(item, "debitPositiveMinor");
    if (accountId === null || debitPositiveMinor === null) return null;
    lines.push({ accountId, debitPositiveMinor });
  }
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}
