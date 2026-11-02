# ERPatio Development Plan

## Current state (as of 2026-11-02)
- Scaffold only: docker-compose (SQL Server 2022, Redis, backend, frontend), Dockerfile, requirements.txt.
- Backend API files (`auth.py`, `users.py`, `finance.py`) are empty; `main.py` is a stub.
- No `frontend/` folder exists yet, though docker-compose references it.
- Docs: Step1 (folder structure), Step2 (IAM + GL schema design).

## Known issues to fix first
1. `alembic/` contains `app/` — per Step1, `app/` should be a sibling of `alembic/` under `backend/`.
2. docker-compose runs `uvicorn main:app` but the app lives at `app/main.py` → should be `app.main:app`.
3. SA password is hardcoded in docker-compose → move to `.env` (gitignored), add `.env.example`.
4. Add `.gitignore` (.env, __pycache__, node_modules, .next).
5. Repo has two remotes (GitHub + GitLab) and a local `master` with no commits vs. remote `main` → pick one canonical branch.

## Phases

### Phase 0 — Foundation (week 1)
- Fix issues above; get `docker compose up` booting db + redis + backend with a `/health` endpoint.
- `core/config.py` (pydantic-settings), `core/database.py` (async SQLAlchemy + aioodbc).
- Alembic configured against SQL Server; first empty migration runs.
- CI: GitHub Actions running lint (ruff), tests (pytest), and `docker build`.

### Phase 1 — IAM (week 2)
- Models: `users`, `roles`, `user_roles`.
- JWT auth (login, refresh), password hashing (argon2/bcrypt), RBAC dependency (`require_role("Accountant")`).
- Endpoints: `/auth/login`, `/users` CRUD. Seed Admin user.
- Tests: auth flow, role enforcement.

### Phase 2 — Finance / General Ledger (weeks 3–4)
- Models: `accounts` (chart of accounts), `journal_entries`, `journal_entry_lines`.
- Rule enforced in service layer AND DB: total debits = total credits per entry; posted entries immutable (reversal instead of edit).
- Endpoints: accounts CRUD, post journal entry, trial balance report.
- Tests: balanced/unbalanced entries, concurrency on posting.

### Phase 3 — Frontend shell (weeks 5–6)
- Next.js (TypeScript) app: login, layout with role-based nav, accounts and journal entry screens.
- Generated API client from FastAPI OpenAPI schema.

### Phase 4 — Supply Chain & Inventory (weeks 7–9)
- Items, warehouses, stock ledger, purchase orders, sales orders, goods receipt/issue.
- Post inventory movements to GL (integration with Phase 2).

### Phase 5 — Manufacturing (weeks 10–12)
- BOM, routings, work orders, material consumption → inventory + GL.

### Phase 6 — HCM (weeks 13–14)
- Employees, shifts, payroll runs → GL postings.

### Phase 7 — BI & hardening (weeks 15–16)
- Dashboards (P&L, balance sheet, stock levels), Redis caching, audit log, backups, load tests.

## Working conventions
- One module = models → schemas → service → router → tests → migration.
- Every PR: migration + tests + updated docs in `Documentation/`.
- Track phases as GitHub milestones and tasks as issues.

## Next action
Phase 0, item 1–3: restructure `backend/`, fix compose command, move secrets to `.env`.
