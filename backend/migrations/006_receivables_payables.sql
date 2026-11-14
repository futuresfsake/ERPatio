-- Up Migration

-- Which ledger accounts the receivables and payables subledgers post to (control accounts).
ALTER TABLE tenant_settings ADD COLUMN ar_account_id uuid;
ALTER TABLE tenant_settings ADD COLUMN ap_account_id uuid;
ALTER TABLE tenant_settings ADD FOREIGN KEY (tenant_id, ar_account_id) REFERENCES accounts (tenant_id, id);
ALTER TABLE tenant_settings ADD FOREIGN KEY (tenant_id, ap_account_id) REFERENCES accounts (tenant_id, id);

-- Customers and suppliers. The tax identification number is stored encrypted (ADR-005).
CREATE TABLE parties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind varchar(10) NOT NULL CHECK (kind IN ('customer', 'supplier')),
  code varchar(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9.-]{1,20}$'),
  name varchar(200) NOT NULL,
  email varchar(254),
  phone varchar(40),
  tin_enc text,
  terms_days smallint NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 365),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, code)
);

-- Tax codes (US-045). The account is where the tax is posted.
CREATE TABLE tax_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code varchar(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9.-]{1,20}$'),
  name varchar(100) NOT NULL,
  rate numeric(7,4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  kind varchar(10) NOT NULL CHECK (kind IN ('output', 'input')),
  account_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);

-- Gapless document numbers per kind, assigned at posting (US-046, BRU-FIN-2).
CREATE TABLE doc_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind varchar(10) NOT NULL CHECK (kind IN ('invoice', 'bill')),
  seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, kind)
);

-- Customer invoices and supplier bills. Mutable while a draft; the ledger entry they create never changes.
CREATE TABLE documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind varchar(10) NOT NULL CHECK (kind IN ('invoice', 'bill')),
  doc_no bigint,
  party_id uuid NOT NULL,
  doc_date date NOT NULL,
  due_date date NOT NULL,
  reference varchar(100),
  notes varchar(500),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  subtotal numeric(19,4) NOT NULL DEFAULT 0,
  tax_total numeric(19,4) NOT NULL DEFAULT 0,
  total numeric(19,4) NOT NULL DEFAULT 0,
  paid_total numeric(19,4) NOT NULL DEFAULT 0,
  journal_entry_id uuid,
  void_entry_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, doc_no),
  CHECK (due_date >= doc_date),
  CHECK (paid_total >= 0 AND paid_total <= total),
  CHECK (status = 'draft' OR doc_no IS NOT NULL),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, void_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX ix_documents_party ON documents (tenant_id, party_id, status);
CREATE INDEX ix_documents_date ON documents (tenant_id, kind, doc_date DESC);

CREATE TABLE document_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  line_no smallint NOT NULL,
  description varchar(300) NOT NULL,
  account_id uuid NOT NULL,
  quantity numeric(19,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(19,4) NOT NULL CHECK (unit_price >= 0),
  tax_code_id uuid,
  net numeric(19,4) NOT NULL DEFAULT 0,
  tax numeric(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id), UNIQUE (document_id, line_no),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_codes (tenant_id, id)
);

-- Receipts and payments. Posted once, never edited.
CREATE TABLE payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind varchar(10) NOT NULL CHECK (kind IN ('receipt', 'payment')),
  party_id uuid NOT NULL,
  pay_date date NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  method varchar(20) NOT NULL DEFAULT 'bank',
  bank_account_id uuid NOT NULL,
  reference varchar(100),
  journal_entry_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE payment_allocations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  payment_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (id), UNIQUE (payment_id, document_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);
CREATE INDEX ix_allocations_document ON payment_allocations (tenant_id, document_id);

-- A payment is exactly the sum of its allocations, checked at COMMIT (defence in depth).
CREATE FUNCTION assert_payment_allocated() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE pid uuid; amt numeric; allocated numeric;
   BEGIN
     IF TG_TABLE_NAME = 'payments' THEN pid := NEW.id; ELSE pid := NEW.payment_id; END IF;
     SELECT amount INTO amt FROM payments WHERE id = pid;
     SELECT COALESCE(sum(amount), 0) INTO allocated FROM payment_allocations WHERE payment_id = pid;
     IF amt IS DISTINCT FROM allocated THEN
       RAISE EXCEPTION 'payment % is not fully allocated: % of %', pid, allocated, amt USING ERRCODE = '23514';
     END IF;
     RETURN NULL;
   END $$;
CREATE CONSTRAINT TRIGGER payments_allocated AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_payment_allocated();
CREATE CONSTRAINT TRIGGER allocations_allocated AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_payment_allocated();
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION block_mutation();
CREATE TRIGGER allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION block_mutation();

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parties USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_codes USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE doc_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doc_counters USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_allocations USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON parties, tax_codes, doc_counters, documents TO erpatio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_lines TO erpatio_app;
GRANT DELETE ON documents TO erpatio_app; -- drafts only; the service refuses anything else
GRANT SELECT, INSERT ON payments, payment_allocations TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS payment_allocations, payments, document_lines, documents, doc_counters, tax_codes, parties CASCADE;
DROP FUNCTION IF EXISTS assert_payment_allocated();
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS ap_account_id;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS ar_account_id;
