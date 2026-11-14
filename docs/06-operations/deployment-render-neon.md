# Deployment runbook: Render + Neon

Decisions: [ADR-006](../03-architecture/adr/ADR-006-technology-stack.md), [ADR-007](../03-architecture/adr/ADR-007-hosting-render-neon.md), [ADR-008](../03-architecture/adr/ADR-008-public-demo-workspace.md).

## Live demo

| | |
|---|---|
| **URL** | **Not deployed yet.** Nothing is live. The link goes here after step 6 below. |
| Workspace | `casa-verde-demo` |
| Email | `demo@erpatio.app` |
| Password | `ERPatio-Demo-2026` |
| Role | `DemoUser`: post and reverse entries, manage accounts, read the audit log |
| Data | Synthetic. Capped at 100 entries. Reset nightly at 02:00 Manila time |
| Last verified live | not yet |

The credentials are public on purpose (ADR-008). Never load real names, e-mails or money into this workspace.

## One-time setup (about 20 minutes)

Accounts needed: GitHub (repo already there), Neon, Render. Free plans are enough.

1. **Neon project.** Create a project in the **Singapore** region, PostgreSQL 17. Keep the default branch `main`.
   - Copy two connection strings from the Connect dialog: **Pooled** (host has `-pooler`) and **Direct**.
   - The default role is the schema owner and is allowed to create roles. The first migration creates the `erpatio_app` role (no login, no `BYPASSRLS`) that the API drops to for every request.
2. **Seed the demo tenant once** from your machine (needs Node 22):
   ```bash
   cd backend && npm ci
   DATABASE_URL="<direct string>" DATABASE_URL_DIRECT="<direct string>" npm run migrate
   DATABASE_URL="<direct string>" DATABASE_URL_DIRECT="<direct string>" npm run seed:demo
   ```
   Expected last line: `demo tenant 'casa-verde-demo' ready with 14 journal entries`.
3. **Render service.** Dashboard -> New -> Blueprint -> pick this repo. Render reads `render.yaml`.
   - Enter `DATABASE_URL` (pooled) and `DATABASE_URL_DIRECT` (direct) when asked. `JWT_SECRET` is generated for you.
4. **First deploy** runs: build both apps, then `npm run migrate && node dist/server.js`. Wait for `/health` to turn green.
5. **GitHub secret for the nightly reset.** Repo -> Settings -> Secrets and variables -> Actions -> `NEON_DIRECT_URL` = the direct string. Run the workflow "Reset demo workspace" once by hand to confirm it succeeds.
6. **Verify** (all must pass), then paste the Render URL into the table above and into `README.md`:
   - `GET /health` returns `{"status":"ok"}`; `GET /ready` returns `{"status":"ready"}`.
   - Sign in with the demo credentials; Overview shows "Assets equal liabilities plus equity."
   - Browser dev tools: the `erp_refresh` cookie is `HttpOnly`, `Secure`, `SameSite=Strict`.
   - `curl -I <url>` shows `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`.
   - Post an entry, reverse it, open the audit log: both events appear.
   - Do not test lock-out on the demo user. Lock-out is covered by the automated tests; locking the demo account would shut visitors out for 15 minutes.

## Environment variables

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | Render (secret) | Neon **pooled** string |
| `DATABASE_URL_DIRECT` | Render (secret) | Neon **direct** string; migrations and seeding |
| `JWT_SECRET` | Render (generated) | 32+ random characters. Boot fails in production otherwise |
| `JWT_SECRET_PREVIOUS` | Render (during rotation) | Old key still accepted until its tokens expire (15 min) |
| `COOKIE_SECURE`, `TRUST_PROXY`, `NODE_ENV`, `STATIC_DIR`, `DOCS_ENABLED`, `DEMO_MAX_ENTRIES` | `render.yaml` | Non-secret |
| `NEON_DIRECT_URL` | GitHub Actions secret | Nightly demo reset |

## Operations

- **Rotate the JWT key:** set `JWT_SECRET_PREVIOUS` to the current value, change `JWT_SECRET`, deploy. After 15 minutes remove the previous value.
- **Roll back a deploy:** Render -> Events -> pick the previous deploy -> Rollback. Migrations are forward-compatible (FR-TEN-14); a down migration is a manual `npm run migrate:down`.
- **Backups:** Neon offers point-in-time restore; confirm the retention window of your plan in the Neon console and run a restore drill before relying on it (open: audit finding F-09).
- **Cold starts:** a free Render instance sleeps when idle and Neon scales to zero. Expect the first visit after a quiet period to be noticeably slow; measure it after the first deploy.
- **Scale beyond one instance:** first move the per-IP rate limiter to Redis/Valkey (ADR-007).
- **Retire the demo:** set `DOCS_ENABLED=false`, delete the demo tenant with `npm run seed:demo` tooling or SQL as owner, and disable the nightly workflow.

## Data location and sub-processors
See [sub-processors register](sub-processors-and-data-location.md).
