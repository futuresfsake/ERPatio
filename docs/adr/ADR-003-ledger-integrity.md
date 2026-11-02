# ADR-003: Ledger integrity — immutable postings, single-transaction integration

- **Status:** Proposed · **Date:** 2026-11-02

## Decision
1. Posted journal entries and stock movements are **append-only**; corrections are reversing entries.
2. Σdebits = Σcredits enforced in the service layer **and** by a DB constraint/trigger.
3. A business event (e.g. goods receipt) and its GL posting commit in **one DB transaction**.
4. Money = `DECIMAL(19,4)` / Python `Decimal`.
5. Nightly job reconciles inventory subledger to GL control accounts and alerts on variance.

## Consequences
Slightly more complex corrections UX; strong audit story (BR-02, BR-03).
