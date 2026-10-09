import type { LedgerStore } from "@nexora/db";
import {
  AnalyticalDecimal,
  KernelError,
  acceptCitedClaims,
  applyDealScenario,
  assertCanPublish,
  assertMakerChecker,
  assertSameRegion,
  assertSourcesEqualUses,
  assertTenantActive,
  assertTransition,
  attributeNonControllingInterest,
  authorize,
  buildQoeBridge,
  eliminateIntercompany,
  ENGINE_VERSION,
  evaluateGraph,
  hashMaterial,
  lboReturns,
  mapReportingBasis,
  money,
  projectScenario,
  reconcileCapTable,
  resolveOwnership,
  rollDebt,
  stateHash,
  translateTrialBalance,
  validateJournal,
  type TrialBalanceLine,
  valueDcf,
  valueDcfSensitivity,
  type Action,
  type CalcNode,
  type DcfInput,
  type FxRate,
  type PublicationStatus,
} from "@nexora/kernel";

import {
  CONSOLIDATION_RATE_POLICY,
  consolidateTranslations,
  trialBalanceFromClassifiedLines,
} from "./consolidation-ledger.js";
import { ApiError, type ActorContext } from "./http.js";
import { computeStatementsForPeriod, loadClassifiedActivity } from "./service.js";

const STATUSES = ["draft", "validated", "review", "approved", "published", "rejected"] as const;
const STATE_ALLOW = [
  "entityId",
  "periodId",
  "basis",
  "currency",
  "netIncomeMinor",
  "inputHash",
  "outputHash",
  "engineVersion",
] as const;

export function createProgramService(store: LedgerStore) {
  return {
    createFinancialState: (actor: ActorContext, input: StateInput) =>
      createFinancialState(store, actor, input),
    transitionFinancialState: (actor: ActorContext, id: string, to: string) =>
      transitionFinancialState(store, actor, id, to),
    readFinancialStateVersion: (actor: ActorContext, id: string) =>
      readFinancialStateVersion(store, actor, id),
    readValuationVersion: (actor: ActorContext, id: string) =>
      readValuationVersion(store, actor, id),
    lineage: (actor: ActorContext, type: string, id: string) => lineage(store, actor, type, id),
    createFxRateSet: (actor: ActorContext, input: FxInput) => createFxRateSet(store, actor, input),
    translateGroup: (actor: ActorContext, groupId: string, input: TranslateInput) =>
      translateGroup(store, actor, groupId, input),
    eliminateGroup: (actor: ActorContext, groupId: string, input: EliminateInput) =>
      eliminateGroup(store, actor, groupId, input),
    createGroup: (actor: ActorContext, input: { name: string; reportingCurrency: string }) =>
      createGroup(store, actor, input),
    createModel: (actor: ActorContext, input: { name: string }) => createModel(store, actor, input),
    saveModelVersion: (actor: ActorContext, modelId: string, nodes: readonly CalcNode[]) =>
      saveModelVersion(store, actor, modelId, nodes),
    calculateModel: (actor: ActorContext, modelId: string, nodes: readonly CalcNode[]) =>
      calculateModel(store, actor, modelId, nodes),
    createScenario: (
      actor: ActorContext,
      input: {
        baseVersionId: string;
        name: string;
        base: Record<string, string>;
        overrides: Record<string, string>;
      },
    ) => createScenario(store, actor, input),
    createValuation: (actor: ActorContext, input: DcfInput) => createValuation(store, actor, input),
    getValuation: (actor: ActorContext, id: string) => readValuation(store, actor, id),
    transitionValuation: (actor: ActorContext, id: string, to: string) =>
      transitionValuation(store, actor, id, to),
    sensitivity: (
      actor: ActorContext,
      input: {
        base: DcfInput;
        shocks: readonly {
          id: string;
          wacc?: string | undefined;
          terminalGrowth?: string | undefined;
        }[];
      },
    ) => sensitivity(store, actor, input),
    createReportPack: (
      actor: ActorContext,
      input: { statementStateId: string; valuationId: string },
    ) => createReportPack(store, actor, input),
    getReportPack: (actor: ActorContext, id: string) => getReportPack(store, actor, id),
    rollDebt: (actor: ActorContext, input: DebtInput) => saveDebt(store, actor, input),
    capTable: (actor: ActorContext, input: CapInput) => saveCapTable(store, actor, input),
    sourcesUses: (
      actor: ActorContext,
      input: {
        sources: readonly { label: string; amountMinor: string }[];
        uses: readonly { label: string; amountMinor: string }[];
      },
    ) => saveSourcesUses(store, actor, input),
    lbo: (
      actor: ActorContext,
      input: { entryEquity: string; exitEquity: string; holdYears: string },
    ) => saveLbo(store, actor, input),
    importBatch: (
      actor: ActorContext,
      input: { rows: readonly { rowNo: number; account: string; amount: string }[] },
    ) => importBatch(store, actor, input),
    qoe: (
      actor: ActorContext,
      input: {
        reported: string;
        adjustments: readonly { adjustmentId: string; sourceRowId: string; amount: string }[];
      },
    ) => qoe(store, actor, input),
    propose: (
      actor: ActorContext,
      input: { claims: readonly { text: string; citationId: string | null }[] },
    ) => propose(store, actor, input),
    acceptProposal: (
      actor: ActorContext,
      input: {
        entityId: string;
        periodId: string;
        currency: string;
        lines: readonly { accountId: string; debitMinor: string; creditMinor: string }[];
      },
    ) => acceptProposal(store, actor, input),
    createDeal: (
      actor: ActorContext,
      input: {
        publishedStateHash: string;
        base: Record<string, string>;
        overrides: Record<string, string>;
      },
    ) => createDeal(store, actor, input),
    mapBasis: (
      actor: ActorContext,
      input: {
        basisVersion: string;
        localBalances: readonly { accountId: string; debitPositiveMinor: string }[];
        mappings: readonly { localAccountId: string; groupAccountId: string }[];
      },
    ) => mapBasis(store, actor, input),
    recordOwnership: (
      actor: ActorContext,
      input: {
        asOf: string;
        parentEntityId: string;
        childEntityId: string;
        effectiveFrom: string;
        effectiveTo: string | null;
        percent: string;
        subsidiaryEquityMinor: string;
      },
    ) => recordOwnership(store, actor, input),
  };
}

interface StateInput {
  readonly entityId: string;
  readonly periodId: string;
  readonly basis: string;
  readonly currency?: string | undefined;
  readonly netIncomeMinor?: string | undefined;
  readonly label?: string | undefined;
}

