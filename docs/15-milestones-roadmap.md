# 15 — Milestones & Roadmap

Assumes a small team (≈3 devs, 1 QA, part-time PO/BA), 2-week sprints. Dates are targets, not commitments.

| Milestone | Theme | Epics / stories | Sprints | Target | Exit criteria |
|---|---|---|---|---|---|
| **M0** Foundation | Repo, env, CI | EPIC-01 (US-001–008) | 1 | 2026-11-20 | `docker compose up` green; CI on PRs |
| **M1** Identity & Tenancy | Auth, RBAC, RLS, signup | EPIC-02 (US-010–024) | 2–3 | 2027-01-08 | Cross-tenant leak test passes; audit log live |
| **M2** General Ledger | CoA, journals, periods, AP/AR, reports | EPIC-03 (US-030–047) | 4–6 | 2027-02-19 | Trial balance ties; unbalanced entry impossible |
| **M3** Supply Chain | Items, stock ledger, PO/SO, costing | EPIC-04 (US-050–068) | 7–10 | 2027-04-16 | Inventory = GL reconciliation report = 0 variance |
| **M4** Production | BOM, work orders, WIP | US-070–077 | 11–12 | 2027-05-14 | Work order consumes/produces stock + GL |
| **M5** HCM | Employees, shifts, payroll | US-080–089 | 13–14 | 2027-06-11 | Locked payroll run posts to GL |
| **M6** BI & Platform | Dashboards, import/export, API, billing | US-090–099 | 15–17 | 2027-07-23 | Tenant self-onboard in < 1 day |
| **M7** Hardening & Pilot | Pen-test, load test, CVTC pilot | — | 18–19 | 2027-08-20 | Pilot success criteria (doc 03) met |

## MVP cut (sellable earliest)
M0 + M1 + M2 + M3-core (items, stock ledger, PO receipt, delivery). Production and HCM are paid add-on modules after MVP.

## Release plan
- **Alpha** (end M2): internal + simulated customer data
- **Beta** (end M3): 1–2 friendly tenants
- **GA** (end M7)

See [16 Dependencies](16-dependency-map.md) for ordering constraints.
