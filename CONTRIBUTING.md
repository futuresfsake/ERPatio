# Contributing to ERPatio

## Workflow
1. Pick a story from `docs/04-delivery/stories/` that is *Ready* (see `docs/04-delivery/20-definition-of-done.md`).
2. Branch: `feat/US-033-balanced-entry`. `main` is deployable; never push to it directly.
3. Small commits using Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
4. Open a PR that references the story ID and FR IDs; fill in the PR template.
5. CI must be green (lint, types, tests against PostgreSQL, build, dependency audit, secret scan, CodeQL); at least one review.

## Rules
- No secrets in commits. Configuration comes from the environment; `backend/.env.example` lists every variable.
- Money is a decimal string on the wire and `bigint` units in code. Never a JavaScript number.
- Declare routes only with `route()` and a guard. A route without a declared permission fails the build and the boot.
- Every query runs inside `withTenant()`. Build SQL with parameters, never with template strings (ESLint enforces this).
- Every new table has `tenant_id`, row-level security, a composite foreign key to its parents, an entry in `backend/src/db/classification.ts`, a down migration and a cross-tenant test.
- No personal data in logs, URLs or cache keys. Test data is synthetic.
- Security changes need a test that attacks them first; see `docs/03-architecture/security-testing.md`. Never point `TEST_DATABASE_URL` at a real database.
- Update docs and the traceability matrix when scope changes; record decisions as an ADR.
- UI changes follow `docs/03-architecture/design/ui-design-system.md` (palette, type, 2px radius, no shadows, no emoji).
