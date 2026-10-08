export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/** Local development only: send x-actor-id / x-tenant-id / x-region instead of relying on the signed session cookie. */
export const DEV_HEADERS = process.env.NEXT_PUBLIC_NEXORA_DEV_HEADERS === "true";

export const PLATFORM_ADMIN_ACTOR = "platform-admin";

let csrfToken: string | null = null;

/** The API returns this token with the session view; cookie-authenticated writes must echo it. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export interface IdentityOverrides {
  readonly actorId?: string | undefined;
  readonly region?: string | undefined;
  readonly omitTenant?: boolean | undefined;
}

/** The API derives actor, tenant, and region from the session cookie. Headers carry identity only in dev-header mode. */
export function csrfHeaders(): Record<string, string> {
  return csrfToken ? { "x-csrf-token": csrfToken } : {};
}

export function identityHeaders(
  session: Session,
  overrides: IdentityOverrides = {},
): Record<string, string> {
  const headers = csrfHeaders();
  if (DEV_HEADERS) {
    headers["x-actor-id"] = overrides.actorId ?? session.actorId;
    headers["x-region"] = overrides.region ?? session.region;
    if (!overrides.omitTenant && session.tenantId.length > 0) {
      headers["x-tenant-id"] = session.tenantId;
    }
  }
  return headers;
}

export interface Session {
  readonly actorId: string;
  readonly tenantId: string;
  readonly region: string;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: ApiError };

export const REPORTS = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type Report = (typeof REPORTS)[number];

export const CASH_FLOWS = ["cash", "cfo", "cfi", "cff", "non_cash", "distribution"] as const;
export type CashFlow = (typeof CASH_FLOWS)[number];

export interface Tenant {
  readonly tenantId: string;
  readonly homeRegion: string;
  readonly name: string;
}

export interface Entity {
  readonly entityId: string;
  readonly legalName: string;
  readonly functionalCurrency: string;
  readonly retainedEarningsAccountId: string | null;
}

export interface ConsolidationGroup {
  readonly consolidationGroupId: string;
  readonly name: string;
  readonly reportingCurrency: string;
}

export interface Account {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly report: string;
  readonly cashFlow: string;
  readonly currency: string;
  readonly active: boolean;
  readonly retainedEarnings: boolean;
}

export interface Period {
  readonly periodId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

export interface JournalLine {
  readonly accountId: string;
  readonly lineNo: number;
  readonly debitMinor: string;
  readonly creditMinor: string;
}

export interface Journal {
  readonly journalId: string;
  readonly periodId: string;
  readonly currency: string;
  readonly version: number;
  readonly payloadHash: string;
  readonly reversesJournalId: string | null;
  readonly totalDebitMinor: string;
  readonly totalDebit: string;
  readonly postedAt: string | null;
  readonly replayed: boolean | null;
  readonly lines: readonly JournalLine[];
}

export interface Amount {
  readonly minor: string;
  readonly amount: string;
  readonly currency: string;
}

export interface Statements {
  readonly engineVersion: string;
  readonly inputHash: string;
  readonly currency: string;
  readonly incomeStatement: {
    readonly revenue: Amount;
    readonly expenses: Amount;
    readonly netIncome: Amount;
  };
  readonly balanceSheet: {
    readonly assets: Amount;
    readonly liabilities: Amount;
    readonly equity: Amount;
  };
  readonly cashFlow: {
    readonly beginningCash: Amount;
    readonly cfo: Amount;
    readonly cfi: Amount;
    readonly cff: Amount;
    readonly endingCash: Amount;
  };
  readonly retainedEarnings: {
    readonly opening: Amount;
    readonly netIncome: Amount;
    readonly distributions: Amount;
    readonly ending: Amount;
    readonly close: string;
  };
}

export interface ClosedPeriod {
  readonly periodId: string;
  readonly status: string;
}

export interface JournalLineInput {
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
}

export type Decoder<T> = (value: unknown) => T | null;

interface RequestOptions<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly decode: Decoder<T>;
  readonly body?: unknown;
  readonly actorId?: string;
  readonly region?: string;
  readonly omitTenant?: boolean;
  readonly idempotencyKey?: string;
}

