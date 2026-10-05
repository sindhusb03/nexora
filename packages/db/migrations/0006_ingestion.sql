-- Ingestion jobs, extracted values, mappings, and exceptions.
-- These rows are not posted journals. Posting still goes through journal_entry.

CREATE TABLE ingestion_job (
  ingestion_job_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entity (legal_entity_id),
  status text NOT NULL CHECK (
    status IN (
      'queued',
      'extracting',
      'mapping',
      'validating',
      'needs_review',
      'building',
      'posted',
      'failed'
    )
  ),
  currency char(3),
  formula_version text,
  input_hash text,
  output_hash text,
  model_payload jsonb,
  idempotency_key text,
  content_hash text,
  canonical_hash text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX ingestion_job_idempotency
  ON ingestion_job (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX ix_ingestion_job_tenant ON ingestion_job (tenant_id, created_at);
CREATE INDEX ix_ingestion_job_content
  ON ingestion_job (tenant_id, legal_entity_id, content_hash);
CREATE INDEX ix_ingestion_job_canonical
  ON ingestion_job (tenant_id, legal_entity_id, canonical_hash);

CREATE TABLE source_document (
  source_document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  ingestion_job_id uuid NOT NULL REFERENCES ingestion_job (ingestion_job_id),
  file_name text NOT NULL,
  media_type text NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  sha256 text NOT NULL,
  parser_id text,
  status text NOT NULL CHECK (status IN ('pending', 'parsed', 'failed')),
  error text,
  parse_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  statement_kinds text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

CREATE INDEX ix_source_document_job ON source_document (tenant_id, ingestion_job_id);

CREATE TABLE extracted_value (
  extracted_value_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  ingestion_job_id uuid NOT NULL REFERENCES ingestion_job (ingestion_job_id),
  source_document_id uuid NOT NULL REFERENCES source_document (source_document_id),
  statement_type text NOT NULL,
  role text NOT NULL,
  label text NOT NULL,
  period_key text,
  period_start date,
  period_end date,
  span_months integer NOT NULL DEFAULT 1,
  currency char(3),
  scale text NOT NULL,
  amount_minor numeric(38, 0),
  raw_text text NOT NULL,
  page integer,
  sheet text,
  row_no integer,
  col_no integer,
  bbox jsonb,
  account_code text,
  mapping_confidence text,
  mapping_method text,
  mapping_accepted boolean NOT NULL DEFAULT false,
  contra boolean NOT NULL DEFAULT false,
  balance_kind text NOT NULL,
  sort_order integer NOT NULL,
  section_id text NOT NULL DEFAULT 'body'
);

CREATE INDEX ix_extracted_value_job ON extracted_value (tenant_id, ingestion_job_id);

CREATE TABLE ingestion_account_mapping (
  ingestion_account_mapping_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  ingestion_job_id uuid NOT NULL REFERENCES ingestion_job (ingestion_job_id),
  extracted_value_id uuid NOT NULL REFERENCES extracted_value (extracted_value_id),
  account_code text NOT NULL,
  confidence text NOT NULL,
  method text NOT NULL,
  accepted boolean NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX ix_ingestion_account_mapping_job ON ingestion_account_mapping (tenant_id, ingestion_job_id);

CREATE TABLE ingestion_exception (
  ingestion_exception_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  ingestion_job_id uuid NOT NULL REFERENCES ingestion_job (ingestion_job_id),
  source_document_id uuid REFERENCES source_document (source_document_id),
  type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('error', 'warn', 'info')),
  message text NOT NULL,
  expected_value text,
  actual_value text,
  diff_value text,
  provenance jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('open', 'accepted', 'corrected', 'remapped', 'not_applicable')
  ),
  resolution jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX ix_ingestion_exception_job ON ingestion_exception (tenant_id, ingestion_job_id, status);

ALTER TABLE ingestion_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_job FORCE ROW LEVEL SECURITY;
ALTER TABLE source_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_document FORCE ROW LEVEL SECURITY;
ALTER TABLE extracted_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE extracted_value FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion_account_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_account_mapping FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_exception FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ingestion_job
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON source_document
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON extracted_value
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON ingestion_account_mapping
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON ingestion_exception
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion_job TO nexora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON source_document TO nexora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON extracted_value TO nexora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion_account_mapping TO nexora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion_exception TO nexora_app;
