import { canonicalAccount, isExpenseAccount } from "./ingestion-chart.js";
import {
  INGESTION_CHECK_IDS,
  INGESTION_FORMULA_VERSION,
  type IngestionAmount,
  type IngestionCheckFailure,
  type IngestionCheckId,
  type IngestionCheckInput,
  type IngestionCheckReport,
  type IngestionCheckResult,
  type IngestionSeverity,
} from "./ingestion-types.js";
import { AnalyticalDecimal, parseMinor } from "./money.js";

const PROFIT_PARENTS = new Set(["gross_profit", "net_income"]);

/**
 * Runs the ingestion validation checks.
 * Amounts are integer minor units. Tolerance is an integer minor-unit string.
 * `prior_period_variance` is advisory (info above 25%, warn above 100%).
 * A report passes when no failure has severity error.
 */
export function runIngestionChecks(input: IngestionCheckInput): IngestionCheckReport {
  const tolerance = parseMinor(input.toleranceMinor);
  const checks = INGESTION_CHECK_IDS.map((checkId) => {
    const failures = CHECKS[checkId](input, tolerance);
    return {
      checkId,
      passed: !failures.some((failure) => failure.severity === "error"),
      failures,
    } satisfies IngestionCheckResult;
  });
  return {
    formulaVersion: INGESTION_FORMULA_VERSION,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

const CHECKS: Record<
  IngestionCheckId,
  (input: IngestionCheckInput, tolerance: bigint) => IngestionCheckFailure[]
> = {
  bs_balance: checkBalanceSheet,
  subtotal_footing: (input, tolerance) => checkFooting(input, tolerance, "subtotal"),
  total_footing: (input, tolerance) => checkFooting(input, tolerance, "total"),
  is_retained_earnings: checkRetainedEarnings,
  period_continuity: checkContinuity,
  sign_conventions: checkSigns,
  cash_ties_bank: checkCashTie,
  bank_rollforward: checkBankRollforward,
  duplicates: checkDuplicates,
  period_coverage: checkCoverage,
  scale_consistency: checkScale,
  currency_consistency: checkCurrency,
  cross_statement_dates: checkDates,
  depreciation_reasonableness: checkDepreciation,
  missing_mandatory: checkMandatory,
  prior_period_variance: checkVariance,
};

function checkBalanceSheet(input: IngestionCheckInput, tolerance: bigint): IngestionCheckFailure[] {
  const groups = new Map<string, IngestionAmount[]>();
  for (const amount of input.amounts) {
    if (amount.statement !== "balance_sheet" || amount.role !== "line") continue;
    const key = `${amount.periodEnd}|${amount.balanceKind}`;
    const list = groups.get(key) ?? [];
    list.push(amount);
    groups.set(key, list);
  }
  const failures: IngestionCheckFailure[] = [];
  for (const [key, lines] of groups) {
    let assets = 0n;
    let liabilities = 0n;
    let equity = 0n;
    let hasAsset = false;
    let hasCreditSide = false;
    const ids: string[] = [];
    for (const line of lines) {
      if (!line.accountCode) continue;
      const account = canonicalAccount(line.accountCode);
      if (!account) continue;
      const minor = parseMinor(line.minor);
      ids.push(line.valueId);
      if (account.report === "asset") {
        assets += minor;
        hasAsset = true;
      } else if (account.report === "liability") {
        liabilities += minor;
        hasCreditSide = true;
      } else if (account.report === "equity" && account.code !== "distributions") {
        equity += minor;
        hasCreditSide = true;
      } else if (account.code === "distributions") {
        equity -= minor < 0n ? -minor : minor;
        hasCreditSide = true;
      }
    }
    if (!hasAsset || !hasCreditSide) continue;
    const expected = liabilities + equity;
    if (abs(assets - expected) <= tolerance) continue;
    failures.push(
      failure("bs_balance", "error", `Balance sheet ${key} does not balance`, {
        expected: expected.toString(),
        actual: assets.toString(),
        diff: (assets - expected).toString(),
        valueIds: ids,
      }),
    );
  }
  return failures;
}

function checkFooting(
  input: IngestionCheckInput,
  tolerance: bigint,
  role: "subtotal" | "total",
): IngestionCheckFailure[] {
  const failures: IngestionCheckFailure[] = [];
  for (const group of footingGroups(input.amounts, role)) {
    const expected = group.components.reduce(
      (sum, component) => sum + contribution(component, group.parent.accountCode),
      0n,
    );
    const actual = parseMinor(group.parent.minor);
    if (abs(actual - expected) <= tolerance) continue;
    failures.push(
      failure(
        role === "subtotal" ? "subtotal_footing" : "total_footing",
        "error",
        `${group.parent.label} does not foot`,
        {
          expected: expected.toString(),
          actual: actual.toString(),
          diff: (actual - expected).toString(),
          valueIds: [group.parent.valueId, ...group.components.map((line) => line.valueId)],
        },
      ),
    );
  }
  return failures;
}

function checkRetainedEarnings(
  input: IngestionCheckInput,
  tolerance: bigint,
): IngestionCheckFailure[] {
  const closings = reByPeriod(input.amounts, "closing");
  const openings = reByPeriod(input.amounts, "opening");
  const periods = [...closings.keys()].sort();
  const failures: IngestionCheckFailure[] = [];
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    if (!period) continue;
    const prior = index === 0 ? null : (periods[index - 1] ?? null);
    const opening = openings.get(period) ?? (prior ? closings.get(prior) : undefined);
    if (!opening) continue;
    const closing = closings.get(period);
    if (!closing) continue;
    const income = incomeLines(input.amounts, period);
    if (income.length === 0) {
      failures.push(
        failure(
          "is_retained_earnings",
          "error",
          `Retained earnings moved at ${period} but no income statement lines were mapped`,
          {
            expected: opening.minor.toString(),
            actual: closing.minor.toString(),
            diff: (closing.minor - opening.minor).toString(),
            valueIds: [opening.valueId, closing.valueId],
          },
        ),
      );
      continue;
    }
    const netIncome = netIncomeMinor(income);
    const distributions = sumAccount(input.amounts, period, "distributions");
    const expected = opening.minor + netIncome - distributions;
    if (abs(closing.minor - expected) <= tolerance) continue;
    failures.push(
      failure(
        "is_retained_earnings",
        "error",
        `Net income does not tie to retained earnings at ${period}`,
        {
          expected: expected.toString(),
          actual: closing.minor.toString(),
          diff: (closing.minor - expected).toString(),
          valueIds: [opening.valueId, closing.valueId, ...income.map((line) => line.valueId)],
        },
      ),
    );
  }
  return failures;
}

function checkContinuity(input: IngestionCheckInput, tolerance: bigint): IngestionCheckFailure[] {
  const openings = new Map<string, IngestionAmount>();
  const closings = new Map<string, IngestionAmount[]>();
  for (const amount of input.amounts) {
    if (amount.statement !== "balance_sheet" || amount.role !== "line" || !amount.accountCode) {
      continue;
    }
    if (amount.balanceKind === "opening") {
      openings.set(`${amount.accountCode}|${amount.periodEnd}`, amount);
    } else if (amount.balanceKind === "closing") {
      const key = `${amount.accountCode}|${amount.periodEnd}`;
      const list = closings.get(key) ?? [];
      list.push(amount);
      closings.set(key, list);
    }
  }
  const periodEnds = [
    ...new Set(
      input.amounts
        .filter((amount) => amount.statement === "balance_sheet")
        .map((amount) => amount.periodEnd),
    ),
  ].sort();
  const failures: IngestionCheckFailure[] = [];
  for (let index = 0; index < periodEnds.length - 1; index += 1) {
    const current = periodEnds[index];
    const next = periodEnds[index + 1];
    if (!current || !next) continue;
    const codes = new Set(
      input.amounts
        .filter((amount) => amount.accountCode && amount.periodEnd === current)
        .map((amount) => amount.accountCode as string),
    );
    for (const code of codes) {
      const opening = openings.get(`${code}|${next}`);
      const priorLines = closings.get(`${code}|${current}`);
      if (!opening || !priorLines || priorLines.length === 0) continue;
      const prior = priorLines.reduce((sum, line) => sum + parseMinor(line.minor), 0n);
      const actual = parseMinor(opening.minor);
      if (abs(actual - prior) <= tolerance) continue;
      failures.push(
        failure(
          "period_continuity",
          "error",
          `${code} closing ${current} does not equal opening ${next}`,
          {
            expected: prior.toString(),
            actual: actual.toString(),
            diff: (actual - prior).toString(),
            valueIds: [opening.valueId, ...priorLines.map((line) => line.valueId)],
          },
        ),
      );
    }
  }
  return failures;
}

function checkSigns(input: IngestionCheckInput): IngestionCheckFailure[] {
  const failures: IngestionCheckFailure[] = [];
  for (const amount of input.amounts) {
    if (amount.role !== "line") continue;
    const minor = parseMinor(amount.minor);
    if (amount.contra && minor > 0n) {
      failures.push(
        failure(
          "sign_conventions",
          "error",
          `${amount.label} is a contra account with a positive balance`,
          {
            expected: "<=0",
            actual: minor.toString(),
            diff: minor.toString(),
            valueIds: [amount.valueId],
          },
        ),
      );
    } else if (!amount.contra && minor < 0n) {
      const account = amount.accountCode ? canonicalAccount(amount.accountCode) : null;
      if (account?.report === "equity") continue;
      failures.push(
        failure(
          "sign_conventions",
          "error",
          `${amount.label} is negative and is not marked contra`,
          {
            expected: ">=0",
            actual: minor.toString(),
            diff: minor.toString(),
            valueIds: [amount.valueId],
          },
        ),
      );
    }
  }
  return failures;
}

function checkCashTie(input: IngestionCheckInput, tolerance: bigint): IngestionCheckFailure[] {
  const banksByPeriod = new Map<string, IngestionCheckInput["banks"][number][]>();
  for (const bank of input.banks) {
    const list = banksByPeriod.get(bank.periodEnd) ?? [];
    list.push(bank);
    banksByPeriod.set(bank.periodEnd, list);
  }
  const failures: IngestionCheckFailure[] = [];
  for (const [period, banks] of banksByPeriod) {
    const cash = input.amounts.filter(
      (amount) =>
        amount.accountCode === "cash" &&
        amount.role === "line" &&
        amount.balanceKind === "closing" &&
        amount.periodEnd === period,
    );
    const actual = banks.reduce((sum, bank) => sum + parseMinor(bank.closingMinor), 0n);
    const ids = [
      ...banks.map((bank) => bank.closingValueId),
      ...cash.map((amount) => amount.valueId),
    ];
    if (cash.length === 0) {
      failures.push(
        failure("cash_ties_bank", "error", `No balance-sheet cash for bank period ${period}`, {
          expected: actual.toString(),
          actual: null,
          diff: null,
          valueIds: ids,
        }),
      );
      continue;
    }
    const expected = cash.reduce((sum, amount) => sum + parseMinor(amount.minor), 0n);
    if (abs(expected - actual) <= tolerance) continue;
    failures.push(
      failure(
        "cash_ties_bank",
        "error",
        `Cash does not tie to the bank closing balance at ${period}`,
        {
          expected: expected.toString(),
          actual: actual.toString(),
          diff: (actual - expected).toString(),
          valueIds: ids,
        },
      ),
    );
  }
  return failures;
}

function checkBankRollforward(
  input: IngestionCheckInput,
  tolerance: bigint,
): IngestionCheckFailure[] {
  const failures: IngestionCheckFailure[] = [];
  for (const bank of input.banks) {
    const movement = bank.transactions.reduce(
      (sum, transaction) => sum + parseMinor(transaction.minor),
      0n,
    );
    const expected = parseMinor(bank.openingMinor) + movement;
    const actual = parseMinor(bank.closingMinor);
    if (abs(actual - expected) <= tolerance) continue;
    failures.push(
      failure(
        "bank_rollforward",
        "error",
        `Bank statement ${bank.documentId} does not roll forward`,
        {
          expected: expected.toString(),
          actual: actual.toString(),
          diff: (actual - expected).toString(),
          valueIds: [
            bank.openingValueId,
            bank.closingValueId,
            ...bank.transactions.map((transaction) => transaction.valueId),
          ],
        },
      ),
    );
  }
  return failures;
}

function checkDuplicates(input: IngestionCheckInput): IngestionCheckFailure[] {
  const failures: IngestionCheckFailure[] = [];
  const documents = new Map<string, string[]>();
  for (const document of input.documents) {
    const ids = documents.get(document.fingerprint) ?? [];
    ids.push(document.documentId);
    documents.set(document.fingerprint, ids);
  }
  for (const [fingerprint, ids] of documents) {
    if (ids.length < 2) continue;
    failures.push(
      failure("duplicates", "error", `Duplicate document fingerprint ${fingerprint}`, {
        expected: "1",
        actual: String(ids.length),
        diff: String(ids.length - 1),
        valueIds: ids,
      }),
    );
  }
  const transactions = new Map<string, string[]>();
  for (const bank of input.banks) {
    for (const transaction of bank.transactions) {
      const ids = transactions.get(transaction.fingerprint) ?? [];
      ids.push(transaction.valueId);
      transactions.set(transaction.fingerprint, ids);
    }
  }
  for (const [fingerprint, ids] of transactions) {
    if (ids.length < 2) continue;
    failures.push(
      failure("duplicates", "error", `Duplicate bank transaction ${fingerprint}`, {
        expected: "1",
        actual: String(ids.length),
        diff: String(ids.length - 1),
        valueIds: ids,
      }),
    );
  }
  const lines = new Map<string, IngestionAmount[]>();
  for (const amount of input.amounts) {
    if (amount.role !== "line") continue;
    const key = [
      amount.documentId,
      amount.label.trim().toLowerCase(),
      amount.periodEnd,
      amount.minor,
      amount.balanceKind,
    ].join("|");
    const list = lines.get(key) ?? [];
    list.push(amount);
    lines.set(key, list);
  }
  for (const list of lines.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    failures.push(
      failure("duplicates", "error", `Duplicate statement line ${first?.label ?? ""}`, {
        expected: "1",
        actual: String(list.length),
        diff: String(list.length - 1),
        valueIds: list.map((amount) => amount.valueId),
      }),
    );
  }
  return failures;
}

function checkCoverage(input: IngestionCheckInput): IngestionCheckFailure[] {
  if (!input.coverage) return [];
  const expected = expectedPeriods(
    input.coverage.start,
    input.coverage.end,
    input.coverage.cadence,
  );
  const present = new Set<string>();
  for (const amount of input.amounts) present.add(amount.periodEnd.slice(0, 7));
  for (const bank of input.banks) {
    for (const month of monthsBetween(bank.periodStart, bank.periodEnd)) present.add(month);
  }
  const missing = expected.filter((month) => !present.has(month));
  if (missing.length === 0) return [];
  return [
    failure("period_coverage", "error", `Period coverage is missing ${missing.join(", ")}`, {
      expected: expected.join(","),
      actual: [...present].sort().join(","),
      diff: missing.join(","),
      valueIds: input.amounts.map((amount) => amount.valueId),
    }),
  ];
}

function checkScale(input: IngestionCheckInput): IngestionCheckFailure[] {
  const failures: IngestionCheckFailure[] = [];
  const scales = [...new Set(input.amounts.map((amount) => amount.scale))];
  if (scales.length > 1) {
    failures.push(
      failure("scale_consistency", "error", `Mixed amount scales: ${scales.join(", ")}`, {
        expected: scales[0] ?? "units",
        actual: scales.join(","),
        diff: null,
        valueIds: input.amounts.map((amount) => amount.valueId),
      }),
    );
  }
  const byAccount = new Map<string, IngestionAmount[]>();
  for (const amount of input.amounts) {
    if (amount.role !== "line" || !amount.accountCode) continue;
    const minor = abs(parseMinor(amount.minor));
    if (minor === 0n) continue;
    const list = byAccount.get(amount.accountCode) ?? [];
    list.push(amount);
    byAccount.set(amount.accountCode, list);
  }
  for (const lines of byAccount.values()) {
    const magnitudes = lines.map((line) => abs(parseMinor(line.minor)));
    const min = magnitudes.reduce((best, value) => (value < best ? value : best));
    const max = magnitudes.reduce((best, value) => (value > best ? value : best));
    if (min > 0n && max / min >= 100_000n) {
      failures.push(
        failure(
          "scale_consistency",
          "error",
          `${lines[0]?.label ?? "A line"} magnitudes differ by ${(max / min).toString()}x`,
          {
            expected: min.toString(),
            actual: max.toString(),
            diff: (max / min).toString(),
            valueIds: lines.map((line) => line.valueId),
          },
        ),
      );
    }
  }
  return failures;
}

function checkCurrency(input: IngestionCheckInput): IngestionCheckFailure[] {
  const currencies = new Set<string>([input.currency]);
  const ids: string[] = [];
  for (const amount of input.amounts) {
    currencies.add(amount.currency);
    if (amount.currency !== input.currency) ids.push(amount.valueId);
  }
  for (const bank of input.banks) {
    currencies.add(bank.currency);
    if (bank.currency !== input.currency) ids.push(bank.openingValueId);
  }
  if (currencies.size <= 1) return [];
  return [
    failure("currency_consistency", "error", `Mixed currencies: ${[...currencies].join(", ")}`, {
      expected: input.currency,
      actual: [...currencies].join(","),
      diff: null,
      valueIds: ids,
    }),
  ];
}

function checkDates(input: IngestionCheckInput): IngestionCheckFailure[] {
  const income = new Set(
    input.amounts
      .filter((amount) => amount.statement === "income_statement")
      .map((amount) => amount.periodEnd),
  );
  const balance = new Set(
    input.amounts
      .filter((amount) => amount.statement === "balance_sheet" && amount.balanceKind === "closing")
      .map((amount) => amount.periodEnd),
  );
  const failures: IngestionCheckFailure[] = [];
  if (income.size > 0 && balance.size > 0) {
    for (const period of income) {
      if (balance.has(period)) continue;
      failures.push(
        failure(
          "cross_statement_dates",
          "error",
          `Income statement period ${period} has no balance sheet with the same date`,
          {
            expected: period,
            actual: [...balance].sort().join(","),
            diff: null,
            valueIds: input.amounts
              .filter((amount) => amount.periodEnd === period)
              .map((amount) => amount.valueId),
          },
        ),
      );
    }
  }
  for (const bank of input.banks) {
    if (balance.size === 0 || balance.has(bank.periodEnd)) continue;
    failures.push(
      failure(
        "cross_statement_dates",
        "error",
        `Bank period ${bank.periodEnd} does not match a balance sheet date`,
        {
          expected: [...balance].sort().join(","),
          actual: bank.periodEnd,
          diff: null,
          valueIds: [bank.closingValueId],
        },
      ),
    );
  }
  return failures;
}

function checkDepreciation(input: IngestionCheckInput): IngestionCheckFailure[] {
  const periods = new Set(
    input.amounts.filter((amount) => amount.accountCode === "depreciation").map((a) => a.periodEnd),
  );
  const failures: IngestionCheckFailure[] = [];
  for (const period of periods) {
    const depLines = input.amounts.filter(
      (amount) =>
        amount.accountCode === "depreciation" &&
        amount.role === "line" &&
        amount.periodEnd === period,
    );
    const assetLines = input.amounts.filter(
      (amount) =>
        amount.accountCode === "fixed_assets" &&
        amount.role === "line" &&
        amount.balanceKind === "closing" &&
        amount.periodEnd === period,
    );
    const dep = depLines.reduce((sum, line) => sum + parseMinor(line.minor), 0n);
    const gross = assetLines.reduce((sum, line) => sum + parseMinor(line.minor), 0n);
    const ids = [...depLines, ...assetLines].map((line) => line.valueId);
    if (assetLines.length === 0 || gross <= 0n) {
      if (dep > 0n) {
        failures.push(
          failure(
            "depreciation_reasonableness",
            "error",
            `Depreciation at ${period} has no gross fixed assets`,
            { expected: "0", actual: dep.toString(), diff: dep.toString(), valueIds: ids },
          ),
        );
      }
      continue;
    }
    if (dep > gross) {
      failures.push(
        failure(
          "depreciation_reasonableness",
          "error",
          `Depreciation at ${period} exceeds gross fixed assets`,
          {
            expected: gross.toString(),
            actual: dep.toString(),
            diff: (dep - gross).toString(),
            valueIds: ids,
          },
        ),
      );
      continue;
    }
    const span = depLines[0]?.spanMonths ?? 12;
    const months = span >= 1 && span <= 36 ? BigInt(span) : 12n;
    const annualized = (dep * 12n) / months;
    if (annualized * 100n > gross * 40n) {
      failures.push(
        failure(
          "depreciation_reasonableness",
          "warn",
          `Annualized depreciation at ${period} exceeds 40% of gross fixed assets`,
          {
            expected: ((gross * 40n) / 100n).toString(),
            actual: annualized.toString(),
            diff: (annualized - (gross * 40n) / 100n).toString(),
            valueIds: ids,
          },
        ),
      );
    }
  }
  return failures;
}

function checkMandatory(input: IngestionCheckInput): IngestionCheckFailure[] {
  const present = new Set(
    input.amounts
      .filter((amount) => amount.role === "line" && amount.accountCode)
      .map((amount) => amount.accountCode as string),
  );
  return input.mandatoryCodes
    .filter((code) => !present.has(code))
    .map((code) =>
      failure("missing_mandatory", "error", `Mandatory line ${code} is missing`, {
        expected: code,
        actual: null,
        diff: null,
        valueIds: [],
      }),
    );
}

/**
 * Advisory 16th check. Info when the absolute move exceeds 25% of the prior
 * balance. Warn when it exceeds 100%. A zero prior with a non-zero current is a warn.
 */
function checkVariance(input: IngestionCheckInput): IngestionCheckFailure[] {
  const groups = new Map<string, IngestionAmount[]>();
  for (const amount of input.amounts) {
    if (amount.role !== "line" || !amount.accountCode || amount.balanceKind === "opening") continue;
    const key = `${amount.statement}|${amount.accountCode}`;
    const list = groups.get(key) ?? [];
    list.push(amount);
    groups.set(key, list);
  }
  const failures: IngestionCheckFailure[] = [];
  for (const list of groups.values()) {
    const byPeriod = new Map<string, bigint>();
    const ids = new Map<string, string[]>();
    for (const amount of list) {
      byPeriod.set(
        amount.periodEnd,
        (byPeriod.get(amount.periodEnd) ?? 0n) + parseMinor(amount.minor),
      );
      const bucket = ids.get(amount.periodEnd) ?? [];
      bucket.push(amount.valueId);
      ids.set(amount.periodEnd, bucket);
    }
    const periods = [...byPeriod.keys()].sort();
    for (let index = 1; index < periods.length; index += 1) {
      const priorKey = periods[index - 1];
      const currentKey = periods[index];
      if (!priorKey || !currentKey) continue;
      const prior = byPeriod.get(priorKey) ?? 0n;
      const current = byPeriod.get(currentKey) ?? 0n;
      if (prior === 0n && current === 0n) continue;
      const ratio =
        prior === 0n
          ? new AnalyticalDecimal(2)
          : new AnalyticalDecimal((current - prior).toString()).div(prior.toString()).abs();
      const severity: IngestionSeverity | null = ratio.gte(1)
        ? "warn"
        : ratio.gte("0.25")
          ? "info"
          : null;
      if (!severity) continue;
      failures.push(
        failure(
          "prior_period_variance",
          severity,
          `${list[0]?.accountCode ?? "line"} moved ${ratio.toFixed(4)} from ${priorKey} to ${currentKey}`,
          {
            expected: prior.toString(),
            actual: current.toString(),
            diff: (current - prior).toString(),
            valueIds: [...(ids.get(priorKey) ?? []), ...(ids.get(currentKey) ?? [])],
          },
        ),
      );
    }
  }
  return failures;
}

function contribution(component: IngestionAmount, parentCode: string | null): bigint {
  const value = parseMinor(component.minor);
  if (parentCode && PROFIT_PARENTS.has(parentCode) && isExpenseAccount(component.accountCode)) {
    return -value;
  }
  return value;
}

interface FootingGroup {
  readonly parent: IngestionAmount;
  readonly components: readonly IngestionAmount[];
}

function footingGroups(
  amounts: readonly IngestionAmount[],
  role: "subtotal" | "total",
): FootingGroup[] {
  const buckets = new Map<string, IngestionAmount[]>();
  for (const amount of amounts) {
    if (amount.balanceKind === "opening") continue;
    const key = `${amount.documentId}|${amount.statement}|${amount.periodEnd}`;
    const list = buckets.get(key) ?? [];
    list.push(amount);
    buckets.set(key, list);
  }
  const groups: FootingGroup[] = [];
  for (const list of buckets.values()) {
    list.sort((left, right) => left.order - right.order);
    let lines: IngestionAmount[] = [];
    let slice = 0;
    for (const amount of list) {
      if (amount.role === "line") lines.push(amount);
      if (amount.role === "subtotal" && role === "subtotal") {
        groups.push({ parent: amount, components: lines.slice(slice) });
      }
      if (amount.role === "subtotal") slice = lines.length;
      if (amount.role === "total" && role === "total") {
        groups.push({ parent: amount, components: lines.slice() });
        lines = [];
        slice = 0;
      }
    }
  }
  return groups;
}

function reByPeriod(
  amounts: readonly IngestionAmount[],
  kind: "closing" | "opening",
): Map<string, { minor: bigint; valueId: string }> {
  const map = new Map<string, { minor: bigint; valueId: string }>();
  for (const amount of amounts) {
    if (amount.accountCode !== "retained_earnings" || amount.role !== "line") continue;
    if (amount.balanceKind !== kind) continue;
    const current = map.get(amount.periodEnd);
    map.set(amount.periodEnd, {
      minor: (current?.minor ?? 0n) + parseMinor(amount.minor),
      valueId: amount.valueId,
    });
  }
  return map;
}

function incomeLines(amounts: readonly IngestionAmount[], period: string): IngestionAmount[] {
  return amounts.filter((amount) => {
    if (amount.statement !== "income_statement" || amount.role !== "line") return false;
    if (amount.periodEnd !== period || !amount.accountCode) return false;
    const account = canonicalAccount(amount.accountCode);
    return account?.report === "revenue" || account?.report === "expense";
  });
}

function netIncomeMinor(lines: readonly IngestionAmount[]): bigint {
  let net = 0n;
  for (const line of lines) {
    const minor = parseMinor(line.minor);
    if (isExpenseAccount(line.accountCode)) net -= minor;
    else net += minor;
  }
  return net;
}

function sumAccount(amounts: readonly IngestionAmount[], period: string, code: string): bigint {
  return amounts
    .filter(
      (amount) =>
        amount.accountCode === code && amount.role === "line" && amount.periodEnd === period,
    )
    .reduce((sum, amount) => sum + parseMinor(amount.minor), 0n);
}

function expectedPeriods(start: string, end: string, cadence: "monthly" | "quarterly"): string[] {
  const months = monthsBetween(start, end);
  if (cadence === "monthly") return months;
  return months.filter((_, index) => index % 3 === 2 || index === months.length - 1);
}

function monthsBetween(start: string, end: string): string[] {
  const startParts = start.split("-");
  const endParts = end.split("-");
  let year = Number(startParts[0]);
  let month = Number(startParts[1]);
  const endYear = Number(endParts[0]);
  const endMonth = Number(endParts[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return [];
  const months: string[] = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
    if (months.length > 240) break;
  }
  return months;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function failure(
  checkId: IngestionCheckId,
  severity: IngestionSeverity,
  message: string,
  detail: {
    expected: string | null;
    actual: string | null;
    diff: string | null;
    valueIds: readonly string[];
  },
): IngestionCheckFailure {
  return { checkId, severity, message, ...detail };
}
