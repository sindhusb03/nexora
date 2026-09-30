-- Identity for signed sessions. These are platform tables, not tenant business
-- tables: a user exists before any membership, and a session can exist before a
-- tenant is selected. Tenant scope still comes from membership rows under RLS.
-- The app role can create users and sessions, select a tenant on its own
-- session, and revoke it. It cannot delete either table or change a password hash.

CREATE TABLE auth_user (
  actor_id text PRIMARY KEY CHECK (actor_id ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  disabled boolean NOT NULL DEFAULT false
);

CREATE TABLE auth_session (
  session_id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES auth_user (actor_id),
  tenant_id uuid REFERENCES tenant (tenant_id),
  region text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX ix_auth_session_actor ON auth_session (actor_id);

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
  THEN
    RAISE EXCEPTION 'FIN_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auth_session_guard
BEFORE UPDATE OR DELETE ON auth_session
FOR EACH ROW EXECUTE FUNCTION auth_session_guard();

GRANT SELECT, INSERT ON auth_user, auth_session TO nexora_app;
GRANT UPDATE (tenant_id, revoked_at) ON auth_session TO nexora_app;
