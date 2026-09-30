/** Nazareno Services demo books. Amounts are integer cents. The kernel posts and derives statements. */

export interface BookLine {
  readonly code: string;
  readonly debitCents: bigint;
  readonly creditCents: bigint;
}

export interface BookJournal {
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly lines: readonly BookLine[];
}

export const DEMO_ACCOUNTS = [
  { code: "1000", name: "Cash", report: "asset", cashFlow: "cash", retainedEarnings: false },
  {
    code: "1100",
    name: "Accounts receivable",
    report: "asset",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  { code: "1500", name: "Equipment", report: "asset", cashFlow: "cfi", retainedEarnings: false },
  {
    code: "2000",
    name: "Accounts payable",
    report: "liability",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  {
    code: "2100",
    name: "Deferred revenue",
    report: "liability",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  {
    code: "2500",
    name: "Term loan",
    report: "liability",
    cashFlow: "cff",
    retainedEarnings: false,
  },
  {
    code: "3000",
    name: "Common stock",
    report: "equity",
    cashFlow: "cff",
    retainedEarnings: false,
  },
  {
    code: "3100",
    name: "Retained earnings",
    report: "equity",
    cashFlow: "non_cash",
    retainedEarnings: true,
  },
  {
    code: "3200",
    name: "Distributions",
    report: "equity",
    cashFlow: "distribution",
    retainedEarnings: false,
  },
  {
    code: "4000",
    name: "Patient services",
    report: "revenue",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  {
    code: "4100",
    name: "Device sales",
    report: "revenue",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  {
    code: "5000",
    name: "Clinical supplies",
    report: "expense",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  {
    code: "6100",
    name: "Clinical payroll",
    report: "expense",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  { code: "6200", name: "Occupancy", report: "expense", cashFlow: "cfo", retainedEarnings: false },
  {
    code: "6300",
    name: "Software and systems",
    report: "expense",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
  {
    code: "6400",
    name: "Professional fees",
    report: "expense",
    cashFlow: "cfo",
    retainedEarnings: false,
  },
] as const;

export const PLANNING_DRIVERS = {
  revenueMinor: "15800000",
  growthRate: "0.012",
  grossMargin: "0.78",
  opexMinor: "6430000",
} as const;

export const PLAN_BUDGET = {
  revenueMinor: "15000000",
  expensesMinor: "11000000",
  netIncomeMinor: "4000000",
} as const;

export const QOE_ADJUSTMENTS = [
  {
    adjustmentId: "adj-owner-travel",
    sourceRowId: "src-owner-travel",
    amount: "450000",
    label: "Owner personal travel",
    taxonomy: "owner",
  },
  {
    adjustmentId: "adj-litigation",
    sourceRowId: "src-litigation",
    amount: "1200000",
    label: "One-time litigation",
    taxonomy: "one-time",
  },
] as const;

const ACTIVITY_MONTHS = 21;

export function demoJournals(): readonly BookJournal[] {
  const journals: BookJournal[] = [openingJournal()];
  for (let index = 0; index < ACTIVITY_MONTHS; index += 1) {
    journals.push(activityJournal(index));
  }
  for (const journal of journals) {
    const debit = journal.lines.reduce((sum, line) => sum + line.debitCents, 0n);
    const credit = journal.lines.reduce((sum, line) => sum + line.creditCents, 0n);
    if (debit !== credit) {
      throw new Error(`Demo journal ${journal.label} does not balance`);
    }
  }
  return journals;
}

export function centsToMajor(cents: bigint): string {
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function cashWeekInputs(kind: "base" | "downside"): readonly {
  weekIndex: string;
  label: string;
  inflowMinor: string;
  outflowMinor: string;
}[] {
  return Array.from({ length: 13 }, (_, index) => {
    const week = index + 1;
    const inflow = week % 2 === 1 ? 7_200_000n : 4_800_000n;
    let outflow = 5_400_000n;
    if (week === 2 || week === 6) outflow += 2_300_000n;
    if (kind === "downside" && week === 4) outflow += 80_000_000n;
    return {
      weekIndex: String(week),
      label: weekLabel(week),
      inflowMinor: inflow.toString(),
      outflowMinor: outflow.toString(),
    };
  });
}

function openingJournal(): BookJournal {
  return {
    label: "Opening trial balance",
    startDate: "2024-12-01",
    endDate: "2024-12-31",
    lines: [
      line("1000", 42_000_000n, 0n),
      line("1100", 9_500_000n, 0n),
      line("1500", 6_000_000n, 0n),
      line("2000", 0n, 4_000_000n),
      line("2100", 0n, 2_500_000n),
      line("2500", 0n, 18_000_000n),
      line("3000", 0n, 14_000_000n),
      line("3100", 0n, 19_000_000n),
    ],
  };
}

function activityJournal(index: number): BookJournal {
  const services = (82_000n + BigInt(index) * 1_800n) * 100n;
  const devices = (28_000n + BigInt(index) * 600n) * 100n;
  const supplies = ((services + devices) * 22n) / 100n;
  const payroll = 4_600_000n;
  const occupancy = 1_200_000n;
  const software = 350_000n;
  const fees = (2_800n + BigInt(index % 4) * 400n) * 100n;
  const capex = index % 5 === 0 ? 600_000n : 0n;
  const debt = 250_000n;
  const distribution = index % 6 === 5 ? 800_000n : 0n;
  const receivable = (devices * 15n) / 100n;
  const collectedDevices = devices - receivable;
  const { startDate, endDate } = monthRange(index);
  const lines: BookLine[] = [
    line("1000", services, 0n),
    line("4000", 0n, services),
    line("1000", collectedDevices, 0n),
    line("1100", receivable, 0n),
    line("4100", 0n, devices),
    line("5000", supplies, 0n),
    line("1000", 0n, supplies),
    line("6100", payroll, 0n),
    line("1000", 0n, payroll),
    line("6200", occupancy, 0n),
    line("1000", 0n, occupancy),
    line("6300", software, 0n),
    line("1000", 0n, software),
    line("6400", fees, 0n),
    line("1000", 0n, fees),
    line("2500", debt, 0n),
    line("1000", 0n, debt),
  ];
  if (capex > 0n) {
    lines.push(line("1500", capex, 0n), line("1000", 0n, capex));
  }
  if (distribution > 0n) {
    lines.push(line("3200", distribution, 0n), line("1000", 0n, distribution));
  }
  return { label: endDate, startDate, endDate, lines };
}

function line(code: string, debitCents: bigint, creditCents: bigint): BookLine {
  return { code, debitCents, creditCents };
}

function monthRange(index: number): { startDate: string; endDate: string } {
  const monthIndex = index;
  const year = 2025 + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const startDate = `${year}-${pad(month)}-01`;
  const end = new Date(Date.UTC(year, month, 0));
  return { startDate, endDate: end.toISOString().slice(0, 10) };
}

function weekLabel(week: number): string {
  const start = new Date(Date.UTC(2026, 9, 5));
  start.setUTCDate(start.getUTCDate() + (week - 1) * 7);
  return start.toISOString().slice(0, 10);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
