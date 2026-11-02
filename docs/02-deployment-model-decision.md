# 02 — Decision: SaaS vs PaaS vs On-Prem

**Status:** Proposed (needs PO sign-off) · **ADR ref:** ADR-001

## Options
| Model | Who runs it | Customer gets | Fit for ERPatio |
|---|---|---|---|
| **SaaS** | We host, operate, upgrade | Finished application in browser | ✅ Best fit |
| PaaS | We provide a platform to build on | Runtime/tools to build *their own* apps | ❌ Customers want an ERP, not a toolkit |
| IaaS | We rent raw infrastructure | VMs/storage | ❌ Not our business |
| On-prem / self-host | Customer runs it | Installable package | ⚠️ Possible later as enterprise tier |

## Recommendation: SaaS (multi-tenant), with a PaaS-flavoured extension layer later
**Why SaaS**
1. Target buyers have no IT team to run SQL Server + Redis + containers.
2. ERP value is in finished business processes (GL, stock, payroll), not a dev platform.
3. Recurring subscription revenue; one codebase, one upgrade path.
4. Our stack (FastAPI + Next.js + SQL Server + Redis in Docker) already suits a hosted service.

**Why not PaaS (yet):** PaaS means selling a platform others build apps on. We can grow into it by exposing a public API, webhooks and custom fields (Phase 2 of product), but v1 sells a ready ERP.

## Tenancy approach (see ADR-002)
Shared database, shared schema, `tenant_id` on every row, enforced with SQL Server Row-Level Security. Upgrade path to dedicated DB per tenant for large customers.

## Pricing model (hypothesis — PO to validate)
Per-module, per-active-user monthly subscription; free 30-day trial tenant.

## Consequences
- Need tenant provisioning, billing, usage metering, tenant-aware auth (see [13](13-multi-tenancy-and-saas-requirements.md)).
- Need ops: backups, monitoring, SLA, support process.
