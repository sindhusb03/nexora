import {
  char,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull();

export const financialState = pgTable("financial_state", {
  financialStateId: uuid("financial_state_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  periodId: uuid("period_id").notNull(),
  basis: text("basis").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  stateHash: text("state_hash").notNull(),
  status: text("status").notNull(),
  engineVersion: text("engine_version").notNull(),
  calculationStatus: text("calculation_status").notNull(),
  calculationRunId: uuid("calculation_run_id"),
  supersedesId: uuid("supersedes_id"),
  makerActorId: text("maker_actor_id").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const approval = pgTable("approval", {
  approvalId: uuid("approval_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  objectType: text("object_type").notNull(),
  objectId: uuid("object_id").notNull(),
  actorId: text("actor_id").notNull(),
  decision: text("decision").notNull(),
  policyVersion: text("policy_version").notNull(),
  createdAt: createdAt(),
});

export const lineageEdge = pgTable("lineage_edge", {
  lineageEdgeId: uuid("lineage_edge_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  fromType: text("from_type").notNull(),
  fromId: text("from_id").notNull(),
  toType: text("to_type").notNull(),
  toId: text("to_id").notNull(),
  relation: text("relation").notNull(),
  createdAt: createdAt(),
});

export const fxRateSet = pgTable("fx_rate_set", {
  fxRateSetId: uuid("fx_rate_set_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  label: text("label").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const fxRate = pgTable(
  "fx_rate",
  {
    fxRateId: uuid("fx_rate_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    fxRateSetId: uuid("fx_rate_set_id")
      .notNull()
      .references(() => fxRateSet.fxRateSetId),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    quoteCurrency: char("quote_currency", { length: 3 }).notNull(),
    rateType: text("rate_type").notNull(),
    rate: text("rate").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("fx_rate_set_type").on(table.tenantId, table.fxRateSetId, table.rateType),
  ],
);

export const ownershipEdge = pgTable("ownership_edge", {
  ownershipEdgeId: uuid("ownership_edge_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  parentEntityId: uuid("parent_entity_id").notNull(),
  childEntityId: uuid("child_entity_id").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  percent: text("percent").notNull(),
  createdAt: createdAt(),
});

export const consolidationGroup = pgTable("consolidation_group", {
  consolidationGroupId: uuid("consolidation_group_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  reportingCurrency: char("reporting_currency", { length: 3 }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const eliminationEntry = pgTable("elimination_entry", {
  eliminationEntryId: uuid("elimination_entry_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  consolidationGroupId: uuid("consolidation_group_id")
    .notNull()
    .references(() => consolidationGroup.consolidationGroupId),
  evidenceId: text("evidence_id").notNull(),
  inputHash: text("input_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const model = pgTable("model", {
  modelId: uuid("model_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const modelVersion = pgTable("model_version", {
  modelVersionId: uuid("model_version_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  modelId: uuid("model_id")
    .notNull()
    .references(() => model.modelId),
  status: text("status").notNull(),
  inputHash: text("input_hash").notNull(),
  engineVersion: text("engine_version").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const modelNode = pgTable(
  "model_node",
  {
    modelNodeId: uuid("model_node_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    modelVersionId: uuid("model_version_id")
      .notNull()
      .references(() => modelVersion.modelVersionId),
    nodeKey: text("node_key").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    uniqueIndex("model_node_key").on(table.tenantId, table.modelVersionId, table.nodeKey),
  ],
);

export const assumptionSet = pgTable("assumption_set", {
  assumptionSetId: uuid("assumption_set_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  modelVersionId: uuid("model_version_id")
    .notNull()
    .references(() => modelVersion.modelVersionId),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const scenario = pgTable("scenario", {
  scenarioId: uuid("scenario_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  baseVersionId: uuid("base_version_id").notNull(),
  name: text("name").notNull(),
  outputHash: text("output_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const valuation = pgTable("valuation", {
  valuationId: uuid("valuation_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  status: text("status").notNull(),
  calculationStatus: text("calculation_status").notNull(),
  calculationRunId: uuid("calculation_run_id"),
  stateHash: text("state_hash").notNull(),
  engineVersion: text("engine_version").notNull(),
  makerActorId: text("maker_actor_id").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const reportPack = pgTable("report_pack", {
  reportPackId: uuid("report_pack_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  status: text("status").notNull(),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true, mode: "string" }).notNull(),
  stateHash: text("state_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const instrument = pgTable("instrument", {
  instrumentId: uuid("instrument_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  createdAt: createdAt(),
});

export const debtTerms = pgTable("debt_terms", {
  debtTermsId: uuid("debt_terms_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instrument.instrumentId),
  inputHash: text("input_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const capTableVersion = pgTable("cap_table_version", {
  capTableVersionId: uuid("cap_table_version_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  inputHash: text("input_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const holding = pgTable("holding", {
  holdingId: uuid("holding_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  capTableVersionId: uuid("cap_table_version_id")
    .notNull()
    .references(() => capTableVersion.capTableVersionId),
  holderId: text("holder_id").notNull(),
  commonShares: text("common_shares").notNull(),
  options: text("options").notNull(),
  convertibles: text("convertibles").notNull(),
});

export const importBatch = pgTable(
  "import_batch",
  {
    importBatchId: uuid("import_batch_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    fileHash: text("file_hash").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("import_batch_idempotency").on(table.tenantId, table.idempotencyKey)],
);

export const sourceRow = pgTable(
  "source_row",
  {
    sourceRowId: uuid("source_row_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    importBatchId: uuid("import_batch_id")
      .notNull()
      .references(() => importBatch.importBatchId),
    rowNo: integer("row_no").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (table) => [uniqueIndex("source_row_no").on(table.tenantId, table.importBatchId, table.rowNo)],
);

export const accountMapping = pgTable("account_mapping", {
  accountMappingId: uuid("account_mapping_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  importBatchId: uuid("import_batch_id")
    .notNull()
    .references(() => importBatch.importBatchId),
  sourceAccount: text("source_account").notNull(),
  accountId: uuid("account_id").notNull(),
  createdAt: createdAt(),
});

export const reconciliation = pgTable("reconciliation", {
  reconciliationId: uuid("reconciliation_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  importBatchId: uuid("import_batch_id")
    .notNull()
    .references(() => importBatch.importBatchId),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const normalizationAdjustment = pgTable("normalization_adjustment", {
  normalizationAdjustmentId: uuid("normalization_adjustment_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  sourceRowId: uuid("source_row_id").notNull(),
  actorId: text("actor_id").notNull(),
  amount: text("amount").notNull(),
  stepHash: text("step_hash").notNull(),
  createdAt: createdAt(),
});

export const proposal = pgTable("proposal", {
  proposalId: uuid("proposal_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  citationId: text("citation_id"),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const deal = pgTable("deal", {
  dealId: uuid("deal_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  publishedStateHash: text("published_state_hash").notNull(),
  outputHash: text("output_hash").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
});

export const reportingBasis = pgTable(
  "reporting_basis",
  {
    reportingBasisId: uuid("reporting_basis_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    basisVersion: text("basis_version").notNull(),
    localHash: text("local_hash").notNull(),
    groupHash: text("group_hash").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("reporting_basis_hash").on(table.tenantId, table.basisVersion, table.localHash),
  ],
);

export const programSchema = {
  financialState,
  approval,
  lineageEdge,
  fxRateSet,
  fxRate,
  ownershipEdge,
  consolidationGroup,
  eliminationEntry,
  model,
  modelVersion,
  modelNode,
  assumptionSet,
  scenario,
  valuation,
  reportPack,
  instrument,
  debtTerms,
  capTableVersion,
  holding,
  importBatch,
  sourceRow,
  accountMapping,
  reconciliation,
  normalizationAdjustment,
  proposal,
  deal,
  reportingBasis,
};
