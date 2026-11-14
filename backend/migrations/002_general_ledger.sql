-- Up Migration

CREATE TABLE accounts (
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL REFERENCES tenants(id),
         code varchar(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9.-]{1,20}$'),
         name varchar(200) NOT NULL,
         type varchar(20) NOT NULL
           CHECK (type IN ('asset','liability','equity','revenue','expense')),
         is_active boolean NOT NULL DEFAULT true,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, code));

CREATE TABLE journal_entries (
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL REFERENCES tenants(id),
         entry_no bigint NOT NULL,
         entry_date date NOT NULL,
         description varchar(500) NOT NULL,
         reference varchar(100),
         reverses_entry_id uuid,
         created_by uuid NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, entry_no),
         FOREIGN KEY (tenant_id, reverses_entry_id) REFERENCES journal_entries (tenant_id, id),
         FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id));

CREATE UNIQUE INDEX ux_journal_entries_reversal
         ON journal_entries (tenant_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE journal_lines (
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL REFERENCES tenants(id),
         entry_id uuid NOT NULL,
         line_no smallint NOT NULL,
         account_id uuid NOT NULL,
         debit numeric(19,4) NOT NULL DEFAULT 0,
         credit numeric(19,4) NOT NULL DEFAULT 0,
         memo text,
         PRIMARY KEY (id), UNIQUE (entry_id, line_no),
         CONSTRAINT ck_journal_lines_one_sided
           CHECK (debit >= 0 AND credit >= 0 AND ((debit = 0) <> (credit = 0))),
         FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries (tenant_id, id),
         FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id));

CREATE INDEX ix_journal_lines_account ON journal_lines (tenant_id, account_id);

CREATE INDEX ix_journal_entries_date ON journal_entries (tenant_id, entry_date DESC, entry_no DESC);

CREATE FUNCTION assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS
       $$ DECLARE eid uuid; d numeric; c numeric; n integer;
          BEGIN
            IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
            SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
              INTO d, c, n FROM journal_lines WHERE entry_id = eid;
            IF n < 2 THEN
              RAISE EXCEPTION 'journal entry % needs at least two lines', eid USING ERRCODE = '23514';
            END IF;
            IF d <> c THEN
              RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', eid, d, c
                USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
          END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
       FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
       FOR EACH ROW EXECUTE FUNCTION block_mutation();

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON accounts USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON journal_entries USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON journal_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON accounts TO erpatio_app;

GRANT SELECT, INSERT ON journal_entries, journal_lines TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS journal_lines, journal_entries, accounts CASCADE;
DROP FUNCTION IF EXISTS assert_entry_balanced();
