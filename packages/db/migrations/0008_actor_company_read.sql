-- Actor-scoped company list. A signed-in person can have no tenant selected
-- and still needs to see the companies they belong to. These policies are
-- FOR SELECT only. They add no grants and no write path.
--
-- tenant_isolation is unchanged. When app.tenant_id is set, that policy is
-- the only one that matches, so a tenant-scoped transaction still sees that
-- tenant's rows and no others. When app.tenant_id is null, the actor policies
-- match membership.actor_id and the tenant rows those memberships point at.
-- app_actor_id() is NULLIF(app.actor_id), so an empty actor sees nothing.
--
-- membership.status is active, suspended, or left. Existing rows default to
-- active. The actor-scoped policies hide suspended and left seats. A
-- tenant-scoped read still returns those rows, because tenant_isolation does
-- not look at status.

ALTER TABLE membership
  ADD COLUMN status text NOT NULL DEFAULT 'active';

ALTER TABLE membership
  ADD CONSTRAINT membership_status_check
  CHECK (status IN ('active', 'suspended', 'left'));

CREATE POLICY actor_read ON membership
  FOR SELECT
  USING (
    app_tenant_id() IS NULL
    AND actor_id = app_actor_id()
    AND status = 'active'
  );

CREATE POLICY actor_read ON tenant
  FOR SELECT
  USING (
    app_tenant_id() IS NULL
    AND EXISTS (
      SELECT 1
      FROM membership
      WHERE membership.tenant_id = tenant.tenant_id
        AND membership.actor_id = app_actor_id()
        AND membership.status = 'active'
    )
  );
