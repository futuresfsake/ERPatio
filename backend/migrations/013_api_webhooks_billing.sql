-- Up Migration

-- ---- Plans and usage. Plans are platform reference data (no tenant), read-only to the application.
CREATE TABLE plans (
  code varchar(20) PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{2,20}$'),
  name varchar(60) NOT NULL,
  max_users integer CHECK (max_users IS NULL OR max_users > 0),
  max_entries_per_month integer CHECK (max_entries_per_month IS NULL OR max_entries_per_month > 0),
  price_monthly numeric(12,2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0)
);
INSERT INTO plans (code, name, max_users, max_entries_per_month, price_monthly) VALUES
  ('trial', 'Trial', 5, 500, 0), ('standard', 'Standard', 25, 20000, 3500), ('enterprise', 'Enterprise', NULL, NULL, 0);
GRANT SELECT ON plans TO erpatio_app;
ALTER TABLE tenants ADD COLUMN plan_code varchar(20) NOT NULL DEFAULT 'standard' REFERENCES plans(code);

-- Journal entries per calendar month, counted as they are posted (the same counter row lock that numbers the entry serialises it).
CREATE TABLE usage_monthly (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  entries integer NOT NULL DEFAULT 0 CHECK (entries >= 0),
  PRIMARY KEY (tenant_id, month)
);
INSERT INTO usage_monthly (tenant_id, month, entries)
SELECT tenant_id, date_trunc('month', created_at)::date, count(*) FROM journal_entries GROUP BY 1, 2;
ALTER TABLE usage_monthly ENABLE ROW LEVEL SECURITY; ALTER TABLE usage_monthly FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_monthly USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON usage_monthly TO erpatio_app;

-- ---- API keys. Only a hash is stored; the key itself is shown once, at creation.
CREATE TABLE api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name varchar(80) NOT NULL,
  key_prefix varchar(16) NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  permissions text[] NOT NULL,
  rate_limit_per_min integer NOT NULL DEFAULT 300 CHECK (rate_limit_per_min BETWEEN 10 AND 6000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (id), UNIQUE (tenant_id, id),
  CHECK (cardinality(permissions) > 0),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY; ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON api_keys TO erpatio_app;

-- ---- Webhooks. Events are written to an outbox in the same transaction as the change, so none is lost and none is sent for a rolled-back change.
CREATE TABLE webhook_endpoints (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  url varchar(500) NOT NULL,
  secret_enc text NOT NULL,
  events text[] NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_reason varchar(100),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id),
  CHECK (cardinality(events) > 0),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TABLE webhook_deliveries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  endpoint_id uuid NOT NULL,
  event varchar(60) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_webhook_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ix_webhook_endpoint ON webhook_deliveries (tenant_id, endpoint_id, created_at DESC);
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoints USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON webhook_endpoints, webhook_deliveries TO erpatio_app;
GRANT DELETE ON webhook_endpoints TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS webhook_deliveries, webhook_endpoints, api_keys, usage_monthly CASCADE;
ALTER TABLE tenants DROP COLUMN IF EXISTS plan_code;
DROP TABLE IF EXISTS plans;
