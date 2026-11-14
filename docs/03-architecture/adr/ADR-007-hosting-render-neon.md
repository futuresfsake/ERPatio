# ADR-007: Hosting on Render and Neon

- **Status:** Accepted · **Date:** 2026-11-13 · **Closes:** Gap G-06 (hosting), partly G-11, G-22

## Decision
- **One Render web service** runs the Express API **and serves the built React app** from the same
  origin. No CORS in production and the refresh cookie is first-party (`HttpOnly; Secure; SameSite=Strict`).
- **Neon** hosts PostgreSQL. Runtime uses the **pooled** connection string (PgBouncer, transaction
  mode: no session state, which is why RLS context uses `SET LOCAL` inside a transaction).
  Migrations use the **direct** string (`DATABASE_URL_DIRECT`).
- Infrastructure is declared in `render.yaml` (Blueprint). Secrets are `sync: false` and entered in the Render dashboard.
- Migrations run in the start command (`npm run migrate && node dist/server.js`) because
  pre-deploy commands are not available on the free plan.
- Neon provides encryption at rest, point-in-time restore and branching; this satisfies
  FR-SEC-09 for v1 (evidence in the audit).

## Rate limiting (amends ADR-004)
In-memory per-IP limiter on unauthenticated routes, valid for **one instance**. Per-account lockout
is stored in Postgres and holds across instances. Move counters to Redis/Valkey before scaling out.

## Consequences
− Free Render instances sleep when idle (first request is slow). Acceptable for a demo; use a paid instance for pilots.
− Single region and single instance until NFR-04 (99.5%) is required.
− Data location: choose the Neon region closest to PH customers (Singapore) when creating the project (G-11).