async function createFinancialState(store: LedgerStore, actor: ActorContext, input: StateInput) {
  const tenant = await scope(store, actor, "state.write");
  const { statement, inputs } = await computeStatementsForPeriod(
    store,
    tenant.tenantId,
    input.entityId,
    input.periodId,
  );
  const netIncomeMinor = statement.incomeStatement.netIncomeMinor;
  if (
    input.netIncomeMinor !== undefined &&
    BigInt(input.netIncomeMinor) !== BigInt(netIncomeMinor)
  ) {
    throw new ApiError(
      422,
      "FIN_CLIENT_TOTAL_MISMATCH",
      "Client net income does not match the kernel statement",
    );
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const calculationRunId = crypto.randomUUID();
  const source = {
    entityId: input.entityId,
    periodId: input.periodId,
    basis: input.basis,
    currency: statement.currency,
    netIncomeMinor,
    inputHash: statement.inputHash,
    outputHash: hashMaterial(statement),
    engineVersion: statement.engineVersion,
  };
  const hash = stateHash(source, STATE_ALLOW);
  const run = await store.insertCalculationRun({
    run: runRecord(
      tenant.tenantId,
      actor,
      calculationRunId,
      "statements",
      "succeeded",
      statement.engineVersion,
      statement.inputHash,
      inputs,
      statement,
      now,
    ),
    audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
      inputHash: statement.inputHash,
      outputHash: source.outputHash,
    }),
  });
  await store.insertFinancialState({
    tenantId: tenant.tenantId,
    id,
    entityId: input.entityId,
    periodId: input.periodId,
    basis: input.basis,
    currency: statement.currency,
    stateHash: hash,
    status: "draft",
    engineVersion: statement.engineVersion,
    calculationStatus: run.status,
    calculationRunId: run.calculationRunId,
    supersedesId: null,
    makerActorId: actor.actorId,
    payload: { ...source, label: input.label, stateHash: hash, makerActorId: actor.actorId },
    createdAt: now,
    audit: audit(actor, "FinancialStateDrafted", "financial_state", id, now, { stateHash: hash }),
  });
  return {
    financialStateId: id,
    status: "draft",
    stateHash: hash,
    engineVersion: statement.engineVersion,
    netIncomeMinor,
    currency: statement.currency,
    calculationRunId: run.calculationRunId,
  };
}

/** Read-only view of one stored version, so a checker in a separate session reviews what the kernel recorded. */
async function readFinancialStateVersion(store: LedgerStore, actor: ActorContext, id: string) {
  const tenant = await scope(store, actor, "lineage.read");
  const current = await store.getFinancialState(tenant.tenantId, id);
  if (!current) {
    throw new KernelError("FIN_NOT_FOUND", "Financial state not found");
  }
  return {
    financialStateId: current.id,
    netIncomeMinor: stringField(isRecord(current.payload) ? current.payload : {}, "netIncomeMinor"),
    currency: stringField(isRecord(current.payload) ? current.payload : {}, "currency"),
    calculationStatus: current.calculationStatus,
    calculationRunId: current.calculationRunId,
    status: current.status,
    stateHash: current.stateHash,
    engineVersion: current.engineVersion,
    supersedesId: current.supersedesId,
    makerActorId: current.makerActorId,
  };
}

async function readValuationVersion(store: LedgerStore, actor: ActorContext, id: string) {
  const tenant = await scope(store, actor, "lineage.read");
  const current = await store.getValuation(tenant.tenantId, id);
  if (!current) {
    throw new KernelError("FIN_NOT_FOUND", "Valuation not found");
  }
  const stored = isRecord(current.payload) ? current.payload : {};
  const result = Object.fromEntries(
    Object.entries(stored).filter(
      ([key]) => key !== "assumption" && key !== "makerActorId" && key !== "calculationStatus",
    ),
  );
  return {
    ...result,
    valuationId: current.id,
    status: current.status,
    calculationStatus: readCalculationStatus(current.payload),
    engineVersion: current.engineVersion,
    makerActorId: current.makerActorId,
  };
}

