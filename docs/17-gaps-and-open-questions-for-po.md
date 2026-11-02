# 17 — Gaps & Open Questions for the Product Owner

The BA raises these because requirements cannot be finalised without a decision. **Blocking** = stories cannot enter a sprint until answered.

| ID | Gap / question | Impact | Blocking? | BA recommendation | Needed by | Decision |
|---|---|---|---|---|---|---|
| G-01 | Confirm **SaaS multi-tenant** as the delivery model (vs PaaS / self-host) | Architecture, pricing | **Yes** | SaaS (ADR-001) | M0 start | _open_ |
| G-02 | **SQL Server licensing cost** in production. Keep it, or switch to PostgreSQL? | Cost, RLS approach | **Yes** | Keep SQL Server for now (stated stack); evaluate Azure SQL; re-check before beta | M1 | _open_ |
| G-03 | Target market/country — PH only, or multi-country? | Tax, payroll, currency | **Yes** | PH first, keep rules configurable | M2 | _open_ |
| G-04 | Pricing model: per module, per user, or tiers? | US-099 scope | No | Per-module + per-user | M6 | _open_ |
| G-05 | Is a **real pilot customer** available, or stay with the simulated CVTC? | Validation | No | Find 1 friendly SME by M2 | M2 | _open_ |
| G-06 | Who hosts and operates production (us on cloud X)? Which cloud? | Ops, cost | **Yes** | Single cloud, managed containers | M3 | _open_ |
| G-07 | Payroll legal scope: ship statutory rules, or only a configurable engine? | Liability | **Yes** (for M5) | Engine + sample rules, disclaimer, accountant review | M5 | _open_ |
| G-08 | Costing: weighted average only for v1? FIFO needed? | US-064 | No | WAvg v1 | M3 | _open_ |
| G-09 | Lot/serial/expiry tracking needed for any target customer? | FR-SCM-13 | No | Defer | M3 | _open_ |
| G-10 | Approval workflow depth (single vs multi-level)? | US-038 | No | Single level | M2 | _open_ |
| G-11 | Data residency / hosting region requirements? | NFR-12 | No | PH/SEA region | M3 | _open_ |
| G-12 | SSO (OIDC/SAML) required for first customers? | FR-IAM-12 | No | Defer | M1 | _open_ |
| G-13 | Support model and SLA (hours, channels)? | NFR-04 | No | Email, business hours, 99.5% | M6 | _open_ |
| G-14 | Mobile: responsive web enough, or native app? | FR-BI-07 | No | Responsive web | M6 | _open_ |
| G-15 | Open-source licence for the repo (or proprietary)? | Legal | No | Decide before public visibility | M0 | _open_ |
| G-16 | Is the repo public or private? Docs contain simulated data only | Visibility | No | Private until G-15 | M0 | _open_ |
| G-17 | Accounting standard (PFRS for SMEs vs simplified)? | CoA template, reports | No | Simplified template | M2 | _open_ |
| G-18 | Multi-company (several legal entities per tenant) / consolidation? | Data model | **Yes** (model impact) | Decide now; retrofit is costly | M2 | _open_ |
| G-19 | Language: English only? | NFR-18 | No | English v1 | M6 | _open_ |
| G-20 | Budget and team size assumptions (3 devs?) | Roadmap dates | No | Validate | M0 | _open_ |

## Assumptions recorded
See [18 Risks & Assumptions](18-risks-and-assumptions.md).
