import { apiRequest, identityHeaders, isRecord, type ApiResult, type Session } from "../books/api";

/** `actorId` only takes effect in dev-header mode; with a signed session the kernel acts as the signed-in actor. */
export async function kernelCall(
  session: Session,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options?: { readonly actorId?: string | undefined; readonly idempotencyKey?: string | undefined },
): Promise<ApiResult<Record<string, unknown>>> {
  const headers = identityHeaders(session, { actorId: options?.actorId });
  if (options?.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return apiRequest({
    method,
    path,
    body,
    headers,
    decode: (value) => (isRecord(value) ? value : null),
  });
}

export type KernelRecord = Record<string, unknown>;

export function field(record: KernelRecord | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

export interface StateVersion {
  readonly financialStateId: string;
  readonly status: string;
  readonly stateHash: string;
  readonly engineVersion: string | null;
  readonly supersedesId: string | null;
}

/** Transition responses omit the engine version, so the drafted version's value is carried forward. */
export function decodeStateVersion(
  data: KernelRecord,
  previous: StateVersion | null,
): StateVersion | null {
  const financialStateId = field(data, "financialStateId");
  const status = field(data, "status");
  const stateHash = field(data, "stateHash");
  if (financialStateId === null || status === null || stateHash === null) return null;
  return {
    financialStateId,
    status,
    stateHash,
    engineVersion: field(data, "engineVersion") ?? previous?.engineVersion ?? null,
    supersedesId: field(data, "supersedesId"),
  };
}

export interface ValuationRun {
  readonly valuationId: string;
  readonly calculationStatus: string;
  readonly calculationRunId: string | null;
  readonly inputHash: string | null;
  readonly engineVersion: string | null;
  readonly currency: string | null;
  readonly convention: string | null;
  readonly enterpriseValue: string | null;
  readonly equityValue: string | null;
  readonly terminalValue: string | null;
  readonly presentValueOfTerminalValue: string | null;
  readonly presentValues: readonly string[];
  readonly code: string | null;
  readonly message: string | null;
}

export function decodeValuationRun(data: KernelRecord): ValuationRun | null {
  const valuationId = field(data, "valuationId");
  const calculationStatus = field(data, "calculationStatus");
  if (valuationId === null || calculationStatus === null) return null;
  const presentValues = Array.isArray(data.presentValues)
    ? data.presentValues.filter((value): value is string => typeof value === "string")
    : [];
  return {
    valuationId,
    calculationStatus,
    calculationRunId: field(data, "calculationRunId"),
    inputHash: field(data, "inputHash"),
    engineVersion: field(data, "engineVersion"),
    currency: field(data, "currency"),
    convention: field(data, "convention"),
    enterpriseValue: field(data, "enterpriseValue"),
    equityValue: field(data, "equityValue"),
    terminalValue: field(data, "terminalValue"),
    presentValueOfTerminalValue: field(data, "presentValueOfTerminalValue"),
    presentValues,
    code: field(data, "code"),
    message: field(data, "message"),
  };
}

export interface VersionRef {
  readonly id: string;
  readonly status: string;
  readonly supersedesId: string | null;
}

export function decodeValuationVersion(data: KernelRecord): VersionRef | null {
  const id = field(data, "valuationId");
  const status = field(data, "status");
  if (id === null || status === null) return null;
  return { id, status, supersedesId: field(data, "supersedesId") };
}

export interface SensitivityResult {
  readonly calculationRunId: string | null;
  readonly inputHash: string | null;
  readonly engineVersion: string | null;
  readonly runs: readonly {
    readonly id: string;
    readonly enterpriseValue: string;
    readonly equityValue: string;
  }[];
}

export function decodeSensitivity(data: KernelRecord): SensitivityResult | null {
  if (!Array.isArray(data.runs)) return null;
  const runs: { id: string; enterpriseValue: string; equityValue: string }[] = [];
  for (const raw of data.runs) {
    if (!isRecord(raw)) return null;
    const id = field(raw, "id");
    const enterpriseValue = field(raw, "enterpriseValue");
    const equityValue = field(raw, "equityValue");
    if (id === null || enterpriseValue === null || equityValue === null) return null;
    runs.push({ id, enterpriseValue, equityValue });
  }
  return {
    calculationRunId: field(data, "calculationRunId"),
    inputHash: field(data, "inputHash"),
    engineVersion: field(data, "engineVersion"),
    runs,
  };
}

export interface ReportPack {
  readonly reportPackId: string;
  readonly status: string;
  readonly stateHash: string;
  readonly engineVersion: string | null;
}

export function decodeReportPack(data: KernelRecord): ReportPack | null {
  const reportPackId = field(data, "reportPackId");
  const status = field(data, "status");
  const stateHash = field(data, "stateHash");
  if (reportPackId === null || status === null || stateHash === null) return null;
  return { reportPackId, status, stateHash, engineVersion: field(data, "engineVersion") };
}

export interface LineageEdge {
  readonly fromType: string;
  readonly fromId: string;
  readonly toType: string;
  readonly toId: string;
  readonly relation: string;
}

export function decodeLineage(data: KernelRecord): readonly LineageEdge[] | null {
  if (!Array.isArray(data.edges)) return null;
  const edges: LineageEdge[] = [];
  for (const raw of data.edges) {
    if (!isRecord(raw)) return null;
    const fromType = field(raw, "fromType");
    const fromId = field(raw, "fromId");
    const toType = field(raw, "toType");
    const toId = field(raw, "toId");
    const relation = field(raw, "relation");
    if (
      fromType === null ||
      fromId === null ||
      toType === null ||
      toId === null ||
      relation === null
    )
      return null;
    edges.push({ fromType, fromId, toType, toId, relation });
  }
  return edges;
}