function isOutdatedFinancialEngine(version: string | null | undefined): boolean {
  const match = version?.match(/^fe-kernel-(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return true;
  const minimum = [0n, 2n, 1n];
  for (let index = 0; index < minimum.length; index++) {
    const component = BigInt(match[index + 1]!);
    if (component !== minimum[index]!) return component < minimum[index]!;
  }
  return false;
}

async function transitionFinancialState(
  store: LedgerStore,
  actor: ActorContext,
  id: string,
  to: string,
) {
  const tenant = await scope(store, actor, to === "published" ? "state.publish" : "state.write");
  const current = await store.getFinancialState(tenant.tenantId, id);
  if (!current) {
    throw new KernelError("FIN_NOT_FOUND", "Financial state not found");
  }
  const from = asStatus(current.status);
  const target = asStatus(to);
  if (target === "published") {
    assertCanPublish({ calculationStatus: current.calculationStatus, from });
    if (!current.calculationRunId) {
      throw new KernelError("PUBLISH_BLOCKED", "Financial state has no kernel calculation run");
    }
    if (isOutdatedFinancialEngine(current.engineVersion)) {
      throw new KernelError(
        "PUBLISH_BLOCKED",
        "Financial state was calculated by an outdated engine version",
      );
    }
    const maker = readMaker(current.payload);
    assertMakerChecker(maker, actor.actorId);
  } else {
    assertTransition(from, target);
  }
  const now = new Date().toISOString();
  const nextId = crypto.randomUUID();
  const payload = isRecord(current.payload) ? current.payload : {};
  await store.transitionFinancialStateAtomic({
    successor: {
      tenantId: tenant.tenantId,
      id: nextId,
      entityId: stringField(payload, "entityId"),
      periodId: stringField(payload, "periodId"),
      basis: stringField(payload, "basis"),
      currency: stringField(payload, "currency"),
      stateHash: current.stateHash,
      status: target,
      engineVersion: current.engineVersion,
      calculationStatus: current.calculationStatus,
      calculationRunId: current.calculationRunId,
      supersedesId: current.id,
      makerActorId: readMaker(current.payload),
      payload: { ...payload, status: target },
      createdAt: now,
      audit: audit(actor, "FinancialStateTransitioned", "financial_state", nextId, now, {
        from,
        to: target,
        stateHash: current.stateHash,
      }),
    },
    approval: {
      tenantId: tenant.tenantId,
      approvalId: crypto.randomUUID(),
      objectType: "financial_state",
      objectId: nextId,
      actorId: actor.actorId,
      decision: target,
      policyVersion: "publication-1",
      createdAt: now,
      audit: audit(actor, "ApprovalRecorded", "approval", nextId, now, { decision: target }),
    },
    lineage: {
      tenantId: tenant.tenantId,
      lineageEdgeId: crypto.randomUUID(),
      fromType: "financial_state",
      fromId: current.id,
      toType: "financial_state",
      toId: nextId,
      relation: "supersedes",
      createdAt: now,
      audit: audit(actor, "LineageRecorded", "financial_state", nextId, now, {
        fromId: current.id,
        toId: nextId,
        relation: "supersedes",
      }),
    },
  });
  return {
    financialStateId: nextId,
    status: target,
    stateHash: current.stateHash,
    supersedesId: current.id,
    engineVersion: current.engineVersion,
    netIncomeMinor: stringField(payload, "netIncomeMinor"),
    currency: stringField(payload, "currency"),
  };
}

async function lineage(store: LedgerStore, actor: ActorContext, type: string, id: string) {
  const tenant = await scope(store, actor, "lineage.read");
  const edges = await store.listLineage(tenant.tenantId, type, id);
  return {
    edges: edges.map((edge) => ({
      fromType: edge.fromType,
      fromId: edge.fromId,
      toType: edge.toType,
      toId: edge.toId,
      relation: edge.relation,
    })),
  };
}

interface FxInput {
  readonly label: string;
  readonly rates: readonly {
    readonly base: string;
    readonly quote: string;
    readonly rateType: "closing" | "historical" | "average";
    readonly rate: string;
  }[];
}

async function createFxRateSet(store: LedgerStore, actor: ActorContext, input: FxInput) {
  const tenant = await scope(store, actor, "fx.write");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertFxRateSet({
    tenantId: tenant.tenantId,
    fxRateSetId: id,
    label: input.label,
    rates: input.rates.map((rate) => ({ ...rate, id: crypto.randomUUID() })),
    createdAt: now,
    audit: audit(actor, "FxRateSetCreated", "fx_rate_set", id, now, { label: input.label }),
  });
  return { fxRateSetId: id };
}

interface EntityPeriodScope {
  readonly entityId: string;
  readonly periodId: string;
}

interface RateTriple {
  readonly sourceCurrency: string;
  readonly closing: FxRate;
  readonly historical: FxRate;
  readonly average: FxRate;
}

interface TranslateInput {
  readonly ctaAccountId: string;
  readonly entities: readonly EntityPeriodScope[];
  readonly rates: readonly RateTriple[];
}

interface EliminateInput {
  readonly evidenceId: string;
  readonly ctaAccountId: string;
  readonly entities: readonly EntityPeriodScope[];
  readonly rates: readonly RateTriple[];
  readonly eliminations: readonly {
    readonly accountId: string;
    readonly debitMinor: string;
    readonly creditMinor: string;
    readonly evidenceId: string;
  }[];
}

async function translateGroup(
  store: LedgerStore,
  actor: ActorContext,
  groupId: string,
  input: TranslateInput,
) {
  const tenant = await scope(store, actor, "consolidation.run");
  const reportingCurrency = await requireGroupCurrency(store, tenant.tenantId, groupId);
  const derived = await deriveTranslatedGroup(
    store,
    tenant.tenantId,
    reportingCurrency,
    input.ctaAccountId,
    input.entities,
    input.rates,
  );
  const now = new Date().toISOString();
  const calculationRunId = crypto.randomUUID();
  const engineVersion = derived.entities[0]?.translated.engineVersion ?? ENGINE_VERSION;
  await store.insertCalculationRun({
    run: {
      calculationRunId,
      tenantId: tenant.tenantId,
      kind: "fx-translation",
      status: "succeeded",
      engineVersion,
      inputHash: derived.inputHash,
      inputs: {
        groupId,
        formulaVersion: CONSOLIDATION_RATE_POLICY,
        reportingCurrency,
        ctaAccountId: input.ctaAccountId,
        rates: input.rates,
        entities: derived.entities.map(entitySnapshot),
      },
      outputs: {
        ctaMinor: derived.consolidated.ctaMinor,
        lines: derived.consolidated.lines,
        outputHash: derived.outputHash,
        entities: derived.entities.map((entity) => ({
          entityId: entity.entityId,
          periodId: entity.periodId,
          rateSetId: entity.translated.rateSetId,
          ctaMinor: entity.translated.ctaMinor,
          inputHash: entity.translated.inputHash,
          lines: entity.translated.lines,
        })),
      },
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      createdAt: now,
    },
    audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
      inputHash: derived.inputHash,
    }),
  });
  return {
    engineVersion,
    formulaVersion: CONSOLIDATION_RATE_POLICY,
    inputHash: derived.inputHash,
    outputHash: derived.outputHash,
    groupCurrency: reportingCurrency,
    ctaAccountId: input.ctaAccountId,
    ctaMinor: derived.consolidated.ctaMinor,
    lines: derived.consolidated.lines,
    entities: derived.entities.map((entity) => ({
      entityId: entity.entityId,
      periodId: entity.periodId,
      sourceCurrency: entity.sourceCurrency,
      rateSetId: entity.translated.rateSetId,
      ctaMinor: entity.translated.ctaMinor,
      lines: entity.translated.lines,
    })),
    calculationRunId,
    consolidationGroupId: groupId,
  };
}

async function eliminateGroup(
  store: LedgerStore,
  actor: ActorContext,
  groupId: string,
  input: EliminateInput,
) {
  const tenant = await scope(store, actor, "consolidation.run");
  const reportingCurrency = await requireGroupCurrency(store, tenant.tenantId, groupId);
  const derived = await deriveTranslatedGroup(
    store,
    tenant.tenantId,
    reportingCurrency,
    input.ctaAccountId,
    input.entities,
    input.rates,
  );
  assertEliminationLines(input, derived.consolidated.lines);
  const result = eliminateIntercompany({
    balances: derived.consolidated.lines,
    eliminations: input.eliminations,
  });
  const outputHash = hashMaterial(result.balances);
  const now = new Date().toISOString();
  await store.insertElimination({
    tenantId: tenant.tenantId,
    id: crypto.randomUUID(),
    consolidationGroupId: groupId,
    evidenceId: input.evidenceId,
    inputHash: result.inputHash,
    payload: {
      formulaVersion: CONSOLIDATION_RATE_POLICY,
      reportingCurrency,
      balances: result.balances,
      outputHash,
      entities: derived.entities.map(entitySnapshot),
      eliminations: input.eliminations,
    },
    createdAt: now,
    audit: audit(actor, "EliminationRecorded", "elimination_entry", groupId, now, {
      inputHash: result.inputHash,
    }),
  });
  return {
    ...result,
    formulaVersion: CONSOLIDATION_RATE_POLICY,
    outputHash,
    groupCurrency: reportingCurrency,
    consolidationGroupId: groupId,
  };
}

