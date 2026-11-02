# 18 — Risks & Assumptions

## Assumptions
| ID | Assumption |
|---|---|
| A-01 | Customer persona (CVTC) is representative of the target SME |
| A-02 | Stack is fixed: Next.js, FastAPI, SQL Server, Redis, Docker |
| A-03 | Team of ~3 developers + 1 QA; PO/BA part-time |
| A-04 | Single base currency per tenant in v1 |
| A-05 | Online-only; no offline mode |
| A-06 | English UI, PHP/USD |

## Risks
Score = Likelihood (1–5) × Impact (1–5).

| ID | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R-01 | ERP scope too large for team | 5 | 5 | 25 | MVP cut (M0–M3); modules as add-ons | PO |
| R-02 | Cross-tenant data leak | 2 | 5 | 10 | RLS + automated leak tests + pen-test | Dev lead |
| R-03 | Inventory/GL drift | 3 | 5 | 15 | Single-transaction postings; nightly reconciliation job | Dev |
| R-04 | SQL Server production cost | 4 | 3 | 12 | Gap G-02; Azure SQL or revisit DB | PO |
| R-05 | Payroll legal errors | 3 | 5 | 15 | Configurable rules, effective dating, accountant review | BA/HR SME |
| R-06 | Requirements built on a simulated customer | 4 | 4 | 16 | Early friendly pilot (G-05); validate stories | BA |
| R-07 | Performance of ledger reports at scale | 3 | 3 | 9 | Indexes, summary tables, Redis cache | Dev |
| R-08 | Data loss | 2 | 5 | 10 | Backups, restore drills | DevOps |
| R-09 | Migration/upgrade breaks tenants | 3 | 4 | 12 | Backward-compatible migrations, staged rollout | DevOps |
| R-10 | Security debt from hardcoded secrets (present in current compose file) | 5 | 3 | 15 | US-003 immediately | Dev |
| R-12 | Personal-data breach or non-compliance | 3 | 5 | 15 | M0 privacy scope, field encryption, breach runbook, legal review (G-21) | PO |
| R-13 | M0 too large, delays first usable feature | 4 | 3 | 12 | Sequence inside M0; defer Shoulds; show demo of auth early | PO |
| R-14 | Lost encryption key makes data unrecoverable | 2 | 5 | 10 | KMS, key backup, recovery drill (US-108) | DevOps |
| R-11 | Key-person dependency (single maintainer) | 4 | 3 | 12 | Documentation, ADRs, automation | PO |