async function request<T>(session: Session, options: RequestOptions<T>): Promise<ApiResult<T>> {
  const headers = identityHeaders(session, options);
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return apiRequest({
    method: options.method,
    path: options.path,
    decode: options.decode,
    body: options.body,
    headers,
  });
}

/** One fetch to the kernel API with the session cookie attached. Every error comes back as a typed result. */
export async function apiRequest<T>(options: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly decode: Decoder<T>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${options.path}`, {
      method: options.method,
      headers,
      cache: "no-store",
      credentials: "include",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        code: "NETWORK_UNREACHABLE",
        message: `Could not reach the kernel API at ${API_URL}`,
      },
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: decodeError(payload, response.status) };
  }
  const data = options.decode(payload);
  if (data === null) {
    return {
      ok: false,
      status: response.status,
      error: {
        code: "UNEXPECTED_RESPONSE",
        message: "The kernel API returned a response this screen does not recognise",
      },
    };
  }
  return { ok: true, status: response.status, data };
}

/** Opens a company. A signed user becomes the owner. Dev headers still send the platform-admin actor. */
export function provisionTenant(
  session: Session,
  input: { name: string; homeRegion: string; ownerActorId?: string },
): Promise<ApiResult<Tenant>> {
  return request(session, {
    method: "POST",
    path: "/v1/tenants",
    actorId: PLATFORM_ADMIN_ACTOR,
    region: input.homeRegion,
    omitTenant: true,
    body: {
      name: input.name,
      homeRegion: input.homeRegion,
      ownerActorId: input.ownerActorId ?? session.actorId,
    },
    decode: decodeTenant,
  });
}

export function listConsolidationGroups(
  session: Session,
): Promise<ApiResult<readonly ConsolidationGroup[]>> {
  return request(session, {
    method: "GET",
    path: "/v1/consolidation-groups",
    decode: listOf("groups", decodeConsolidationGroup),
  });
}

export function listEntities(session: Session): Promise<ApiResult<readonly Entity[]>> {
  return request(session, {
    method: "GET",
    path: "/v1/entities",
    decode: listOf("entities", decodeEntity),
  });
}

export function createEntity(
  session: Session,
  input: { legalName: string; functionalCurrency: string },
): Promise<ApiResult<unknown>> {
  return request(session, { method: "POST", path: "/v1/entities", body: input, decode: acceptAny });
}

export function listAccounts(
  session: Session,
  entityId: string,
): Promise<ApiResult<readonly Account[]>> {
  return request(session, {
    method: "GET",
    path: `/v1/entities/${encodeURIComponent(entityId)}/accounts`,
    decode: listOf("accounts", decodeAccount),
  });
}

export function createAccount(
  session: Session,
  input: {
    entityId: string;
    code: string;
    name: string;
    report: Report;
    cashFlow: CashFlow;
    retainedEarnings: boolean;
  },
): Promise<ApiResult<unknown>> {
  return request(session, { method: "POST", path: "/v1/accounts", body: input, decode: acceptAny });
}

export function listPeriods(
  session: Session,
  entityId: string,
): Promise<ApiResult<readonly Period[]>> {
  return request(session, {
    method: "GET",
    path: `/v1/entities/${encodeURIComponent(entityId)}/periods`,
    decode: listOf("periods", decodePeriod),
  });
}

export function createPeriod(
  session: Session,
  input: { entityId: string; startDate: string; endDate: string },
): Promise<ApiResult<unknown>> {
  return request(session, { method: "POST", path: "/v1/periods", body: input, decode: acceptAny });
}

export function closePeriod(session: Session, periodId: string): Promise<ApiResult<ClosedPeriod>> {
  return request(session, {
    method: "POST",
    path: `/v1/periods/${encodeURIComponent(periodId)}/close`,
    decode: decodeClosedPeriod,
  });
}

export function listJournals(
  session: Session,
  entityId: string,
  periodId: string,
): Promise<ApiResult<readonly Journal[]>> {
  return request(session, {
    method: "GET",
    path: `/v1/entities/${encodeURIComponent(entityId)}/journals?periodId=${encodeURIComponent(periodId)}`,
    decode: listOf("journals", decodeJournal),
  });
}

export function postJournal(
  session: Session,
  input: {
    entityId: string;
    periodId: string;
    currency: string;
    lines: readonly JournalLineInput[];
  },
  idempotencyKey: string,
): Promise<ApiResult<Journal>> {
  return request(session, {
    method: "POST",
    path: "/v1/journals",
    body: input,
    idempotencyKey,
    decode: decodeJournal,
  });
}

export function getStatements(
  session: Session,
  entityId: string,
  periodId: string,
): Promise<ApiResult<Statements>> {
  return request(session, {
    method: "GET",
    path: `/v1/entities/${encodeURIComponent(entityId)}/periods/${encodeURIComponent(periodId)}/statements`,
    decode: decodeStatements,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function decodeError(payload: unknown, status: number): ApiError {
  if (isRecord(payload) && isRecord(payload.error)) {
    const code = str(payload.error, "code");
    const message = str(payload.error, "message");
    if (code !== null && message !== null) {
      return { code, message };
    }
  }
  return {
    code: `HTTP_${status}`,
    message: "The kernel API rejected the request without an error body",
  };
}

export function acceptAny(value: unknown): unknown {
  return value ?? {};
}

function listOf<T>(key: string, decodeItem: Decoder<T>): Decoder<readonly T[]> {
  return (value) => {
    if (!isRecord(value)) return null;
    const items = value[key];
    if (!Array.isArray(items)) return null;
    const decoded: T[] = [];
    for (const item of items) {
      const next = decodeItem(item);
      if (next === null) return null;
      decoded.push(next);
    }
    return decoded;
  };
}

function decodeTenant(value: unknown): Tenant | null {
  if (!isRecord(value)) return null;
  const tenantId = str(value, "tenantId");
  const homeRegion = str(value, "homeRegion");
  const name = str(value, "name");
  if (tenantId === null || homeRegion === null || name === null) return null;
  return { tenantId, homeRegion, name };
}

function decodeConsolidationGroup(value: unknown): ConsolidationGroup | null {
  if (!isRecord(value)) return null;
  const consolidationGroupId = str(value, "consolidationGroupId");
  const name = str(value, "name");
  const reportingCurrency = str(value, "reportingCurrency");
  if (consolidationGroupId === null || name === null || reportingCurrency === null) return null;
  return { consolidationGroupId, name, reportingCurrency };
}

function decodeEntity(value: unknown): Entity | null {
  if (!isRecord(value)) return null;
  const entityId = str(value, "entityId");
  const legalName = str(value, "legalName");
  const functionalCurrency = str(value, "functionalCurrency");
  if (entityId === null || legalName === null || functionalCurrency === null) return null;
  return {
    entityId,
    legalName,
    functionalCurrency,
    retainedEarningsAccountId: str(value, "retainedEarningsAccountId"),
  };
}

function decodeAccount(value: unknown): Account | null {
  if (!isRecord(value)) return null;
  const accountId = str(value, "accountId");
  const code = str(value, "code");
  const name = str(value, "name");
  const report = str(value, "report");
  const cashFlow = str(value, "cashFlow");
  const currency = str(value, "currency");
  if (
    accountId === null ||
    code === null ||
    name === null ||
    report === null ||
    cashFlow === null ||
    currency === null ||
    typeof value.active !== "boolean" ||
    typeof value.retainedEarnings !== "boolean"
  ) {
    return null;
  }
  return {
    accountId,
    code,
    name,
    report,
    cashFlow,
    currency,
    active: value.active,
    retainedEarnings: value.retainedEarnings,
  };
}

function decodePeriod(value: unknown): Period | null {
  if (!isRecord(value)) return null;
  const periodId = str(value, "periodId");
  const startDate = str(value, "startDate");
  const endDate = str(value, "endDate");
  const status = str(value, "status");
  if (periodId === null || startDate === null || endDate === null || status === null) return null;
  return { periodId, startDate, endDate, status };
}

function decodeClosedPeriod(value: unknown): ClosedPeriod | null {
  if (!isRecord(value)) return null;
  const periodId = str(value, "periodId");
  const status = str(value, "status");
  if (periodId === null || status === null) return null;
  return { periodId, status };
}

function decodeJournalLine(value: unknown): JournalLine | null {
  if (!isRecord(value)) return null;
  const accountId = str(value, "accountId");
  const debitMinor = str(value, "debitMinor");
  const creditMinor = str(value, "creditMinor");
  if (
    accountId === null ||
    debitMinor === null ||
    creditMinor === null ||
    typeof value.lineNo !== "number"
  ) {
    return null;
  }
  return { accountId, lineNo: value.lineNo, debitMinor, creditMinor };
}

function decodeJournal(value: unknown): Journal | null {
  if (!isRecord(value)) return null;
  const journalId = str(value, "journalId");
  const periodId = str(value, "periodId");
  const currency = str(value, "currency");
  const payloadHash = str(value, "payloadHash");
  const totalDebitMinor = str(value, "totalDebitMinor");
  const totalDebit = str(value, "totalDebit");
  if (
    journalId === null ||
    periodId === null ||
    currency === null ||
    payloadHash === null ||
    totalDebitMinor === null ||
    totalDebit === null ||
    typeof value.version !== "number" ||
    !Array.isArray(value.lines)
  ) {
    return null;
  }
  const lines: JournalLine[] = [];
  for (const raw of value.lines) {
    const line = decodeJournalLine(raw);
    if (line === null) return null;
    lines.push(line);
  }
  return {
    journalId,
    periodId,
    currency,
    version: value.version,
    payloadHash,
    reversesJournalId: str(value, "reversesJournalId"),
    totalDebitMinor,
    totalDebit,
    postedAt: str(value, "postedAt"),
    replayed: typeof value.replayed === "boolean" ? value.replayed : null,
    lines,
  };
}

function decodeAmount(value: unknown): Amount | null {
  if (!isRecord(value)) return null;
  const minor = str(value, "minor");
  const amount = str(value, "amount");
  const currency = str(value, "currency");
  if (minor === null || amount === null || currency === null) return null;
  return { minor, amount, currency };
}

function decodeAmounts<K extends string>(
  value: unknown,
  keys: readonly K[],
): Record<K, Amount> | null {
  if (!isRecord(value)) return null;
  const out: Partial<Record<K, Amount>> = {};
  for (const key of keys) {
    const amount = decodeAmount(value[key]);
    if (amount === null) return null;
    out[key] = amount;
  }
  return out as Record<K, Amount>;
}

function decodeStatements(value: unknown): Statements | null {
  if (!isRecord(value)) return null;
  const engineVersion = str(value, "engineVersion");
  const inputHash = str(value, "inputHash");
  const currency = str(value, "currency");
  if (engineVersion === null || inputHash === null || currency === null) return null;
  const incomeStatement = decodeAmounts(value.incomeStatement, [
    "revenue",
    "expenses",
    "netIncome",
  ] as const);
  const balanceSheet = decodeAmounts(value.balanceSheet, [
    "assets",
    "liabilities",
    "equity",
  ] as const);
  const cashFlow = decodeAmounts(value.cashFlow, [
    "beginningCash",
    "cfo",
    "cfi",
    "cff",
    "endingCash",
  ] as const);
  const retained = decodeAmounts(value.retainedEarnings, [
    "opening",
    "netIncome",
    "distributions",
    "ending",
  ] as const);
  const close = isRecord(value.retainedEarnings) ? str(value.retainedEarnings, "close") : null;
  if (
    incomeStatement === null ||
    balanceSheet === null ||
    cashFlow === null ||
    retained === null ||
    close === null
  ) {
    return null;
  }
  return {
    engineVersion,
    inputHash,
    currency,
    incomeStatement,
    balanceSheet,
    cashFlow,
    retainedEarnings: { ...retained, close },
  };
}