async function requireGroupCurrency(store: LedgerStore, tenantId: string, groupId: string) {
  const group = await store.getConsolidationGroup(tenantId, groupId);
  if (!group) {
    throw new KernelError("FIN_NOT_FOUND", "Consolidation group not found");
  }
  return group.reportingCurrency;
}

async function deriveTranslatedGroup(
  store: LedgerStore,
  tenantId: string,
  reportingCurrency: string,
  ctaAccountId: string,
  entities: readonly EntityPeriodScope[],
  rates: readonly RateTriple[],
) {
  assertUniqueEntities(entities);
  const loaded = [];
  for (const scope of entities) {
    loaded.push(await loadPostedTrialBalance(store, tenantId, scope.entityId, scope.periodId));
  }
  assertSamePeriod(loaded.map((entity) => ({ start: entity.periodStart, end: entity.periodEnd })));
  assertCtaNotInScope(loaded, ctaAccountId);
  const translated = loaded.map((entity) => ({
    ...entity,
    translated: translateTrialBalance({
      sourceCurrency: entity.sourceCurrency,
      lines: entity.lines,
      rates: rateTripleFor(rates, entity.sourceCurrency, reportingCurrency),
      ctaAccountId,
    }),
  }));
  const consolidated = consolidateTranslations(translated.map((entity) => entity.translated));
  let total = 0n;
  for (const line of consolidated.lines) {
    total += BigInt(line.debitPositiveMinor);
  }
  if (total !== 0n) {
    throw new KernelError("FIN_STATEMENT_IMBALANCE", "Consolidated trial balance does not balance");
  }
  const ordered = [...translated].sort((left, right) =>
    left.entityId === right.entityId
      ? compareCode(left.periodId, right.periodId)
      : compareCode(left.entityId, right.entityId),
  );
  const inputHash = hashMaterial({
    formulaVersion: CONSOLIDATION_RATE_POLICY,
    reportingCurrency,
    ctaAccountId,
    entities: ordered.map(entitySnapshot),
    rates: [...rates].sort((left, right) => compareCode(left.sourceCurrency, right.sourceCurrency)),
  });
  const outputHash = hashMaterial({
    formulaVersion: CONSOLIDATION_RATE_POLICY,
    reportingCurrency,
    ctaAccountId,
    ctaMinor: consolidated.ctaMinor,
    lines: consolidated.lines,
  });
  return { entities: ordered, consolidated, inputHash, outputHash };
}

function entitySnapshot(entity: {
  readonly entityId: string;
  readonly periodId: string;
  readonly sourceCurrency: string;
  readonly journalIds: readonly string[];
  readonly lines: readonly TrialBalanceLine[];
}) {
  return {
    entityId: entity.entityId,
    periodId: entity.periodId,
    sourceCurrency: entity.sourceCurrency,
    journalIds: entity.journalIds,
    lines: entity.lines,
  };
}

