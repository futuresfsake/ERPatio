-- Up Migration

-- Module subscriptions per tenant (FR-TEN-05, US-021). Finance is on by default; the rest are switched on by the platform operator.
CREATE TABLE tenant_modules (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  module varchar(30) NOT NULL CHECK (module IN ('finance', 'supply_chain', 'production', 'hcm', 'bi')),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module)
);

-- Back-fill existing tenants before row-level security is switched on for the table.
INSERT INTO tenant_modules (tenant_id, module, enabled)
SELECT t.id, v.m, v.m = 'finance' FROM tenants t CROSS JOIN (VALUES ('finance'), ('supply_chain'), ('production'), ('hcm'), ('bi')) v(m);

ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_modules USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
-- Tenants can read their own subscription; only the platform operator (owner connection) changes it.
GRANT SELECT ON tenant_modules TO erpatio_app;

-- Administration of people and roles (US-016, US-017, US-024).
ALTER TABLE roles ADD COLUMN description varchar(200);
GRANT INSERT ON users TO erpatio_app;
GRANT INSERT, UPDATE, DELETE ON roles, role_permissions, user_roles TO erpatio_app;

-- Down Migration

REVOKE INSERT, UPDATE, DELETE ON roles, role_permissions, user_roles FROM erpatio_app;
REVOKE INSERT ON users FROM erpatio_app;
ALTER TABLE roles DROP COLUMN IF EXISTS description;
DROP TABLE IF EXISTS tenant_modules CASCADE;
