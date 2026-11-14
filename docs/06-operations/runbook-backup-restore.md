# Runbook: backup and restore drill (NFR-05, NFR-06, FR-SEC-09, US-107)

Targets: **RPO 15 minutes, RTO 4 hours** (NFR-05). Neon keeps a continuous history and can restore any point inside the plan's history window into a **new branch**. A backup you have never restored is a hope, not a backup: the drill below must pass before the M0 gate closes.

**Status: the drill has not been run.** Nothing in this repository has been restored from a Neon backup.

## What to confirm first
- The retention window of the Neon plan in use (Console, Project settings, Storage). The 35-day target in NFR-06 needs a plan that offers it; if not, record the actual window here and tell the product owner: ______ days.
- Encryption at rest and in transit are provided by Neon (record the plan's documented statement and date): ______
- Application-level field encryption keys: the **master key is not in the database**. Restoring the database alone is not enough to read encrypted fields; the master key must be restorable too (store it in the operator's secret manager and in a sealed offline copy).

## The drill (about one hour)
1. Note the wall-clock time, then post one recognisable entry in a non-production workspace so there is something to find. Record its number: ______
2. In the Neon console choose **Restore** (or create a branch) at a point 10 minutes earlier **into a new branch**. Do not restore over the production branch.
3. Get the new branch's direct connection string.
4. On a workstation, with that string as `DATABASE_URL_DIRECT`:
   ```bash
   cd backend
   DATABASE_URL_DIRECT="<branch string>" npm run migrate        # should report: No migrations to run
   ```
5. Run the checks in `docs/06-operations/restore-checks.sql` (below) against the branch.
6. Start the API against the branch (`DATABASE_URL` and `DATABASE_URL_DIRECT` pointing at it), sign in to the demo workspace, open the trial balance, and confirm it balances.
7. Delete the branch.
8. Record the result in the table.

## Checks after a restore
```sql
-- every migration applied
SELECT count(*) FROM pgmigrations;                                   -- expect 4 (or more)
-- the ledger rules survived: triggers present
SELECT tgname FROM pg_trigger WHERE tgname IN ('journal_entries_balanced','journal_lines_balanced','journal_entries_append_only','journal_lines_append_only','journal_entries_period_open','audit_log_append_only');  -- expect 6
-- row-level security still forced on every tenant table
SELECT count(*) FROM pg_class WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace;  -- expect 17
-- the books tie out
SELECT sum(debit) = sum(credit) AS balanced FROM journal_lines;       -- expect true
-- no entry without lines
SELECT count(*) FROM journal_entries e WHERE NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id);  -- expect 0
```

## Pass criteria
- [ ] Restored branch created in under 30 minutes
- [ ] All checks above return the expected values
- [ ] The API starts and the trial balance balances
- [ ] The recognisable entry is present or absent exactly as the chosen restore point implies
- [ ] The master key restored encrypted data (decrypt one test field)

## Drill log
| Date | Restore point | Time to a working branch | Checks | Result | Done by |
|---|---|---|---|---|---|
| _not yet run_ | | | | | |
