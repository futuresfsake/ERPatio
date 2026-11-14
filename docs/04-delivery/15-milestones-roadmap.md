# 15 — Milestones & Roadmap (v0.2)

**Change from v0.1:** M0 now covers foundation **and** security, authentication and data privacy. Nothing storing business data is built before these exist. Authentication moved out of the old M1; user/role administration stays in M1.

Assumes ≈3 devs, 1 QA, part-time PO/BA, 2-week sprints. Dates are targets, not commitments.

| Milestone | Theme | Scope | Points | Sprints | Target | Exit criteria |
|---|---|---|---|---|---|---|
| **M0** Foundation, Security, AuthN & Data Privacy | Safe base for everything | EPIC-01 (US-001–008) · EPIC-06 (US-100–125) · from EPIC-02: US-010, 011–015, 018, 019, 020, 023 | ≈ 150 | 1–4 | 2027-01-22 | See M0 gate below |
| **M1** Access Management & Tenant Admin | Users, roles, modules | US-016, 017, 021, 022, 024 (+ US-031 seed template) | ≈ 24 | 5–6 | 2027-02-19 | Admin manages users/roles; module flags enforced |
| **M2** General Ledger | CoA, journals, periods, AP/AR, reports | EPIC-03 | ≈ 100 | 7–9 | 2027-03-26 | Trial balance ties; unbalanced entry impossible |
| **M3** Supply Chain | Items, stock ledger, PO/SO, costing | EPIC-04 | ≈ 98 | 10–13 | 2027-05-21 | Inventory = GL, 0 variance |
| **M4** Production | BOM, work orders, WIP | US-070–077 | ≈ 44 | 14–15 | 2027-06-18 | Work order moves stock + GL |
| **M5** HCM | Employees, shifts, payroll | US-080–089 | ≈ 57 | 16–17 | 2027-07-16 | Locked payroll posts to GL; PII encrypted |
| **M6** BI & Platform | Dashboards, import/export, API, billing | US-090–099 | ≈ 62 | 18–20 | 2027-08-27 | Tenant self-onboards in < 1 day |
| **M7** Hardening & Pilot | Pen-test, load test, pilot | — | — | 21–22 | 2027-09-24 | Pilot criteria (doc 03) met |

## M0 internal sequence
1. **Foundation** — US-001–008 (environment, structure, secrets, DB, migrations, CI, logging)
2. **Pipeline security** — US-104, 105, 106, 100 (scanners and threat model in place early)
3. **Authentication** — US-010–015, 120–124, 023
4. **Authorisation & tenancy** — US-018, 019, 020 (default-deny guard, RLS, audit log)
5. **Transport & data protection** — US-101, 102, 103, 107, 108, 109
6. **Data privacy** — US-110–119, 125

## M0 gate (all must pass to close M0)
- [ ] Threat model reviewed; every threat has a mitigation story done or scheduled
- [ ] Sign-up, email verification, login, refresh rotation, lockout, reset, 2FA work end to end
- [ ] Default-deny test: no route without a declared permission
- [ ] Cross-tenant leak test passes on all endpoints
- [ ] Secret, SAST, dependency and image scans are required CI checks and green
- [ ] DB encrypted at rest; restore drill from encrypted backup succeeded
- [ ] PII register generated; Sensitive-Personal fields encrypted; logs contain no PII
- [ ] Data-subject export and erasure/anonymisation demonstrated on synthetic data
- [ ] Breach runbook walked through (tabletop)
- [ ] Open Gaps G-01, G-02, G-15, G-21, G-22 answered by the PO

## MVP cut (sellable earliest)
M0 + M1 + M2 + M3-core (items, stock ledger, PO receipt, delivery). Production and HCM follow as paid add-on modules.

## Release plan
- **Alpha** (end M2): internal + simulated data · **Beta** (end M3): 1–2 friendly tenants · **GA** (end M7)

## Capacity warning
M0 is ≈ 150 points against an estimated 35–40 points/sprint. It is deliberately front-loaded; if capacity is lower, defer US-106, 108, 116, 121, 122, 125 (all Should) rather than the Musts. See Gap G-20.

See [16 Dependencies](16-dependency-map.md).

## Status on 2026-11-14 (branch `feat/m0-foundation-neon-render`)
M0 is **in progress, not closed**. Built and tested: foundation, login, refresh rotation, lock-out, default-deny, Row-Level Security, audit log, PII register, log masking. Also built ahead of M2 as a vertical slice: chart of accounts, balanced posting, reversal, drafts with optional approval, fiscal periods with close and lock, trial balance, income statement and balance sheet (see [ADR-009](../03-architecture/adr/ADR-009-drafts-periods-and-approval.md)). Open M0 items (sign-up, e-mail verification, password reset, 2FA, field encryption, DSAR/erasure, breach runbook, restore drill, threat-model sign-off) are listed in the [DoD audit](../07-quality/audit-dod.md).
