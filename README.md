# ERPatio

A multi-tenant ERP for small trading companies. Double-entry books where an entry cannot go out of balance, a ledger that cannot be edited, and a company's data kept apart from every other company's by the database itself.

**Status:** every milestone from M0 to M7 is built and tested on a real PostgreSQL, but **nothing has been deployed or used with real data**, and payroll must not be used for real pay until an accountant confirms its rates. See the [DoD audit](docs/07-quality/audit-dod.md) for exactly what is done and what is not, and [pilot readiness](docs/06-operations/pilot-readiness.md) for what must happen before a pilot.

## Live demo
**Not deployed yet.** The link will go here once the Render and Neon setup in the [runbook](docs/06-operations/deployment-render-neon.md) is done.

| | |
|---|---|
| Workspace | `casa-verde-demo` |
| Email | `demo@erpatio.app` |
| Password | `ERPatio-Demo-2026` |

Synthetic data only: the books, receivables and payables, stock, a production run and one paid payroll, capped at 100 entries and reset nightly. The credentials are public on purpose ([ADR-008](docs/03-architecture/adr/ADR-008-public-demo-workspace.md)).
You can try the interface now without any server: open [`docs/03-architecture/design/prototype/erpatio-prototype.html`](docs/03-architecture/design/prototype/erpatio-prototype.html) in a browser.

## What works today
- **Books:** chart of accounts, balanced entries that cannot be edited (reverse instead), drafts with optional approval (nobody approves their own entry), fiscal periods you close and lock, year-end close into retained earnings, trial balance, income statement and balance sheet with CSV export, audit log.
- **Receivables and payables:** customers and suppliers, invoices, bills, credit and debit notes, receipts and payments with allocation and void, tax codes and a tax report, aging that agrees with the ledger, bank statement import and reconciliation, printable documents.
- **Supply chain:** items, an append-only stock ledger, purchase and sales orders with receiving and delivery, moving-average costing, returns, three-way match (bill from receipt), invoice from delivery, reorder levels, stock valuation that equals the inventory account to the cent.
- **Production:** versioned bills of materials with loop checks, work orders, materials to work in progress, output at actual cost, close short, work in progress that equals the ledger.
- **People and payroll:** employees with encrypted pay and identifiers, shifts and attendance, statutory rates as editable data, payroll runs approved by a second person, posted to the ledger and frozen, payment, erasure of a former employee.
- **Insight and data:** executive and inventory dashboards, profitability, all-or-nothing CSV import, full workspace export.
- **Platform:** API keys with their own limits, signed webhooks from a transactional outbox, plans with enforced user and monthly-entry limits and usage metering, an operator console with audited read-only support sessions, custom roles, module subscriptions.
- **Security and privacy:** self-service sign-up with e-mail confirmation (off until a mail provider is set), two-factor sign-in (mandatory for administrators), rotating refresh tokens with theft detection, field-level encryption, data-subject export and erasure, retention, default-deny routes checked against a generated authorization matrix, row-level security on every tenant table.

Not built, and said plainly in the audit: multi-currency, 13th-month pay and leave and loans, locations and lots, payment collection, MRP, a mobile app.

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
Run the checks: `npm run lint && npm run typecheck && npm test` in `backend/` and in `frontend/`. More: `node scripts/break-it.mjs` (break the critical rules and confirm the tests notice), `npx tsx scripts/perf-check.ts` and `bash scripts/restore-drill.sh` (scratch databases only), and `e2e/` (a browser smoke test of every screen). The backend tests include automated attack simulations (cross-company access, token forgery, injection, ledger tampering); see [security testing](docs/03-architecture/security-testing.md). Backend tests need a PostgreSQL; set `TEST_DATABASE_URL` (see `backend/tests/config.ts`).

## Repository map
```
backend/    Express API, migrations, seed, test suites and the hardening scripts
frontend/   React app and the design system (src/styles.css)
e2e/        Browser smoke test (Playwright core)
docs/       Product, requirements, architecture, delivery, governance, operations, quality
render.yaml Render Blueprint
```
Start with [docs/README.md](docs/README.md). The user journeys are in [appflow.md](docs/03-architecture/appflow.md).

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). No licence has been chosen yet (open question G-15); until then all rights are reserved.
