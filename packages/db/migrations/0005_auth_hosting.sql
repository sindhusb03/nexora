-- Sign-in factors, session rotation, and the auth audit log.
-- auth_user and auth_session stay platform tables: a person exists before any
-- membership. The auth audit log is different. It is append-only, forced RLS
-- applies, and nexora_app can insert only while app.auth_maintenance is on.
-- Reads are the session actor, or the selected tenant when the API has checked
-- an owner or auditor role and set app.auth_audit_tenant.

ALTER TABLE auth_user ADD COLUMN email text;

ALTER TABLE auth_user
  ADD CONSTRAINT auth_user_email_format CHECK (
    email IS NULL OR email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
  );

CREATE UNIQUE INDEX auth_user_email_lower ON auth_user (lower(email));

ALTER TABLE auth_session
  ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN rotated_from uuid;

CREATE INDEX ix_auth_session_family ON auth_session (family_id);

CREATE OR REPLACE FUNCTION auth_session_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'AUTH_SESSION_REVOKED';
  END IF;
  IF NEW.session_id <> OLD.session_id
    OR NEW.actor_id <> OLD.actor_id
    OR NEW.region <> OLD.region
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.family_id IS DISTINCT FROM OLD.family_id
    OR NEW.rotated_from IS DISTINCT FROM OLD.rotated_from
  THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_actor_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_auth_maintenance()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.auth_maintenance', true) = 'on'
$$;

CREATE TABLE auth_audit_event (
  event_id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'login_success',
    'login_failure',
    'magic_link_sent',
    'magic_link_used',
    'totp_enroll',
    'totp_verify',
    'session_revoke',
    'role_change'
  )),
  occurred_at timestamptz NOT NULL,
  actor_id text,
  tenant_id uuid,
  request_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  payload jsonb NOT NULL,
  CHECK (actor_id IS NULL OR actor_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$')
);

CREATE INDEX ix_auth_audit_actor ON auth_audit_event (actor_id, occurred_at);
CREATE INDEX ix_auth_audit_tenant ON auth_audit_event (tenant_id, occurred_at);

CREATE TRIGGER auth_audit_append_only
BEFORE UPDATE OR DELETE ON auth_audit_event
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE auth_audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_audit_event FORCE ROW LEVEL SECURITY;

CREATE POLICY auth_audit_read ON auth_audit_event
  FOR SELECT
  USING (
    app_auth_maintenance()
    OR actor_id = app_actor_id()
    OR (
      tenant_id IS NOT NULL
      AND tenant_id::text = app_tenant_id()
      AND current_setting('app.auth_audit_tenant', true) = 'on'
    )
  );

CREATE POLICY auth_audit_insert ON auth_audit_event
  FOR INSERT
  WITH CHECK (app_auth_maintenance());

