-- Workspace records for proposals, documents, flags, and time-boxed support.
-- These rows are not posted journals. Financial totals stay in the kernel.

CREATE TABLE workspace_record (
  workspace_record_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  kind text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX ix_workspace_record_tenant_kind ON workspace_record (tenant_id, kind);

ALTER TABLE workspace_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_record FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workspace_record
  USING (tenant_id::text = app_tenant_id())
  WITH CHECK (tenant_id::text = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_record TO nexora_app;

-- Support access removes the temporary membership it created when the window ends.
GRANT DELETE ON membership TO nexora_app;
