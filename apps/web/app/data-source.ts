import { splitCsv } from "./csv";

export type DataSourceKind = "bank" | "trial_balance" | "financial_statements";

export type StatementCadence = "monthly" | "quarterly" | "yearly";

export type AccountingSystem = "quickbooks" | "xero" | "netsuite" | "sage";

export interface LedgerRow {
  readonly rowNo: number;
  readonly account: string;
  readonly amount: string;
  readonly category: string;
  /** A category the screen proposed. The user can replace it before anything is recorded. */
  readonly suggestedCategory: string | null;
  readonly reviewReason?: string;
  /** Posting date for bank lines the kernel read from a statement. Trial-balance rows have none. */
  readonly date?: string | null;
}

export interface DataSourceState {
  readonly cacheKey?: string | null;
  readonly cacheEpoch?: number;
  readonly kind: DataSourceKind | null;
  readonly cadence: StatementCadence;
  readonly system: AccountingSystem | null;
  readonly fileName: string | null;
  readonly rows: readonly LedgerRow[];
  /** Income statement and balance sheet already stored for this browser session. Cash flow is not a slot. */
  readonly statementPair: StatementPair;
}

export interface StatementSlot {
  readonly fileName: string;
  readonly fileHash: string;
  readonly cadence: StatementCadence;
  readonly sheetName: string;
  readonly firstPeriod: string | null;
  readonly lastPeriod: string | null;
}

export interface StatementPair {
  readonly incomeStatement: StatementSlot | null;
  readonly balanceSheet: StatementSlot | null;
}

const STORAGE_KEY = "nexora.dataSource";

export const EMPTY_STATEMENT_PAIR: StatementPair = { incomeStatement: null, balanceSheet: null };

export const EMPTY_SOURCE: DataSourceState = {
  kind: null,
  cadence: "monthly",
  system: null,
  fileName: null,
  rows: [],
  statementPair: EMPTY_STATEMENT_PAIR,
};

export function smartLedgerApplies(kind: DataSourceKind | null): boolean {
  return kind === "bank" || kind === "trial_balance";
}

type SourceIdentity = { readonly actorId: string; readonly tenantId: string };
let activeKey: string | null = null;
let epoch = 0;
let memory: DataSourceState = EMPTY_SOURCE;

export function dataSourceKey(identity: SourceIdentity): string | null {
  return identity.actorId ? JSON.stringify([identity.actorId, identity.tenantId]) : null;
}

export function clearDataSource(): void {
  activeKey = null;
  epoch += 1;
  memory = EMPTY_SOURCE;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Storage may be disabled. */
  }
  window.dispatchEvent(new Event("nexora:data-source"));
}

export function setDataSourceIdentity(identity: SourceIdentity): void {
  const nextKey = dataSourceKey(identity);
  if (activeKey !== null && activeKey !== nextKey) clearDataSource();
  activeKey = nextKey;
  readDataSource();
}

export function readDataSource(): DataSourceState {
  if (typeof window === "undefined" || activeKey === null) return EMPTY_SOURCE;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isDataSource(parsed) && parsed.cacheKey === activeKey)
        memory = { ...withStatementPair(parsed), cacheEpoch: epoch };
      else {
        window.sessionStorage.removeItem(STORAGE_KEY);
        memory = EMPTY_SOURCE;
      }
    }
  } catch {
    /* The identity-scoped memory remains usable without storage. */
  }
  return memory.cacheKey === activeKey
    ? memory
    : { ...EMPTY_SOURCE, cacheKey: activeKey, cacheEpoch: epoch };
}

export function isCurrentDataSource(state: DataSourceState, identity: SourceIdentity): boolean {
  return (
    activeKey !== null &&
    dataSourceKey(identity) === activeKey &&
    state.cacheKey === activeKey &&
    state.cacheEpoch === epoch
  );
}

export function writeDataSource(state: DataSourceState, identity?: SourceIdentity): void {
  if (
    activeKey === null ||
    (identity && dataSourceKey(identity) !== activeKey) ||
    (state.cacheKey !== undefined && state.cacheKey !== activeKey) ||
    (state.cacheEpoch !== undefined && state.cacheEpoch !== epoch)
  )
    return;
  memory = { ...state, cacheKey: activeKey, cacheEpoch: epoch };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // The in-memory selection still drives the sidebar for this visit.
  }
}

const CATEGORY_HINTS: readonly { readonly pattern: RegExp; readonly category: string }[] = [
  { pattern: /wage pay|adp tax|n[oó]mina|payroll(?! fees)/i, category: "Payroll" },
  { pattern: /cash|bank|checking/i, category: "Cash" },
  { pattern: /revenue|sales|income/i, category: "Revenue" },
  { pattern: /expense|cost|payroll|rent/i, category: "Operating expense" },
  { pattern: /receivable|\bar\b/i, category: "Accounts receivable" },
  { pattern: /payable|\bap\b/i, category: "Accounts payable" },
  { pattern: /inventory/i, category: "Inventory" },
  { pattern: /asset|equipment|ppe/i, category: "Fixed assets" },
  { pattern: /debt|loan|note/i, category: "Debt" },
  { pattern: /equity|capital|retained/i, category: "Equity" },
];

