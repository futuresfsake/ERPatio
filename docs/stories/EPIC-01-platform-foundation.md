# EPIC-01 — Platform Foundation (Milestone M0)

Points: Fibonacci. Format: *As a … I want … so that …* with Given/When/Then.

### US-001 Bootable dev environment · 3 pts · Must
As a developer I want `docker compose up` to start db, redis, backend and frontend so that I can work in a consistent environment.
- **Given** a fresh clone and `.env` copied from `.env.example` **When** I run compose **Then** `GET /health` returns 200 and the UI loads on :3000.
- Traces: NFR-17

### US-002 Repository structure fixed · 2 pts · Must
As a developer I want `backend/app/...` as sibling of `backend/alembic` so that imports and migrations work.
- **Then** `uvicorn app.main:app` starts; `alembic upgrade head` succeeds.

### US-003 Secrets out of the repo · 2 pts · Must
As a security-minded owner I want credentials in `.env` (gitignored) so that no secret is committed.
- **Then** CI secret scan passes; `.env.example` documents all variables. Traces: NFR-08

### US-004 Async DB session & config · 3 pts · Must
As a developer I want pydantic-settings config and an async SQLAlchemy session so that endpoints share one DB pattern.

### US-005 Migrations pipeline · 3 pts · Must
As a developer I want Alembic wired to SQL Server so that schema changes are versioned. Traces: NFR-16

### US-006 CI pipeline · 5 pts · Must
As a team I want GitHub Actions to run ruff, pytest and docker build on each PR so that main stays green.

### US-007 Structured logging & health/ready probes · 3 pts · Should
As an operator I want JSON logs with request id and tenant id so that I can trace issues. Traces: NFR-15

### US-008 Error model & API conventions · 2 pts · Should
As an API consumer I want consistent error bodies, pagination and versioning so that clients are predictable. Traces: FR-API-01