function compareCode(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertCtaNotInScope(
  entities: readonly { readonly lines: readonly { readonly accountId: string }[] }[],
  ctaAccountId: string,
): void {
  for (const entity of entities) {
    if (entity.lines.some((line) => line.accountId === ctaAccountId)) {
      throw new KernelError("FX_INVALID_RATE", "CTA account is reserved for the translation plug");
    }
  }
}

function assertEliminationLines(
  input: EliminateInput,
  consolidatedLines: readonly { readonly accountId: string }[],
): void {
  const accounts = new Set(consolidatedLines.map((line) => line.accountId));
  for (const line of input.eliminations) {
    if (line.evidenceId !== input.evidenceId) {
      throw new KernelError(
        "FIN_INVALID_JOURNAL_LINE",
        "Elimination evidence must match the request evidence",
      );
    }
    if (line.accountId === input.ctaAccountId || !accounts.has(line.accountId)) {
      throw new KernelError(
        "FIN_INVALID_JOURNAL_LINE",
        "Elimination account must be a consolidated line other than CTA",
      );
    }
  }
}

function assertUniqueEntities(entities: readonly EntityPeriodScope[]): void {
  const seen = new Set<string>();
  for (const scope of entities) {
    if (seen.has(scope.entityId)) {
      throw new KernelError(
        "FIN_INVALID_JOURNAL_LINE",
        "Duplicate entity in the consolidation scope",
      );
    }
    seen.add(scope.entityId);
  }
}

function assertSamePeriod(
  periods: readonly { readonly start: string; readonly end: string }[],
): void {
  const [first, ...rest] = periods;
  if (
    first !== undefined &&
    rest.some((period) => period.start !== first.start || period.end !== first.end)
  ) {
    throw new KernelError(
      "FIN_INVALID_PERIOD",
      "Consolidation periods must share the same start and end dates",
    );
  }
}

function rateTripleFor(
  rates: readonly RateTriple[],
  sourceCurrency: string,
  reportingCurrency: string,
): { readonly closing: FxRate; readonly historical: FxRate; readonly average: FxRate } {
  const matches = rates.filter((rate) => rate.sourceCurrency === sourceCurrency);
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (!selected) {
    if (matches.length > 1) {
      throw new KernelError("FX_INVALID_RATE", `More than one FX rate set for ${sourceCurrency}`);
    }
    if (sourceCurrency === reportingCurrency) {
      return identityRates(sourceCurrency);
    }
    throw new KernelError("FX_RATE_MISSING", `No FX rates for ${sourceCurrency}`);
  }
  for (const rate of [selected.closing, selected.historical, selected.average]) {
    if (rate.base !== sourceCurrency || rate.quote !== reportingCurrency) {
      throw new KernelError(
        "FX_INVALID_RATE",
        "FX rates must convert the entity currency into the group reporting currency",
      );
    }
  }
  if (
    sourceCurrency === reportingCurrency &&
    [selected.closing, selected.historical, selected.average].some(
      (rate) => !new AnalyticalDecimal(rate.rate).eq(1),
    )
  ) {
    throw new KernelError(
      "FX_INVALID_RATE",
      "An identity translation requires a rate of exactly 1",
    );
  }
  return { closing: selected.closing, historical: selected.historical, average: selected.average };
}

function identityRates(currency: string): {
  readonly closing: FxRate;
  readonly historical: FxRate;
  readonly average: FxRate;
} {
  const rate: FxRate = {
    rateSetId: "identity",
    base: currency,
    quote: currency,
    rate: "1",
    rounding: "half_even",
  };
  return { closing: rate, historical: rate, average: rate };
}

/** Posted activity for one entity period. Journal posting rejects a foreign currency before storage, so the HTTP routes cannot reach the currency check. */
export async function loadPostedTrialBalance(
  store: LedgerStore,
  tenantId: string,
  entityId: string,
  periodId: string,
) {
  const activity = await loadClassifiedActivity(store, tenantId, entityId, periodId);
  for (const line of activity.lines) {
    if (line.currency !== activity.currency) {
      throw new KernelError(
        "FIN_CURRENCY_MISMATCH",
        "Posted journal currency does not match the entity functional currency",
      );
    }
  }
  const lines = trialBalanceFromClassifiedLines(activity.lines, activity.retainedEarningsAccountId);
  if (lines.length === 0) {
    throw new KernelError(
      "FIN_STATEMENT_IMBALANCE",
      "Posted ledger entries net to an empty trial balance",
    );
  }
  const journalIds = [
    ...new Set(activity.lines.flatMap((line) => (line.journalId ? [line.journalId] : []))),
  ].sort();
  return {
    entityId,
    periodId,
    periodStart: activity.periodStart,
    periodEnd: activity.periodEnd,
    sourceCurrency: activity.currency,
    journalIds,
    lines,
  };
}

async function createGroup(
  store: LedgerStore,
  actor: ActorContext,
  input: { name: string; reportingCurrency: string },
) {
  const tenant = await scope(store, actor, "consolidation.run");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertConsolidationGroup({
    tenantId: tenant.tenantId,
    id,
    name: input.name,
    reportingCurrency: input.reportingCurrency,
    payload: input,
    createdAt: now,
    audit: audit(actor, "ConsolidationGroupCreated", "consolidation_group", id, now, input),
  });
  return { consolidationGroupId: id };
}

async function createModel(store: LedgerStore, actor: ActorContext, input: { name: string }) {
  const tenant = await scope(store, actor, "model.write");
  const now = new Date().toISOString();
  const modelId = crypto.randomUUID();
  await store.insertModel({ tenantId: tenant.tenantId, modelId, name: input.name, createdAt: now });
  return { modelId };
}

async function saveModelVersion(
  store: LedgerStore,
  actor: ActorContext,
  modelId: string,
  nodes: readonly CalcNode[],
) {
  const tenant = await scope(store, actor, "model.write");
  if (!(await store.getModel(tenant.tenantId, modelId)))
    throw new KernelError("FIN_NOT_FOUND", "Model not found");
  const now = new Date().toISOString();
  const modelVersionId = crypto.randomUUID();
  const inputHash = hashMaterial(nodes);
  await store.insertModelVersion({
    tenantId: tenant.tenantId,
    modelVersionId,
    modelId,
    status: "draft",
    inputHash,
    engineVersion: ENGINE_VERSION,
    nodes: nodes.map((node) => ({
      id: crypto.randomUUID(),
      nodeKey: node.id,
      payload: { ...node },
    })),
    payload: { nodes },
    createdAt: now,
    audit: audit(actor, "ModelVersionCreated", "model_version", modelVersionId, now, { inputHash }),
  });
  return { modelVersionId, inputHash, engineVersion: ENGINE_VERSION };
}

async function calculateModel(
  store: LedgerStore,
  actor: ActorContext,
  modelId: string,
  nodes: readonly CalcNode[],
) {
  const tenant = await scope(store, actor, "model.calculate");
  if (!(await store.getModel(tenant.tenantId, modelId)))
    throw new KernelError("FIN_NOT_FOUND", "Model not found");
  const result = evaluateGraph(nodes);
  const now = new Date().toISOString();
  const calculationRunId = crypto.randomUUID();
  await store.insertCalculationRun({
    run: {
      calculationRunId,
      tenantId: tenant.tenantId,
      kind: "model",
      status: "succeeded",
      engineVersion: result.engineVersion,
      inputHash: result.inputHash,
      inputs: { modelId, nodes },
      outputs: result.outputs,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      createdAt: now,
    },
    audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
      inputHash: result.inputHash,
    }),
  });
  return { ...result, calculationRunId, modelId };
}

async function createScenario(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    baseVersionId: string;
    name: string;
    base: Record<string, string>;
    overrides: Record<string, string>;
  },
) {
  const tenant = await scope(store, actor, "scenario.write");
  if (!(await store.getModelVersion(tenant.tenantId, input.baseVersionId)))
    throw new KernelError("FIN_NOT_FOUND", "Base model version not found");
  const projected = projectScenario(input.base, input.overrides);
  const now = new Date().toISOString();
  const scenarioId = crypto.randomUUID();
  const outputHash = hashMaterial(projected.scenario);
  await store.insertScenario({
    tenantId: tenant.tenantId,
    scenarioId,
    baseVersionId: input.baseVersionId,
    name: input.name,
    outputHash,
    payload: { base: projected.base, scenario: projected.scenario },
    createdAt: now,
    audit: audit(actor, "ScenarioCreated", "scenario", scenarioId, now, { outputHash }),
  });
  return { scenarioId, base: projected.base, scenario: projected.scenario, outputHash };
}

async function createValuation(store: LedgerStore, actor: ActorContext, input: DcfInput) {
  const tenant = await scope(store, actor, "valuation.calculate");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const calculationRunId = crypto.randomUUID();
  try {
    const result = valueDcf(input);
    await store.insertCalculationRun({
      run: runRecord(
        tenant.tenantId,
        actor,
        calculationRunId,
        "dcf",
        "succeeded",
        result.engineVersion,
        result.inputHash,
        input,
        result,
        now,
      ),
      audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
        inputHash: result.inputHash,
      }),
    });
    await store.insertValuation(
      valuationRow(
        tenant.tenantId,
        actor,
        id,
        "draft",
        "succeeded",
        calculationRunId,
        result.inputHash,
        { ...result, assumption: input },
        now,
      ),
    );
    return {
      valuationId: id,
      status: "draft",
      calculationStatus: "succeeded",
      ...result,
      calculationRunId,
    };
  } catch (error) {
    if (!(error instanceof KernelError)) {
      throw error;
    }
    const inputHash = hashMaterial(input);
    await store.insertCalculationRun({
      run: runRecord(
        tenant.tenantId,
        actor,
        calculationRunId,
        "dcf",
        "failed",
        ENGINE_VERSION,
        inputHash,
        input,
        { code: error.code },
        now,
      ),
      audit: audit(actor, "CalculationFailed", "calculation_run", calculationRunId, now, {
        code: error.code,
      }),
    });
    await store.insertValuation(
      valuationRow(
        tenant.tenantId,
        actor,
        id,
        "draft",
        "failed",
        calculationRunId,
        inputHash,
        { code: error.code, assumption: input },
        now,
      ),
    );
    return {
      valuationId: id,
      status: "draft",
      calculationStatus: "failed" as const,
      code: error.code,
      message: error.message,
      calculationRunId,
      inputHash,
      engineVersion: ENGINE_VERSION,
    };
  }
}

