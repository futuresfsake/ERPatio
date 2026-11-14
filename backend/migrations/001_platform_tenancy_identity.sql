-- The erpatio_app role is cluster-wide and is intentionally never dropped by a downgrade.
-- Up Migration

DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erpatio_app') THEN
           CREATE ROLE erpatio_app NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;

GRANT erpatio_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO erpatio_app;

CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
       $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         slug varchar(40) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
         name varchar(200) NOT NULL,
         status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
         is_demo boolean NOT NULL DEFAULT false,
         base_currency char(3) NOT NULL DEFAULT 'PHP',
         created_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant());

GRANT SELECT ON tenants TO erpatio_app;

CREATE FUNCTION resolve_tenant(p_slug text)
       RETURNS TABLE (id uuid, status text) LANGUAGE sql STABLE SECURITY DEFINER
       SET search_path = public AS
       $$ SELECT t.id, t.status::text FROM tenants t WHERE t.slug = lower(p_slug) $$;

REVOKE ALL ON FUNCTION resolve_tenant(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_tenant(text) TO erpatio_app;

CREATE TABLE users (
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL REFERENCES tenants(id),
         email varchar(254) NOT NULL,
         full_name varchar(200) NOT NULL,
         password_hash text NOT NULL,
         is_active boolean NOT NULL DEFAULT true,
         email_verified boolean NOT NULL DEFAULT false,
         failed_attempts integer NOT NULL DEFAULT 0,
         locked_until timestamptz,
         last_login_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (id),
         UNIQUE (tenant_id, id));

CREATE UNIQUE INDEX ux_users_tenant_email ON users (tenant_id, lower(email));

CREATE TABLE roles (
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL REFERENCES tenants(id),
         name varchar(60) NOT NULL,
         is_system boolean NOT NULL DEFAULT false,
         PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, name));

CREATE TABLE role_permissions (
         role_id uuid NOT NULL,
         permission varchar(60) NOT NULL,
         tenant_id uuid NOT NULL,
         PRIMARY KEY (role_id, permission),
         FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE);

CREATE TABLE user_roles (
         user_id uuid NOT NULL,
         role_id uuid NOT NULL,
         tenant_id uuid NOT NULL,
         PRIMARY KEY (user_id, role_id),
         FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
         FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE);

CREATE TABLE refresh_tokens (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL,
         user_id uuid NOT NULL,
         family_id uuid NOT NULL,
         token_hash varchar(64) NOT NULL UNIQUE,
         expires_at timestamptz NOT NULL,
         revoked_at timestamptz,
         replaced_by uuid,
         ip inet,
         user_agent varchar(300),
         created_at timestamptz NOT NULL DEFAULT now(),
         FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE);

CREATE INDEX ix_refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE audit_log (
         id bigserial PRIMARY KEY,
         tenant_id uuid NOT NULL REFERENCES tenants(id),
         occurred_at timestamptz NOT NULL DEFAULT now(),
         actor_user_id uuid,
         action varchar(60) NOT NULL,
         entity_type varchar(40),
         entity_id varchar(64),
         ip inet,
         detail jsonb NOT NULL DEFAULT '{}'::jsonb);

CREATE INDEX ix_audit_log_tenant_time ON audit_log (tenant_id, occurred_at DESC);

CREATE TABLE tenant_counters (
         tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
         journal_seq bigint NOT NULL DEFAULT 0);

CREATE FUNCTION block_mutation() RETURNS trigger LANGUAGE plpgsql AS
       $$ BEGIN
            RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
              USING ERRCODE = '42501';
          END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
       FOR EACH ROW EXECUTE FUNCTION block_mutation();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE roles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON roles USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON role_permissions USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON user_roles USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON refresh_tokens USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_log USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_counters USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, UPDATE ON users TO erpatio_app;

GRANT SELECT ON roles, role_permissions, user_roles TO erpatio_app;

GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO erpatio_app;

GRANT SELECT, INSERT ON audit_log TO erpatio_app;

GRANT USAGE ON SEQUENCE audit_log_id_seq TO erpatio_app;

GRANT SELECT, UPDATE ON tenant_counters TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS tenant_counters, audit_log, refresh_tokens, user_roles, role_permissions, roles, users, tenants CASCADE;
DROP FUNCTION IF EXISTS resolve_tenant(text);
DROP FUNCTION IF EXISTS block_mutation();
DROP FUNCTION IF EXISTS app_tenant();