CREATE TABLE auth_magic_link (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL REFERENCES auth_user (actor_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX ix_auth_magic_actor ON auth_magic_link (actor_id);

CREATE OR REPLACE FUNCTION auth_magic_link_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF NEW.token_hash <> OLD.token_hash
    OR NEW.actor_id <> OLD.actor_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.used_at IS NULL
  THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_magic_link_guard
BEFORE UPDATE OR DELETE ON auth_magic_link
FOR EACH ROW EXECUTE FUNCTION auth_magic_link_guard();

CREATE TABLE auth_totp (
  actor_id text PRIMARY KEY REFERENCES auth_user (actor_id),
  secret_cipher text NOT NULL,
  created_at timestamptz NOT NULL,
  enabled_at timestamptz,
  last_accepted_step bigint
);

CREATE OR REPLACE FUNCTION auth_totp_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF NEW.actor_id <> OLD.actor_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF OLD.enabled_at IS NOT NULL AND NEW.enabled_at IS NOT NULL AND (
    NEW.secret_cipher IS DISTINCT FROM OLD.secret_cipher
    OR NEW.enabled_at IS DISTINCT FROM OLD.enabled_at
  ) THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF NEW.last_accepted_step IS NOT NULL AND OLD.last_accepted_step IS NOT NULL
    AND NEW.last_accepted_step < OLD.last_accepted_step THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_totp_guard
BEFORE UPDATE OR DELETE ON auth_totp
FOR EACH ROW EXECUTE FUNCTION auth_totp_guard();

CREATE TABLE auth_recovery_code (
  actor_id text NOT NULL REFERENCES auth_user (actor_id),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  used_at timestamptz,
  PRIMARY KEY (actor_id, code_hash)
);

CREATE OR REPLACE FUNCTION auth_recovery_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF OLD.used_at IS NOT NULL
    OR NEW.actor_id <> OLD.actor_id
    OR NEW.code_hash <> OLD.code_hash
    OR NEW.used_at IS NULL
  THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_recovery_guard
BEFORE UPDATE OR DELETE ON auth_recovery_code
FOR EACH ROW EXECUTE FUNCTION auth_recovery_guard();

CREATE TABLE auth_lockout (
  subject_hash text PRIMARY KEY CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  failures integer NOT NULL CHECK (failures >= 0),
  window_started_at timestamptz NOT NULL,
  locked_until timestamptz
);

CREATE TABLE auth_mfa_challenge (
  challenge_id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES auth_user (actor_id),
  region text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE OR REPLACE FUNCTION auth_mfa_challenge_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF OLD.used_at IS NOT NULL
    OR NEW.challenge_id <> OLD.challenge_id
    OR NEW.actor_id <> OLD.actor_id
    OR NEW.region <> OLD.region
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.used_at IS NULL
  THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_mfa_challenge_guard
BEFORE UPDATE OR DELETE ON auth_mfa_challenge
FOR EACH ROW EXECUTE FUNCTION auth_mfa_challenge_guard();

CREATE TABLE auth_oidc_link (
  link_id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES auth_user (actor_id),
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE OR REPLACE FUNCTION auth_oidc_link_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
END;
$$;

CREATE TRIGGER auth_oidc_link_guard
BEFORE UPDATE OR DELETE ON auth_oidc_link
FOR EACH ROW EXECUTE FUNCTION auth_oidc_link_guard();

CREATE TABLE auth_oidc_state (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  provider_id text NOT NULL,
  nonce_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE OR REPLACE FUNCTION auth_oidc_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  IF OLD.used_at IS NOT NULL
    OR NEW.state_hash <> OLD.state_hash
    OR NEW.provider_id <> OLD.provider_id
    OR NEW.nonce_hash <> OLD.nonce_hash
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.used_at IS NULL
  THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_oidc_state_guard
BEFORE UPDATE OR DELETE ON auth_oidc_state
FOR EACH ROW EXECUTE FUNCTION auth_oidc_state_guard();

-- Secret and operational auth tables are visible to nexora_app only while the
-- identity transaction has set app.auth_maintenance. A tenant-scoped request
-- does not set that flag, so it cannot read magic links, TOTP secrets, or lockouts.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'auth_magic_link',
    'auth_totp',
    'auth_recovery_code',
    'auth_lockout',
    'auth_mfa_challenge',
    'auth_oidc_link',
    'auth_oidc_state'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY auth_maintenance_all ON %I USING (app_auth_maintenance()) WITH CHECK (app_auth_maintenance())',
      target
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT ON auth_audit_event TO nexora_app;
GRANT SELECT, INSERT ON auth_magic_link TO nexora_app;
GRANT UPDATE (used_at) ON auth_magic_link TO nexora_app;
GRANT SELECT, INSERT ON auth_totp TO nexora_app;
GRANT UPDATE (secret_cipher, enabled_at, last_accepted_step) ON auth_totp TO nexora_app;
GRANT SELECT, INSERT ON auth_recovery_code TO nexora_app;
GRANT UPDATE (used_at) ON auth_recovery_code TO nexora_app;
GRANT SELECT, INSERT, UPDATE ON auth_lockout TO nexora_app;
GRANT SELECT, INSERT ON auth_mfa_challenge TO nexora_app;
GRANT UPDATE (used_at) ON auth_mfa_challenge TO nexora_app;
GRANT SELECT, INSERT ON auth_oidc_link TO nexora_app;
GRANT SELECT, INSERT ON auth_oidc_state TO nexora_app;
GRANT UPDATE (used_at) ON auth_oidc_state TO nexora_app;