async function readValuation(store: LedgerStore, actor: ActorContext, id: string) {
  const tenant = await scope(store, actor, "valuation.calculate");
  const current = await store.getValuation(tenant.tenantId, id);
  if (!current) {
    throw new KernelError("FIN_NOT_FOUND", "Valuation not found");
  }
  const assumption = isRecord(current.payload) ? current.payload.assumption : undefined;
  const base = readDcfInput(assumption);
  if (!base) {
    throw new KernelError("FIN_NOT_FOUND", "Valuation assumptions were not stored");
  }
  return { valuationId: current.id, status: current.status, stateHash: current.stateHash, base };
}

async function transitionValuation(
  store: LedgerStore,
  actor: ActorContext,
  id: string,
  to: string,
) {
  const tenant = await scope(store, actor, "valuation.publish");
  const current = await store.getValuation(tenant.tenantId, id);
  if (!current) {
    throw new KernelError("FIN_NOT_FOUND", "Valuation not found");
  }
  const from = asStatus(current.status);
  const target = asStatus(to);
  const calculationStatus = readCalculationStatus(current.payload);
  if (target === "published") {
    assertCanPublish({ calculationStatus, from });
    assertMakerChecker(readMaker(current.payload), actor.actorId);
  } else {
    assertTransition(from, target);
  }
  const now = new Date().toISOString();
  const nextId = crypto.randomUUID();
  await store.insertValuation({
    ...valuationRow(
      tenant.tenantId,
      actor,
      nextId,
      target,
      calculationStatus,
      null,
      current.stateHash,
      current.payload,
      now,
    ),
    makerActorId: readMaker(current.payload),
  });
  await store.insertApproval({
    tenantId: tenant.tenantId,
    approvalId: crypto.randomUUID(),
    objectType: "valuation",
    objectId: nextId,
    actorId: actor.actorId,
    decision: target,
    policyVersion: "publication-1",
    createdAt: now,
    audit: audit(actor, "ApprovalRecorded", "valuation", nextId, now, { decision: target }),
  });
  return {
    valuationId: nextId,
    status: target,
    stateHash: current.stateHash,
    supersedesId: current.id,
  };
}

async function sensitivity(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    base: DcfInput;
    shocks: readonly {
      id: string;
      wacc?: string | undefined;
      terminalGrowth?: string | undefined;
    }[];
  },
) {
  const tenant = await scope(store, actor, "valuation.calculate");
  const result = valueDcfSensitivity(input);
  const now = new Date().toISOString();
  const calculationRunId = crypto.randomUUID();
  await store.insertCalculationRun({
    run: runRecord(
      tenant.tenantId,
      actor,
      calculationRunId,
      "dcf-sensitivity",
      "succeeded",
      result.engineVersion,
      result.inputHash,
      input,
      result.runs,
      now,
    ),
    audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
      inputHash: result.inputHash,
    }),
  });
  return {
    calculationRunId,
    inputHash: result.inputHash,
    engineVersion: result.engineVersion,
    runs: result.runs.map((run) => ({
      id: run.id,
      calculationRunId,
      enterpriseValue: run.result.enterpriseValue,
      equityValue: run.result.equityValue,
    })),
  };
}

async function createReportPack(
  store: LedgerStore,
  actor: ActorContext,
  input: { statementStateId: string; valuationId: string },
) {
  const tenant = await scope(store, actor, "report.write");
  const statement = await store.getFinancialState(tenant.tenantId, input.statementStateId);
  const valuationRow = await store.getValuation(tenant.tenantId, input.valuationId);
  if (!statement || !valuationRow) {
    throw new KernelError("FIN_NOT_FOUND", "Published inputs were not found");
  }
  if (statement.status !== "published" || valuationRow.status !== "published") {
    throw new KernelError("PUBLISH_BLOCKED", "A board pack can include only published states");
  }
  if (readCalculationStatus(valuationRow.payload) === "failed") {
    throw new KernelError("PUBLISH_BLOCKED", "A failed valuation cannot enter a board pack");
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const stateHashValue = hashMaterial({
    statement: statement.stateHash,
    valuation: valuationRow.stateHash,
  });
  await store.insertReportPack({
    tenantId: tenant.tenantId,
    id,
    status: "published",
    cutoffAt: now,
    stateHash: stateHashValue,
    payload: {
      statementStateId: statement.id,
      valuationId: valuationRow.id,
      statementHash: statement.stateHash,
      valuationHash: valuationRow.stateHash,
    },
    createdAt: now,
    audit: audit(actor, "ReportPackPublished", "report_pack", id, now, {
      stateHash: stateHashValue,
    }),
  });
  return {
    reportPackId: id,
    status: "published",
    stateHash: stateHashValue,
    engineVersion: ENGINE_VERSION,
  };
}

async function getReportPack(store: LedgerStore, actor: ActorContext, id: string) {
  const tenant = await scope(store, actor, "lineage.read");
  const pack = await store.getReportPack(tenant.tenantId, id);
  if (!pack) {
    throw new KernelError("FIN_NOT_FOUND", "Report pack not found");
  }
  return {
    reportPackId: pack.id,
    status: pack.status,
    stateHash: pack.stateHash,
    payload: pack.payload,
  };
}

interface DebtInput {
  readonly entityId: string;
  readonly name: string;
  readonly openingMinor: string;
  readonly drawMinor: string;
  readonly repaymentMinor: string;
  readonly accruedInterestMinor: string;
}

async function saveDebt(store: LedgerStore, actor: ActorContext, input: DebtInput) {
  const tenant = await scope(store, actor, "capital.write");
  await requireProgramEntity(store, tenant.tenantId, input.entityId);
  const rolled = rollDebt(input);
  const now = new Date().toISOString();
  const instrumentId = crypto.randomUUID();
  await store.insertInstrument({
    tenantId: tenant.tenantId,
    instrumentId,
    entityId: input.entityId,
    name: input.name,
    kind: "debt",
    createdAt: now,
  });
  await store.insertDebtTerms({
    tenantId: tenant.tenantId,
    id: crypto.randomUUID(),
    parentId: instrumentId,
    inputHash: rolled.inputHash,
    payload: { ...rolled },
    createdAt: now,
    audit: audit(actor, "DebtRolled", "debt_terms", instrumentId, now, {
      closingMinor: rolled.closingMinor,
    }),
  });
  return { instrumentId, ...rolled };
}

interface CapInput {
  readonly entityId: string;
  readonly holdings: readonly {
    readonly holderId: string;
    readonly commonShares: string;
    readonly options: string;
    readonly convertibles: string;
  }[];
}

async function saveCapTable(store: LedgerStore, actor: ActorContext, input: CapInput) {
  const tenant = await scope(store, actor, "capital.write");
  await requireProgramEntity(store, tenant.tenantId, input.entityId);
  const reconciled = reconcileCapTable(input.holdings);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertCapTable({
    tenantId: tenant.tenantId,
    id,
    entityId: input.entityId,
    inputHash: reconciled.inputHash,
    payload: { fullyDilutedShares: reconciled.fullyDilutedShares, ownership: reconciled.ownership },
    holdings: input.holdings.map((holding) => ({ ...holding, id: crypto.randomUUID() })),
    createdAt: now,
    audit: audit(actor, "CapTableReconciled", "cap_table_version", id, now, {
      inputHash: reconciled.inputHash,
    }),
  });
  return { capTableVersionId: id, ...reconciled };
}

async function saveSourcesUses(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    sources: readonly { label: string; amountMinor: string }[];
    uses: readonly { label: string; amountMinor: string }[];
  },
) {
  const tenant = await scope(store, actor, "capital.write");
  const result = assertSourcesEqualUses(input);
  const now = new Date().toISOString();
  const calculationRunId = crypto.randomUUID();
  await store.insertCalculationRun({
    run: runRecord(
      tenant.tenantId,
      actor,
      calculationRunId,
      "sources-uses",
      "succeeded",
      result.engineVersion,
      result.inputHash,
      input,
      result,
      now,
    ),
    audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
      inputHash: result.inputHash,
    }),
  });
  return { calculationRunId, ...result };
}