/** A label proposal from the account name or bank description. It is not a posted category. */
export function suggestCategory(account: string): string | null {
  const match = CATEGORY_HINTS.find((hint) => hint.pattern.test(account));
  return match ? match.category : null;
}

export function parseSourceTable(
  text: string,
): readonly { rowNo: number; account: string; amount: string }[] {
  const rows: { rowNo: number; account: string; amount: string }[] = [];
  for (const cells of splitCsv(text)) {
    const account = cells[0]?.trim() ?? "";
    const amount = cells.length > 2 ? cells.slice(1).join(" | ") : (cells[1]?.trim() ?? "");
    if (rows.length === 0 && /^account$/i.test(account) && /^amount$/i.test(amount)) continue;
    rows.push({ rowNo: rows.length + 1, account, amount });
  }
  return rows;
}

function isDataSource(value: unknown): value is DataSourceState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const cadence = record.cadence;
  return (
    (kind === null ||
      kind === "bank" ||
      kind === "trial_balance" ||
      kind === "financial_statements") &&
    (cadence === "monthly" || cadence === "quarterly" || cadence === "yearly") &&
    Array.isArray(record.rows)
  );
}

function withStatementPair(state: DataSourceState): DataSourceState {
  const pair = state.statementPair;
  if (pair && "incomeStatement" in pair && "balanceSheet" in pair) return state;
  return { ...state, statementPair: EMPTY_STATEMENT_PAIR };
}

interface UploadedSheet {
  readonly statementType: string;
  readonly sheetName: string;
  readonly firstPeriod: string | null;
  readonly lastPeriod: string | null;
  readonly valuedLineCount: number;
}

/** Fills the income statement, the balance sheet, or both. A cash flow sheet never fills either slot. */
export function applyStatementUpload(
  pair: StatementPair,
  upload: {
    fileName: string;
    fileHash: string;
    cadence: StatementCadence;
    sheets: readonly UploadedSheet[];
  },
): { pair: StatementPair; cashFlowInFile: boolean } {
  const income = richest(upload.sheets, "income_statement");
  const balance = richest(upload.sheets, "balance_sheet");
  return {
    cashFlowInFile: upload.sheets.some(
      (sheet) => sheet.statementType === "cash_flow" && sheet.valuedLineCount > 0,
    ),
    pair: {
      incomeStatement: income ? toSlot(upload, income) : pair.incomeStatement,
      balanceSheet: balance ? toSlot(upload, balance) : pair.balanceSheet,
    },
  };
}

export function statementPairNote(pair: StatementPair, cashFlowInFile: boolean): string {
  const income = pair.incomeStatement;
  const balance = pair.balanceSheet;
  const sentences: string[] = [];
  if (cashFlowInFile) {
    sentences.push(
      "A cash flow in this file is not used. Cash flow is calculated from the income statement and the balance sheet.",
    );
  }
  if (!income && !balance) {
    sentences.push("The income statement and the balance sheet are both still required.");
  } else if (income && !balance) {
    sentences.push(
      `Income statement is in (${income.fileName}). The balance sheet is still required. Cash flow waits for both.`,
    );
  } else if (!income && balance) {
    sentences.push(
      `Balance sheet is in (${balance.fileName}). The income statement is still required. Cash flow waits for both.`,
    );
  } else if (income && balance && income.cadence !== balance.cadence) {
    sentences.push(
      `The income statement is ${income.cadence} and the balance sheet is ${balance.cadence}. Cash flow waits until both use the same cadence.`,
    );
  } else if (income && balance) {
    sentences.push(
      `Income statement and balance sheet are both stored (${income.cadence}). Cash flow is not taken from the file. The kernel calculates it from classified activity for that cadence.`,
    );
  }
  return sentences.join(" ");
}

function richest(sheets: readonly UploadedSheet[], type: string): UploadedSheet | null {
  return (
    sheets
      .filter((sheet) => sheet.statementType === type && sheet.valuedLineCount > 0)
      .sort((a, b) => b.valuedLineCount - a.valuedLineCount)[0] ?? null
  );
}

function toSlot(
  upload: { fileName: string; fileHash: string; cadence: StatementCadence },
  sheet: UploadedSheet,
): StatementSlot {
  return {
    fileName: upload.fileName,
    fileHash: upload.fileHash,
    cadence: upload.cadence,
    sheetName: sheet.sheetName,
    firstPeriod: sheet.firstPeriod,
    lastPeriod: sheet.lastPeriod,
  };
}
