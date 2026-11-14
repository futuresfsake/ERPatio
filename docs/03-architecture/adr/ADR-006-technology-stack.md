# ADR-006: Technology stack — Express + React (TypeScript) on PostgreSQL

- **Status:** Accepted · **Date:** 2026-11-13 · **Deciders:** Product owner
- **Supersedes:** the stack in the README and assumption A-02 (Next.js, FastAPI, SQL Server, Redis); closes Gap G-02.
- **Amends:** ADR-002 (RLS mechanism), ADR-004 (rate-limit store).

## Context
The original stack was chosen before a hosting target existed. The product owner now requires
**Express.js and React with TypeScript**, deployed on **Render** with **Neon** (managed PostgreSQL).
SQL Server cannot run on Neon, and its licence cost was already risk R-04.

## Decision
| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) end to end | One language; shared types for API contracts |
| Backend | Node.js 22 LTS, **Express 5** | `helmet`, `cors`, `express-rate-limit`, `pino` logging |
| Validation | **zod** | Every request body/query parsed; OpenAPI generated from the schemas |
| Database access | `pg` (node-postgres), parameterised SQL only | No string-built SQL; small repository layer |
| Migrations | `node-pg-migrate` with plain `.sql` files | Reversible; triggers/RLS stay readable |
| Auth | `argon2` (argon2id), `jose` (JWT, `kid` rotation) | As ADR-004 |
| Frontend | **React 19 + Vite + TypeScript**, React Router, TanStack Query | SPA; no SSR need for an authenticated ERP |
| Database | **PostgreSQL 17 on Neon** | Pooled URL for runtime, direct URL for migrations |
| Tests | Vitest, Supertest, real Postgres (no DB mocks) | Cross-tenant and ledger tests run against RLS |
| CI | GitHub Actions | lint, typecheck, test, audit, secret scan, build |
| Cache / queue | **None in v1** | Redis deferred; see ADR-007 for rate limiting |

## Tenant isolation (amends ADR-002)
Shared schema with `tenant_id` and **PostgreSQL Row-Level Security**. Each request runs in one
transaction that executes `SET LOCAL ROLE erpatio_app` (a role without `BYPASSRLS`) and
`set_config('app.tenant_id', …, true)`. Policies are `FORCE`d. Composite foreign keys
`(tenant_id, id)` make cross-tenant references impossible at the schema level.

## Consequences
+ Runs on Render + Neon with no licence cost; one language for the whole team.
+ Postgres features (RLS, deferred constraint triggers, `numeric`) map directly onto ADR-003.
− SQL Server specifics in docs 12, 13, 22 and EPIC-02 are replaced (done in this change).
− Express is unopinionated: structure, validation and error handling are our conventions
  (see `docs/03-architecture/design/backend-structure.md`).
− Neon scale-to-zero adds a cold start (about 1 s) on the first request after idle.

## Alternatives rejected
Keep FastAPI (rejected by PO); NestJS (heavier than needed, PO asked for Express); Next.js
(SSR adds a second server for no benefit behind a login); Prisma/Drizzle ORM (RLS session
variables and triggers are clearer with explicit SQL; revisit at M2).
