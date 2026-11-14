-- Up Migration

-- Every balance and statement sums journal lines up to a date. Joining each line to its entry just to read the date made those
-- sums scale with the whole ledger. The date and the "closing entry" flag are copied onto the line when it is written (entries
-- never change afterwards, so the copy cannot go stale), and one covering index answers "sum by account up to a date" from the index alone.
ALTER TABLE journal_lines ADD COLUMN entry_date date, ADD COLUMN closing boolean NOT NULL DEFAULT false;

-- The ledger is append-only, so the copy is filled with the protection lifted for this one statement, inside the migration.
ALTER TABLE journal_lines DISABLE TRIGGER USER;
UPDATE journal_lines l SET entry_date = e.entry_date, closing = (e.closing_year IS NOT NULL) FROM journal_entries e WHERE e.id = l.entry_id AND e.tenant_id = l.tenant_id;
ALTER TABLE journal_lines ENABLE TRIGGER USER;
ALTER TABLE journal_lines ALTER COLUMN entry_date SET NOT NULL;

CREATE FUNCTION journal_lines_copy_date() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
     SELECT e.entry_date, (e.closing_year IS NOT NULL) INTO NEW.entry_date, NEW.closing
       FROM journal_entries e WHERE e.id = NEW.entry_id AND e.tenant_id = NEW.tenant_id;
     IF NEW.entry_date IS NULL THEN RAISE EXCEPTION 'journal line has no entry' USING ERRCODE = '23503'; END IF;
     RETURN NEW;
   END $$;
CREATE TRIGGER journal_lines_copy_date BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_copy_date();

CREATE INDEX ix_journal_lines_balance ON journal_lines (tenant_id, account_id, entry_date) INCLUDE (debit, credit);
CREATE INDEX ix_journal_lines_period ON journal_lines (tenant_id, entry_date) INCLUDE (account_id, debit, credit) WHERE NOT closing;

-- Down Migration

DROP INDEX IF EXISTS ix_journal_lines_period;
DROP INDEX IF EXISTS ix_journal_lines_balance;
DROP TRIGGER IF EXISTS journal_lines_copy_date ON journal_lines;
DROP FUNCTION IF EXISTS journal_lines_copy_date();
ALTER TABLE journal_lines DROP COLUMN IF EXISTS closing, DROP COLUMN IF EXISTS entry_date;