async function saveLbo(
  store: LedgerStore,
  actor: ActorContext,
  input: { entryEquity: string; exitEquity: string; holdYears: string },
) {
  const tenant = await scope(store, actor, "capital.write");
  const result = lboReturns(input);
  const now = new Date().toISOString();
  const calculationRunId = crypto.randomUUID();
  await store.insertCalculationRun({
    run: runRecord(
      tenant.tenantId,
      actor,
      calculationRunId,
      "lbo",
      "succeeded",
      result.engineVersion,
      result.inputHash,
      input,
      result,
      now,
    ),
    audit: audit(actor, "CalculationCompleted", "calculation_run", calculationRunId, now, {
      moic: result.moic,
    }),
  });
  return { calculationRunId, ...result };
}

async function importBatch(
  store: LedgerStore,
  actor: ActorContext,
  input: { rows: readonly { rowNo: number; account: string; amount: string }[] },
) {
  const tenant = await scope(store, actor, "import.write");
  const key = actor.idempotencyKey;
  if (!key) {
    throw new KernelError("FIN_IDEMPOTENCY_MISMATCH", "Import requires an idempotency key");
  }
  const fileHash = hashMaterial(
    input.rows.map((row) => ({
      rowNo: String(row.rowNo),
      account: row.account,
      amount: row.amount,
    })),
  );
  const existing = await store.findImportBatch(tenant.tenantId, key);
  if (existing) {
    if (existing.stateHash !== fileHash) {
      throw new KernelError(
        "FIN_IDEMPOTENCY_MISMATCH",
        "Idempotency key was already used for a different file",
      );
    }
    return { importBatchId: existing.id, fileHash, replayed: true };
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertImportBatch({
    tenantId: tenant.tenantId,
    id,
    idempotencyKey: key,
    fileHash,
    payload: { rows: input.rows },
    rows: input.rows.map((row) => ({
      id: crypto.randomUUID(),
      rowNo: row.rowNo,
      payload: { ...row },
    })),
    createdAt: now,
    audit: audit(actor, "ImportBatchCreated", "import_batch", id, now, { fileHash }),
  });
  return { importBatchId: id, fileHash, replayed: false };
}

async function qoe(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    reported: string;
    adjustments: readonly { adjustmentId: string; sourceRowId: string; amount: string }[];
  },
) {
  const tenant = await scope(store, actor, "import.write");
  const bridge = buildQoeBridge({
    reported: input.reported,
    adjustments: input.adjustments.map((adjustment) => ({ ...adjustment, actorId: actor.actorId })),
  });
  return { ...bridge, tenantId: tenant.tenantId };
}

async function propose(
  store: LedgerStore,
  actor: ActorContext,
  input: { claims: readonly { text: string; citationId: string | null }[] },
) {
  const tenant = await scope(store, actor, "proposal.write");
  const cited = acceptCitedClaims(input.claims);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertProposal({
    tenantId: tenant.tenantId,
    id,
    kind: "assumption",
    status: "suggested",
    citationId: cited.accepted.find((claim) => claim.citationId)?.citationId ?? null,
    payload: { accepted: cited.accepted, discarded: cited.discarded },
    createdAt: now,
    audit: audit(actor, "ProposalSuggested", "proposal", id, now, {
      discarded: cited.discarded.length,
    }),
  });
  if (cited.accepted.every((claim) => !/\d/.test(claim.text)) && cited.discarded.length > 0) {
    return {
      proposalId: id,
      status: "suggested",
      refusal: "Uncited numeric claims were discarded",
      ...cited,
    };
  }
  return { proposalId: id, status: "suggested", ...cited };
}

async function acceptProposal(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    entityId: string;
    periodId: string;
    currency: string;
    lines: readonly { accountId: string; debitMinor: string; creditMinor: string }[];
  },
) {
  await scope(store, actor, "proposal.write");
  const journal = validateJournal({
    currency: input.currency,
    entityId: input.entityId,
    periodId: input.periodId,
    lines: input.lines.map((line) => ({
      accountId: line.accountId,
      debit: money(input.currency, line.debitMinor),
      credit: money(input.currency, line.creditMinor),
    })),
  });
  return {
    accepted: true,
    payloadHash: journal.payloadHash,
    totalDebitMinor: journal.totalDebitMinor,
  };
}

async function createDeal(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    publishedStateHash: string;
    base: Record<string, string>;
    overrides: Record<string, string>;
  },
) {
  const tenant = await scope(store, actor, "deal.write");
  const result = applyDealScenario(input);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertDeal({
    tenantId: tenant.tenantId,
    id,
    publishedStateHash: result.publishedStateHash,
    outputHash: result.outputHash,
    payload: { base: result.base, scenario: result.scenario },
    createdAt: now,
    audit: audit(actor, "DealScenarioCreated", "deal", id, now, { outputHash: result.outputHash }),
  });
  return { dealId: id, ...result };
}

