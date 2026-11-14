-- Up Migration

-- Per-tenant settings (FR-FIN-05: approval is optional).
CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  require_approval boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fiscal periods (FR-FIN-06/07): calendar months, open or closed.
CREATE TABLE fiscal_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  year smallint NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, year, month),
  CHECK (end_date >= start_date),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users (tenant_id, id)
);

-- Who posted and who approved (BRU-FIN-3). Existing columns are untouched: the table stays append-only.
ALTER TABLE journal_entries ADD COLUMN posted_by uuid;
ALTER TABLE journal_entries ADD COLUMN approved_by uuid;
ALTER TABLE journal_entries ADD CONSTRAINT fk_journal_entries_posted_by
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id);
ALTER TABLE journal_entries ADD CONSTRAINT fk_journal_entries_approved_by
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id);

-- The ledger refuses an entry dated outside an open period. The service checks first for a friendly
-- message; this trigger is the guarantee (ADR-003, defence in depth).
CREATE FUNCTION assert_period_open() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE st text;
   BEGIN
     SELECT status INTO st FROM fiscal_periods
      WHERE tenant_id = NEW.tenant_id AND NEW.entry_date BETWEEN start_date AND end_date;
     IF st IS NULL THEN
       RAISE EXCEPTION 'no fiscal period covers %', NEW.entry_date USING ERRCODE = '23514';
     END IF;
     IF st <> 'open' THEN
       RAISE EXCEPTION 'the fiscal period for % is closed', NEW.entry_date USING ERRCODE = '23514';
     END IF;
     RETURN NEW;
   END $$;

CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- Drafts are mutable work in progress and live apart from the ledger, which never changes (ADR-009).
CREATE TABLE journal_drafts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entry_date date NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  reference varchar(100),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  rejection_note varchar(300),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX ix_journal_drafts_tenant_status ON journal_drafts (tenant_id, status, updated_at DESC);

CREATE TABLE journal_draft_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  draft_id uuid NOT NULL,
  line_no smallint NOT NULL,
  account_id uuid NOT NULL,
  debit numeric(19,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  PRIMARY KEY (id),
  UNIQUE (draft_id, line_no),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES journal_drafts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_settings USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_periods USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE journal_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_drafts USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE journal_draft_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_draft_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_draft_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON tenant_settings, fiscal_periods TO erpatio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_drafts, journal_draft_lines TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS journal_draft_lines, journal_drafts CASCADE;
DROP TRIGGER IF EXISTS journal_entries_period_open ON journal_entries;
DROP FUNCTION IF EXISTS assert_period_open();
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS fk_journal_entries_approved_by;
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS fk_journal_entries_posted_by;
ALTER TABLE journal_entries DROP COLUMN IF EXISTS approved_by;
ALTER TABLE journal_entries DROP COLUMN IF EXISTS posted_by;
DROP TABLE IF EXISTS fiscal_periods, tenant_settings CASCADE;
