-- Up Migration

-- Year-end closing: the closing entry is flagged so the income statement can leave it out.
ALTER TABLE journal_entries ADD COLUMN closing_year smallint;
CREATE UNIQUE INDEX uq_closing_year ON journal_entries (tenant_id, closing_year) WHERE closing_year IS NOT NULL;

-- Where closed-year profit or loss is carried.
ALTER TABLE tenant_settings ADD COLUMN re_account_id uuid;
ALTER TABLE tenant_settings ADD FOREIGN KEY (tenant_id, re_account_id) REFERENCES accounts (tenant_id, id);
UPDATE tenant_settings s SET re_account_id = (SELECT a.id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '3100');

-- A payment is never edited. Undoing one adds a row here and a reversing journal entry; documents get their balance back.
CREATE TABLE payment_voids (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  payment_id uuid NOT NULL,
  void_date date NOT NULL,
  journal_entry_id uuid NOT NULL,
  voided_by uuid NOT NULL,
  voided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, payment_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER payment_voids_append_only BEFORE UPDATE OR DELETE ON payment_voids FOR EACH ROW EXECUTE FUNCTION block_mutation();
ALTER TABLE payment_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_voids USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON payment_voids TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS payment_voids;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS re_account_id;
DROP INDEX IF EXISTS uq_closing_year;
ALTER TABLE journal_entries DROP COLUMN IF EXISTS closing_year;