async function mapBasis(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    basisVersion: string;
    localBalances: readonly { accountId: string; debitPositiveMinor: string }[];
    mappings: readonly { localAccountId: string; groupAccountId: string }[];
  },
) {
  const tenant = await scope(store, actor, "state.write");
  const mapped = mapReportingBasis(input);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await store.insertReportingBasis({
    tenantId: tenant.tenantId,
    id,
    basisVersion: mapped.basisVersion,
    localHash: mapped.localHash,
    groupHash: mapped.groupHash,
    payload: { groupBalances: mapped.groupBalances },
    createdAt: now,
    audit: audit(actor, "ReportingBasisMapped", "reporting_basis", id, now, {
      groupHash: mapped.groupHash,
    }),
  });
  return { reportingBasisId: id, ...mapped };
}

async function recordOwnership(
  store: LedgerStore,
  actor: ActorContext,
  input: {
    asOf: string;
    parentEntityId: string;
    childEntityId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    percent: string;
    subsidiaryEquityMinor: string;
  },
) {
  const tenant = await scope(store, actor, "consolidation.run");
  await requireProgramEntity(store, tenant.tenantId, input.parentEntityId);
  await requireProgramEntity(store, tenant.tenantId, input.childEntityId);
  const now = new Date().toISOString();
  await store.insertOwnershipEdge({
    tenantId: tenant.tenantId,
    ownershipEdgeId: crypto.randomUUID(),
    parentEntityId: input.parentEntityId,
    childEntityId: input.childEntityId,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    percent: input.percent,
    createdAt: now,
  });
  const edges = await store.listOwnershipEdges(tenant.tenantId);
  const resolved = resolveOwnership({
    asOf: input.asOf,
    parentEntityId: input.parentEntityId,
    childEntityId: input.childEntityId,
    edges: edges.map((edge) => ({
      parentEntityId: edge.parentEntityId,
      childEntityId: edge.childEntityId,
      effectiveFrom: edge.effectiveFrom,
      effectiveTo: edge.effectiveTo,
      percent: edge.percent,
    })),
  });
  const nci = attributeNonControllingInterest({
    subsidiaryEquityMinor: input.subsidiaryEquityMinor,
    ownershipPercent: resolved.percent,
  });
  return { ...resolved, ...nci };
}

function valuationRow(
  tenantId: string,
  actor: ActorContext,
  id: string,
  status: string,
  calculationStatus: "succeeded" | "failed",
  calculationRunId: string | null,
  stateHashValue: string,
  payload: unknown,
  now: string,
) {
  return {
    tenantId,
    id,
    entityId: "00000000-0000-4000-8000-000000000000",
    periodId: "00000000-0000-4000-8000-000000000000",
    basis: "valuation",
    currency: "USD",
    stateHash: stateHashValue,
    status,
    engineVersion: ENGINE_VERSION,
    calculationStatus,
    calculationRunId,
    supersedesId: null,
    makerActorId: actor.actorId,
    payload: {
      ...(isRecord(payload) ? payload : { value: payload }),
      makerActorId: readMaker(payload) || actor.actorId,
      calculationStatus,
    },
    createdAt: now,
    audit: audit(actor, "ValuationRecorded", "valuation", id, now, {
      status,
      stateHash: stateHashValue,
    }),
  };
}

function runRecord(
  tenantId: string,
  actor: ActorContext,
  calculationRunId: string,
  kind: string,
  status: "succeeded" | "failed",
  engineVersion: string,
  inputHash: string,
  inputs: unknown,
  outputs: unknown,
  now: string,
) {
  return {
    calculationRunId,
    tenantId,
    kind,
    status,
    engineVersion,
    inputHash,
    inputs,
    outputs,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
    createdAt: now,
  };
}

async function scope(store: LedgerStore, actor: ActorContext, action: Action) {
  if (actor.actorId.length === 0 || actor.region.length === 0 || !actor.tenantId) {
    throw new KernelError("AUTH_SCOPE_DENIED", "Actor, region, and tenant are required");
  }
  const tenant = await store.getTenant(actor.tenantId);
  if (!tenant) {
    throw new KernelError("FIN_NOT_FOUND", "Tenant not found");
  }
  assertSameRegion(tenant.homeRegion, actor.region);
  assertTenantActive(tenant.status);
  const roles = await store.listRoles(tenant.tenantId, actor.actorId);
  authorize(roles, action);
  return tenant;
}

function audit(
  actor: ActorContext,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
) {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    aggregateType,
    aggregateId,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
    occurredAt,
    payload,
  };
}

function asStatus(value: string): PublicationStatus {
  if (!STATUSES.includes(value as PublicationStatus)) {
    throw new KernelError("PUBLISH_BLOCKED", "Unknown publication status");
  }
  return value as PublicationStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readDcfInput(value: unknown): DcfInput | null {
  if (!isRecord(value) || !Array.isArray(value.freeCashFlows)) {
    return null;
  }
  const flows = value.freeCashFlows.filter((item): item is string => typeof item === "string");
  if (flows.length !== value.freeCashFlows.length) {
    return null;
  }
  const currency = value.currency;
  const wacc = value.wacc;
  const terminalGrowth = value.terminalGrowth;
  const netDebt = value.netDebt;
  const nonOperatingAssets = value.nonOperatingAssets;
  const otherClaims = value.otherClaims;
  if (
    typeof currency !== "string" ||
    typeof wacc !== "string" ||
    typeof terminalGrowth !== "string" ||
    typeof netDebt !== "string" ||
    typeof nonOperatingAssets !== "string" ||
    typeof otherClaims !== "string"
  ) {
    return null;
  }
  return {
    currency,
    freeCashFlows: flows,
    wacc,
    terminalGrowth,
    netDebt,
    nonOperatingAssets,
    otherClaims,
  };
}

function readMaker(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const maker = payload.makerActorId;
  return typeof maker === "string" ? maker : "";
}

function readCalculationStatus(payload: unknown): "succeeded" | "failed" {
  if (isRecord(payload) && payload.calculationStatus === "failed") {
    return "failed";
  }
  return "succeeded";
}

async function requireProgramEntity(store: LedgerStore, tenantId: string, entityId: string) {
  if (!(await store.getEntity(tenantId, entityId)))
    throw new KernelError("FIN_NOT_FOUND", "Legal entity not found");
}
