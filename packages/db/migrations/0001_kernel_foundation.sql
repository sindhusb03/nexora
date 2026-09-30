-- Roles are cluster-wide, so a second database on the same cluster reuses the role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    CREATE ROLE nexora_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

CREATE TABLE tenant (
  tenant_id uuid PRIMARY KEY,
  name text NOT NULL,
  home_region text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  membership_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'controller', 'viewer', 'auditor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, actor_id, role)
);

CREATE TABLE legal_entity (
  legal_entity_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  legal_name text NOT NULL,
  functional_currency char(3) NOT NULL,
  retained_earnings_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account (
  account_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entity (legal_entity_id),
  code text NOT NULL,
  name text NOT NULL,
  report text NOT NULL CHECK (report IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  cash_flow text NOT NULL CHECK (cash_flow IN ('cash', 'cfo', 'cfi', 'cff', 'non_cash', 'distribution')),
  currency char(3) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, legal_entity_id, code)
);

CREATE TABLE accounting_period (
  period_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entity (legal_entity_id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  UNIQUE (tenant_id, legal_entity_id, start_date, end_date)
);

CREATE TABLE journal_entry (
  journal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entity (legal_entity_id),
  period_id uuid NOT NULL REFERENCES accounting_period (period_id),
  status text NOT NULL CHECK (status IN ('draft', 'posted')),
  currency char(3) NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  reverses_journal_id uuid,
  source_ref text,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE journal_line (
  journal_line_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  journal_id uuid NOT NULL REFERENCES journal_entry (journal_id),
  account_id uuid NOT NULL REFERENCES account (account_id),
  line_no integer NOT NULL CHECK (line_no > 0),
  debit_minor numeric(38, 0) NOT NULL,
  credit_minor numeric(38, 0) NOT NULL,
  CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CHECK (NOT (debit_minor > 0 AND credit_minor > 0)),
  CHECK (NOT (debit_minor = 0 AND credit_minor = 0)),
  UNIQUE (journal_id, line_no)
);

CREATE TABLE audit_event (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  occurred_at timestamptz NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE calculation_run (
  calculation_run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  engine_version text NOT NULL,
  input_hash text NOT NULL,
  inputs jsonb NOT NULL,
  outputs jsonb,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE domain_event (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  occurred_at timestamptz NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX ix_membership_tenant_actor ON membership (tenant_id, actor_id);
CREATE INDEX ix_entity_tenant ON legal_entity (tenant_id);
CREATE INDEX ix_account_tenant_entity ON account (tenant_id, legal_entity_id);
CREATE INDEX ix_period_tenant_entity_status ON accounting_period (tenant_id, legal_entity_id, status);
CREATE INDEX ix_journal_tenant_period ON journal_entry (tenant_id, period_id);
CREATE INDEX ix_journal_tenant_entity ON journal_entry (tenant_id, legal_entity_id);
CREATE UNIQUE INDEX journal_one_reversal
  ON journal_entry (tenant_id, reverses_journal_id)
  WHERE reverses_journal_id IS NOT NULL;
CREATE INDEX ix_line_journal ON journal_line (journal_id);
CREATE INDEX ix_audit_aggregate ON audit_event (tenant_id, aggregate_type, aggregate_id);
CREATE INDEX ix_run_tenant_hash ON calculation_run (tenant_id, input_hash);

CREATE OR REPLACE FUNCTION journal_entry_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  debit_total numeric(38, 0);
  credit_total numeric(38, 0);
  line_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'posted' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'posted' THEN
    IF NEW.tenant_id <> OLD.tenant_id
      OR NEW.legal_entity_id <> OLD.legal_entity_id
      OR NEW.period_id <> OLD.period_id
      OR NEW.currency <> OLD.currency
      OR NEW.idempotency_key <> OLD.idempotency_key
      OR NEW.journal_id <> OLD.journal_id
      OR NEW.payload_hash <> OLD.payload_hash
      OR NEW.version <> OLD.version
    THEN
      RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
    END IF;

    SELECT COALESCE(SUM(debit_minor), 0), COALESCE(SUM(credit_minor), 0), COUNT(*)
      INTO debit_total, credit_total, line_count
      FROM journal_line
     WHERE journal_id = NEW.journal_id;

    IF line_count < 2 OR debit_total <> credit_total THEN
      RAISE EXCEPTION 'FIN_UNBALANCED_JOURNAL';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entry_guard
BEFORE INSERT OR UPDATE OR DELETE ON journal_entry
FOR EACH ROW EXECUTE FUNCTION journal_entry_guard();

CREATE OR REPLACE FUNCTION journal_line_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_tenant uuid;
  target_journal uuid;
BEGIN
  target_journal := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_id ELSE NEW.journal_id END;

  SELECT status, tenant_id
    INTO parent_status, parent_tenant
    FROM journal_entry
   WHERE journal_id = target_journal;

  IF TG_OP = 'DELETE' THEN
    IF parent_status IS DISTINCT FROM 'draft' OR parent_tenant IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
    END IF;
    RETURN OLD;
  END IF;

  IF parent_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'TENANT_ISOLATION';
  END IF;

  IF parent_status IS DISTINCT FROM 'draft' OR TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON journal_line
FOR EACH ROW EXECUTE FUNCTION journal_line_guard();

CREATE OR REPLACE FUNCTION period_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' THEN
    RAISE EXCEPTION 'FIN_PERIOD_CLOSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER period_guard
BEFORE UPDATE OR DELETE ON accounting_period
FOR EACH ROW EXECUTE FUNCTION period_guard();

CREATE OR REPLACE FUNCTION append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
END;
$$;

CREATE TRIGGER audit_event_append_only
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER calculation_run_append_only
BEFORE UPDATE OR DELETE ON calculation_run
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER domain_event_append_only
BEFORE UPDATE OR DELETE ON domain_event
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity FORCE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;
ALTER TABLE accounting_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_period FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_line FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE calculation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE calculation_run FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_event FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON membership
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON legal_entity
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON account
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON accounting_period
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON journal_entry
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON journal_line
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON audit_event
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON calculation_run
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

CREATE POLICY tenant_isolation ON domain_event
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

GRANT USAGE ON SCHEMA public TO nexora_app;
GRANT SELECT, INSERT, UPDATE ON
  tenant,
  membership,
  legal_entity,
  account,
  accounting_period,
  journal_entry
TO nexora_app;
GRANT SELECT, INSERT ON
  journal_line,
  audit_event,
  calculation_run,
  domain_event
TO nexora_app;
GRANT nexora_app TO CURRENT_USER;
