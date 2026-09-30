-- Gate G2–G11 objects. Versions are inserted. Published and posted facts are not updated.

CREATE TABLE financial_state (
  financial_state_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  entity_id uuid NOT NULL,
  period_id uuid NOT NULL,
  basis text NOT NULL,
  currency char(3) NOT NULL,
  state_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'review', 'approved', 'published', 'rejected')),
  engine_version text NOT NULL,
  calculation_status text NOT NULL CHECK (calculation_status IN ('succeeded', 'failed')),
  calculation_run_id uuid,
  supersedes_id uuid,
  maker_actor_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE approval (
  approval_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  object_type text NOT NULL,
  object_id uuid NOT NULL,
  actor_id text NOT NULL,
  decision text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE lineage_edge (
  lineage_edge_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  from_type text NOT NULL,
  from_id text NOT NULL,
  to_type text NOT NULL,
  to_id text NOT NULL,
  relation text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE fx_rate_set (
  fx_rate_set_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  label text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE fx_rate (
  fx_rate_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  fx_rate_set_id uuid NOT NULL REFERENCES fx_rate_set (fx_rate_set_id),
  base_currency char(3) NOT NULL,
  quote_currency char(3) NOT NULL,
  rate_type text NOT NULL CHECK (rate_type IN ('closing', 'historical', 'average')),
  rate text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, fx_rate_set_id, rate_type)
);

CREATE TABLE ownership_edge (
  ownership_edge_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  parent_entity_id uuid NOT NULL,
  child_entity_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  percent text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE consolidation_group (
  consolidation_group_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  name text NOT NULL,
  reporting_currency char(3) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE elimination_entry (
  elimination_entry_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_group (consolidation_group_id),
  evidence_id text NOT NULL,
  input_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE model (
  model_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  name text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE model_version (
  model_version_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  model_id uuid NOT NULL REFERENCES model (model_id),
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  input_hash text NOT NULL,
  engine_version text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE model_node (
  model_node_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  model_version_id uuid NOT NULL REFERENCES model_version (model_version_id),
  node_key text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (tenant_id, model_version_id, node_key)
);

CREATE TABLE assumption_set (
  assumption_set_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  model_version_id uuid NOT NULL REFERENCES model_version (model_version_id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE scenario (
  scenario_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  base_version_id uuid NOT NULL,
  name text NOT NULL,
  output_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE valuation (
  valuation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'review', 'approved', 'published', 'rejected')),
  calculation_status text NOT NULL CHECK (calculation_status IN ('succeeded', 'failed')),
  calculation_run_id uuid,
  state_hash text NOT NULL,
  engine_version text NOT NULL,
  maker_actor_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE report_pack (
  report_pack_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'review', 'approved', 'published', 'rejected')),
  cutoff_at timestamptz NOT NULL,
  state_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE instrument (
  instrument_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  entity_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('debt', 'equity')),
  created_at timestamptz NOT NULL
);

CREATE TABLE debt_terms (
  debt_terms_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  instrument_id uuid NOT NULL REFERENCES instrument (instrument_id),
  input_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE cap_table_version (
  cap_table_version_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  entity_id uuid NOT NULL,
  input_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE holding (
  holding_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  cap_table_version_id uuid NOT NULL REFERENCES cap_table_version (cap_table_version_id),
  holder_id text NOT NULL,
  common_shares text NOT NULL,
  options text NOT NULL,
  convertibles text NOT NULL
);

CREATE TABLE import_batch (
  import_batch_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  idempotency_key text NOT NULL,
  file_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE source_row (
  source_row_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  import_batch_id uuid NOT NULL REFERENCES import_batch (import_batch_id),
  row_no integer NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (tenant_id, import_batch_id, row_no)
);

CREATE TABLE account_mapping (
  account_mapping_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  import_batch_id uuid NOT NULL REFERENCES import_batch (import_batch_id),
  source_account text NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE reconciliation (
  reconciliation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  import_batch_id uuid NOT NULL REFERENCES import_batch (import_batch_id),
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE normalization_adjustment (
  normalization_adjustment_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  source_row_id uuid NOT NULL,
  actor_id text NOT NULL,
  amount text NOT NULL,
  step_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE proposal (
  proposal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  kind text NOT NULL CHECK (kind IN ('journal', 'assumption')),
  status text NOT NULL CHECK (status IN ('suggested', 'accepted', 'rejected')),
  citation_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE deal (
  deal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  published_state_hash text NOT NULL,
  output_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE reporting_basis (
  reporting_basis_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  basis_version text NOT NULL,
  local_hash text NOT NULL,
  group_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, basis_version, local_hash)
);

CREATE INDEX ix_financial_state_tenant ON financial_state (tenant_id, entity_id, period_id);
CREATE INDEX ix_lineage_tenant_from ON lineage_edge (tenant_id, from_type, from_id);
CREATE INDEX ix_import_batch_tenant ON import_batch (tenant_id, idempotency_key);

CREATE TRIGGER financial_state_append_only
BEFORE UPDATE OR DELETE ON financial_state
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER approval_append_only
BEFORE UPDATE OR DELETE ON approval
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER lineage_edge_append_only
BEFORE UPDATE OR DELETE ON lineage_edge
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER valuation_append_only
BEFORE UPDATE OR DELETE ON valuation
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER report_pack_append_only
BEFORE UPDATE OR DELETE ON report_pack
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER model_version_append_only
BEFORE UPDATE OR DELETE ON model_version
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

DO $$
DECLARE
  target text;
  targets text[] := ARRAY[
    'financial_state', 'approval', 'lineage_edge', 'fx_rate_set', 'fx_rate',
    'ownership_edge', 'consolidation_group', 'elimination_entry', 'model',
    'model_version', 'model_node', 'assumption_set', 'scenario', 'valuation',
    'report_pack', 'instrument', 'debt_terms', 'cap_table_version', 'holding',
    'import_batch', 'source_row', 'account_mapping', 'reconciliation',
    'normalization_adjustment', 'proposal', 'deal', 'reporting_basis'
  ];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = app_tenant_id()) WITH CHECK (tenant_id::text = app_tenant_id())',
      target
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON
  financial_state,
  approval,
  lineage_edge,
  fx_rate_set,
  fx_rate,
  ownership_edge,
  consolidation_group,
  elimination_entry,
  model,
  model_version,
  model_node,
  assumption_set,
  scenario,
  valuation,
  report_pack,
  instrument,
  debt_terms,
  cap_table_version,
  holding,
  import_batch,
  source_row,
  account_mapping,
  reconciliation,
  normalization_adjustment,
  proposal,
  deal,
  reporting_basis
TO nexora_app;
