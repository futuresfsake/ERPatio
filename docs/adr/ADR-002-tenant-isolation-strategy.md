# ADR-002: Shared schema with `tenant_id` + Row-Level Security

- **Status:** Proposed · **Date:** 2026-11-02

## Context
Need cheap, scalable isolation for many small tenants, with an upgrade path.

## Options
| Option | Isolation | Cost | Ops |
|---|---|---|---|
| DB per tenant | Strongest | High | Heavy (migrations × N) |
| Schema per tenant | Strong | Medium | Medium–heavy |
| **Shared schema + tenant_id + RLS** | Good (with RLS) | Low | Light |

## Decision
Shared schema; every table has `tenant_id`; SQL Server `SESSION_CONTEXT('tenant_id')` set per request; security policy filters/blocks predicates. Large tenants may move to a dedicated DB later (FR-TEN-13).

## Consequences
- Every query path must set the session context (middleware + test).
- Unique constraints include `tenant_id`.
- Cache keys, file paths, and logs include tenant id.
- Automated cross-tenant tests are mandatory (DoD).
