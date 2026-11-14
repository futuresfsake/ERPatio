# ADR-009: Drafts, fiscal periods and approval, with an append-only ledger

- **Status:** Accepted · **Date:** 2026-11-14 · **Builds on:** [ADR-003](ADR-003-ledger-integrity.md)

## Context
FR-FIN-05/06/07 need drafts that can be edited, an optional approval step, and months that can be closed. ADR-003 requires posted entries to be immutable, enforced by triggers that block every UPDATE and DELETE on the ledger tables. A draft status column on `journal_entries` would force those triggers open.

## Decision
1. **Drafts live in their own tables** (`journal_drafts`, `journal_draft_lines`), fully mutable. Posting a draft inserts a normal ledger entry and deletes the draft **in one transaction**. The ledger tables keep their append-only triggers; nothing is relaxed.
2. **Fiscal periods are calendar months** (`fiscal_periods`, Jan to Dec per the customer profile). A period is `open` or `closed`. A `BEFORE INSERT` trigger on `journal_entries` rejects an entry dated in a closed period or outside any period. The service maps both to clear 422 errors; the trigger is the guarantee. A reversal is dated today, so a closed month can still be corrected in an open one.
3. **Closing** is refused while drafts are dated in the period (FR-FIN-07). **Reopening** needs a reason, kept in the audit log.
4. **Approval is a per-workspace setting** (`tenant_settings.require_approval`, default off).
   - Off: anyone who can post posts directly or from a draft.
   - On: direct posting returns 409. An author submits a draft; a user with `journal:approve` who is **not the author** approves and posts it, or sends it back with a note. Single level (Gap G-10 recommendation). Reversals are never held.
5. **Recorded on every entry:** `created_by` (author), `posted_by`, and `approved_by` (BRU-FIN-3).
6. **New permissions and role:** `journal:approve`, `periods:manage`, `settings:manage`; system role `FinanceManager` (the customer's finance manager). The public demo role cannot approve, close periods or change settings.
7. **Statements are computed from the ledger on request** (income statement for a range, balance sheet as of a date). Until year-end closing exists, equity shows **earnings to date, cumulative**; the balance sheet still balances.

## Consequences
+ The ledger's guarantees are unchanged and still tested by writing to it directly.
+ Approval, closing and reporting are testable against the real database.
− Year-end closing entries, retained earnings roll-forward and comparative periods are not built (US-040 is partial).
− A closed period stops *new* entries only; it cannot protect against a mistaken entry already posted (that is what reversal is for).
− The demo cannot show approval or closing to visitors, by design (ADR-008); both are covered by tests.

## Alternatives rejected
A `status` column on journal entries with the triggers relaxed (breaks ADR-003). Soft-deleting drafts inside the ledger tables (clutters the ledger and every report query). Multi-level approval (no customer need yet).
