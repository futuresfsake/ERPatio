-- Up Migration

-- Two-factor sign-in, erasure marker, password-change time (FR-AUT-04, FR-PRV-06).
ALTER TABLE users ADD COLUMN totp_secret_enc text;
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_last_step bigint;
ALTER TABLE users ADD COLUMN totp_recovery_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN erased_at timestamptz;

-- Roles that must use 2FA in this workspace (FR-AUT-04). Empty = not enforced.
ALTER TABLE tenant_settings ADD COLUMN mfa_required_roles text[] NOT NULL DEFAULT '{}';

-- Envelope encryption (ADR-005): one data key per tenant, wrapped by the master key held outside the database.
CREATE TABLE tenant_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version integer NOT NULL,
  wrapped_key text NOT NULL,
  master_kid varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- One-time e-mail tokens: address verification and password reset. Only the SHA-256 is stored.
CREATE TABLE email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  purpose varchar(10) NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_email_tokens_user ON email_tokens (user_id, purpose);

-- Consent records with version and time (FR-PRV-04).
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind varchar(30) NOT NULL,
  version varchar(20) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip inet,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX ix_consents_user ON consents (user_id);

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_keys USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE email_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_tokens USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consents USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT ON tenant_keys, consents TO erpatio_app;
GRANT UPDATE (ip) ON consents TO erpatio_app; -- erasure clears the address
GRANT SELECT, INSERT, UPDATE, DELETE ON email_tokens TO erpatio_app;

-- Erasure (FR-PRV-06): the audit log stays append-only, with ONE exception. While app.erasure is on, the
-- only change allowed is clearing the ip column; every other column must be identical.
CREATE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
     IF TG_OP = 'UPDATE'
        AND current_setting('app.erasure', true) = 'on'
        AND NEW.ip IS NULL AND OLD.ip IS NOT NULL
        AND (to_jsonb(NEW) - 'ip') = (to_jsonb(OLD) - 'ip') THEN
       RETURN NEW;
     END IF;
     RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
   END $$;
DROP TRIGGER audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
GRANT UPDATE (ip) ON audit_log TO erpatio_app;

-- Down Migration

REVOKE UPDATE (ip) ON audit_log FROM erpatio_app;
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
DROP FUNCTION IF EXISTS audit_log_guard();
DROP TABLE IF EXISTS consents, email_tokens, tenant_keys CASCADE;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS mfa_required_roles;
ALTER TABLE users DROP COLUMN IF EXISTS erased_at;
ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at;
ALTER TABLE users DROP COLUMN IF EXISTS totp_recovery_hashes;
ALTER TABLE users DROP COLUMN IF EXISTS totp_last_step;
ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled;
ALTER TABLE users DROP COLUMN IF EXISTS totp_secret_enc;
