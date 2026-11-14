# ADR-002: Shared schema with `tenant_id` + Row-Level Security

- **Status:** Accepted (2026-11-13), amended by [ADR-006](ADR-006-technology-stack.md) · **Date:** 2026-11-02

## Context
Need cheap, scalable isolation for many small tenants, with an upgrade path.

## Options
| Option | Isolation | Cost | Ops |
|---|---|---|---|
| DB per tenant | Strongest | High | Heavy (migrations × N) |
| Schema per tenant | Strong | Medium | Medium–heavy |
| **Shared schema + tenant_id + RLS** | Good (with RLS) | Low | Light |

## Decision
Shared schema; every table has `tenant_id`; PostgreSQL `set_config('app.tenant_id', …, true)` inside each request's transaction, plus `SET LOCAL ROLE erpatio_app` (no BYPASSRLS); `FORCE`d row-level security policies filter and block on `tenant_id`. (Originally written for SQL Server `SESSION_CONTEXT`; see ADR-006.) Large tenants may move to a dedicated DB later (FR-TEN-13).

## Consequences
- Every query path must set the session context (middleware + test).
- Unique constraints include `tenant_id`.
- Cache keys, file paths, and logs include tenant id.
- Automated cross-tenant tests are mandatory (DoD).
