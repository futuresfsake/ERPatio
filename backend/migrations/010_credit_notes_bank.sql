-- Up Migration

-- ---- Credit notes (customers) and debit notes (suppliers) share the document engine.
ALTER TABLE documents ALTER COLUMN kind TYPE varchar(12);
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK (kind IN ('invoice', 'bill', 'credit_note', 'debit_note'));
ALTER TABLE doc_counters ALTER COLUMN kind TYPE varchar(12);
ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN ('invoice', 'bill', 'po', 'so', 'credit_note', 'debit_note'));
INSERT INTO doc_counters (tenant_id, kind) SELECT t.id, k.kind FROM tenants t CROSS JOIN (VALUES ('credit_note'), ('debit_note')) k(kind) ON CONFLICT DO NOTHING;

-- A posted credit or debit note is used up against open invoices or bills. Append-only; documents carry the running totals.
CREATE TABLE credit_applications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  note_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  applied_on date NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id),
  CHECK (note_id <> document_id),
  FOREIGN KEY (tenant_id, note_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX ix_credit_app_doc ON credit_applications (tenant_id, document_id);
CREATE INDEX ix_credit_app_note ON credit_applications (tenant_id, note_id);
CREATE TRIGGER credit_applications_append_only BEFORE UPDATE OR DELETE ON credit_applications FOR EACH ROW EXECUTE FUNCTION block_mutation();
ALTER TABLE credit_applications ENABLE ROW LEVEL SECURITY; ALTER TABLE credit_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_applications USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON credit_applications TO erpatio_app;

-- ---- Bank reconciliation: statement lines are matched one to one with ledger lines of the bank account.
CREATE TABLE bank_statement_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  line_date date NOT NULL,
  description varchar(300) NOT NULL,
  reference varchar(100),
  amount numeric(19,4) NOT NULL CHECK (amount <> 0), -- positive: money in, negative: money out
  fingerprint char(64) NOT NULL,
  imported_by uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, account_id, fingerprint),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, imported_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX ix_bank_lines_account ON bank_statement_lines (tenant_id, account_id, line_date);
CREATE TRIGGER bank_statement_lines_append_only BEFORE UPDATE OR DELETE ON bank_statement_lines FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE TABLE bank_matches (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  statement_line_id uuid NOT NULL,
  journal_line_id uuid NOT NULL,
  matched_by uuid NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, statement_line_id),
  UNIQUE (tenant_id, journal_line_id),
  FOREIGN KEY (tenant_id, statement_line_id) REFERENCES bank_statement_lines (tenant_id, id),
  FOREIGN KEY (matched_by) REFERENCES users (id)
);
ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE bank_statement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_statement_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE bank_matches ENABLE ROW LEVEL SECURITY; ALTER TABLE bank_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_matches USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON bank_statement_lines TO erpatio_app;
GRANT SELECT, INSERT, DELETE ON bank_matches TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS bank_matches, bank_statement_lines, credit_applications CASCADE;
DELETE FROM doc_counters WHERE kind IN ('credit_note', 'debit_note');
