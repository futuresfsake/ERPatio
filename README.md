# ERPatio

A multi-tenant ERP for small trading companies. Double-entry books where an entry cannot go out of balance, a ledger that cannot be edited, and a company's data kept apart from every other company's by the database itself.

**Status:** early. Milestone M0 (foundation, security, sign-in) is in progress; a general-ledger slice is already usable. See the [DoD audit](docs/07-quality/audit-dod.md) for exactly what is done and what is not.

## Live demo
**Not deployed yet.** The link will go here once the Render and Neon setup in the [runbook](docs/06-operations/deployment-render-neon.md) is done.

| | |
|---|---|
| Workspace | `casa-verde-demo` |
| Email | `demo@erpatio.app` |
| Password | `ERPatio-Demo-2026` |

Synthetic data only, capped at 100 entries, reset nightly. The credentials are public on purpose ([ADR-008](docs/03-architecture/adr/ADR-008-public-demo-workspace.md)).
You can try the interface now without any server: open [`docs/03-architecture/design/prototype/erpatio-prototype.html`](docs/03-architecture/design/prototype/erpatio-prototype.html) in a browser.

## What works today
- Self-service sign-up with e-mail confirmation (off until a mail provider is set), password reset, two-factor sign-in (mandatory for administrators), a session list, and your own data export.
- Sign in with workspace, email and password; rotating refresh tokens with theft detection; lock-out after 5 failures.
- Administration: invite people, assign roles, custom roles, module subscriptions; erase a person without changing the books.
- A platform operator console: suspend workspaces, switch modules, and open an audited, read-only support session.
- General ledger: chart of accounts; balanced entries; drafts with optional approval (nobody approves their own entry); reversal, never edit; fiscal periods you can close and lock; trial balance, income statement and balance sheet with CSV export; audit log.
- Role-based access, enforced on every route and checked again at startup.
- Row-Level Security on every tenant table, tested by trying to read and write another tenant's rows.

## Stack
| Layer | Choice |
|---|---|
| Web | React 19, TypeScript, Vite, React Router, TanStack Query |
| API | Node.js 22, Express 5, TypeScript, zod |
| Database | PostgreSQL 17 (Neon in production), plain SQL migrations |
| Hosting | Render (one web service serves the API and the built web app) |
| Tests | Vitest + Supertest against a real PostgreSQL |

Why this stack: [ADR-006](docs/03-architecture/adr/ADR-006-technology-stack.md). How it is hosted: [ADR-007](docs/03-architecture/adr/ADR-007-hosting-render-neon.md).

## Run it locally
Needs Node 22 and Docker (for the database).
```bash
docker compose up -d db
cd backend
cp .env.example .env          # set DATABASE_URL and DATABASE_URL_DIRECT to the compose database
npm ci && npm run migrate && npm run seed:demo
npm run dev                   # API on :8000
# in a second terminal
cd frontend && npm ci && npm run dev   # app on :5173, /api is proxied to :8000
```
Run the checks: `npm run lint && npm run typecheck && npm test` in `backend/` and in `frontend/`. Backend tests need a PostgreSQL; set `TEST_DATABASE_URL` (see `backend/tests/config.ts`).

## Repository map
```
backend/    Express API, migrations, seed and test suites
frontend/   React app and the design system (src/styles.css)
docs/       Product, requirements, architecture, delivery, governance, operations, quality
render.yaml Render Blueprint
```
Start with [docs/README.md](docs/README.md). The user journeys are in [appflow.md](docs/03-architecture/appflow.md).

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). No licence has been chosen yet (open question G-15); until then all rights are reserved.
