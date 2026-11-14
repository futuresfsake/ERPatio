# Definition-of-Done audit: M0 foundation slice

| | |
|---|---|
| **Date** | 2026-11-14 |
| **Audited** | Branch `feat/m0-foundation-neon-render`, cut from `main` at `76aaf45`. **No commits yet:** every change is uncommitted in the working tree (53 stories audited, about 70 new files, 37 moved docs). |
| **Update** | 2026-11-14, second round: fiscal periods with close and lock, drafts with optional approval, income statement and balance sheet were built and are covered below |
| **Compared with** | `origin/main` (docs only: no code existed) |
| **How it was run** | Windows 11, Node 22.14, npm 10.9. PostgreSQL 17.4 on a throwaway local cluster, with an owner role that mimics Neon's (not superuser, `CREATEROLE`, `BYPASSRLS`). No mocks: the tests talk to real PostgreSQL |
| **Not audited** | See the list under the verdict |
| **Definition of Done used** | [`04-delivery/20-definition-of-done.md`](../04-delivery/20-definition-of-done.md), the stories in `04-delivery/stories/` (EPIC-01, the M0 part of EPIC-02, EPIC-06, and the EPIC-03 stories the slice touches), and the M0 gate in [`15-milestones-roadmap.md`](../04-delivery/15-milestones-roadmap.md) |

There is no Jira ticket for this work, so the criteria come from the repo's own stories. Story IDs are used as AC numbers.

## Live demo

| | |
|---|---|
| **URL** | **Not deployed. There is no live link yet.** Nothing in this report was verified on Render or Neon. |
| Workspace / email / password | `casa-verde-demo` / `demo@erpatio.app` / `ERPatio-Demo-2026` (public on purpose, [ADR-008](../03-architecture/adr/ADR-008-public-demo-workspace.md)) |
| What is ready | Blueprint [`render.yaml`](../../render.yaml), the [runbook](../06-operations/deployment-render-neon.md), the seed and nightly-reset scripts, the workflow `.github/workflows/demo-reset.yml` |
| What it needs | Your Neon and Render accounts, a push to GitHub, then runbook steps 1 to 6. The runbook's step 6 lists the checks that turn this row into "verified live" |
| Last verified live | never |

## Verdict

**Approved as the foundation to build on. Not approved for production or for real customer data.** The architecture, the isolation model and the test discipline meet the bar for M0. The product does not: 14 of 56 criteria are not met (3 more by decision), and the M0 gate is open.

Why it is not ready:
1. **Not deployed or reviewed.** No push, no pull request, no CI run, no live URL. The Definition of Done item "reviewed via PR, CI green" is NOT MET.
2. **M0 is incomplete.** Missing: self-service sign-up, e-mail verification, password reset, two-factor sign-in, field-level encryption, data-subject export and erasure, retention, consent, breach runbook, restore drill, threat-model sign-off (F-06, F-07).
3. **The public demo has a known way to lock visitors out** (F-05). Anyone can lock `demo@erpatio.app` for 15 minutes with five wrong passwords. Fix before the link is shared.
4. **Nothing was tried on real Neon** (F-02). The RLS role setup works on a local role that resembles Neon's, not on Neon itself.
5. **Test strength is unproven** (F-12). The required break-it check was not run (see "Not run").

What is solid, with evidence: tenant isolation is enforced by the database and tested by trying to cross it; the ledger cannot be unbalanced or edited, even by SQL written directly; every route must declare a guard, and the server refuses to start otherwise; login does not reveal which accounts exist; refresh-token theft is detected.

**Conditions to move the demo from "approved to build" to "approved to publish":** fix F-05; deploy and pass runbook step 6; CI green on a pull request; choose a licence (G-15, the repo is public).

**Not audited:**
- The live deployment (Render, Neon, TLS, cold starts).
- GitHub Actions: the workflows were written but have never run.
- The real React app beyond its sign-in screen. Screens were reviewed in the HTML prototype (headless Edge screenshots) and the real build was seen at the sign-in page only. No end-to-end browser test exists.
- Real phones, screen readers, keyboard-only use. Phone layout was checked at 500 px in headless Edge only.
- Load and timing. No performance test was run.
- Behaviour on Linux (development was on Windows; CI is Linux).

**Not run (and why):**
- **Break-it check** (break the code on purpose, confirm the tests fail). Not run yet. The test database was stopped by the system for low memory in the first round and restarted later at the owner's request, so it can be run next. It is the most valuable remaining check.
- Nothing else is pending from the first round. The full backend suite was re-run after the finance work: 103 of 103 passing.

## Engineering checks

| Check | Command | Result |
|---|---|---|
| Backend lint | `eslint .` | 0 problems (re-run 2026-11-14) |
| Backend types | `tsc --noEmit` | 0 errors (re-run) |
| Backend build | `tsc -p tsconfig.build.json` | builds (re-run) |
| Backend tests | `vitest run` | **103 passed, 10 files** (2026-11-14, after the finance work) |
| Frontend lint / types | `eslint .` / `tsc --noEmit` | 0 problems / 0 errors (re-run) |
| Frontend tests | `vitest run` | 6 passed, 2 files (re-run) |
| Frontend build | `vite build` | builds (re-run) |
| Dependencies, frontend | `npm audit --omit=dev` | 0 vulnerabilities (re-run) |
| Dependencies, backend | `npm audit --omit=dev` | **3 moderate**, all in `node-pg-migrate`'s `glob` and `minimatch` (F-10) |
| Secret scan (local patterns) | grep for key, token and URL patterns over every committable file | none found. Only two literals match "password-like": the dev-only JWT fallback (production boot rejects it, tested) and the public demo password (intended) |
| Docs links | script over all `.md` | 0 broken after the audit file existed |

Bugs the checks found while building, all fixed with a regression test:

| Found by | Bug |
|---|---|
| Code review before the tests | Login matched e-mails with `ILIKE`; `%` and `_` are legal e-mail characters, so `s_m@…` could match `sam@…`. Now an exact lower-case match. Test: `security.test.ts` "SQL metacharacters…" |
| Tests | Log masking skipped the message when the fields object came first, and top-level `password` was not redacted. Fixed; test in `security.test.ts` |
| Tests | The OpenAPI route registry duplicated entries when the app was created twice. Fixed |
| End-to-end smoke test | The single-page-app fallback answered `204` instead of the page, because the route wrapper ended the response before `sendFile` finished. Fixed; `static.test.ts` |
| End-to-end smoke test | Default CSP added `upgrade-insecure-requests` (breaks plain-HTTP local runs) and allowed any `https:` fonts and styles. Tightened to same-origin; asserted in `static.test.ts` |

## Migration and database

| Check | Result | Evidence |
|---|---|---|
| Migrations added | 3 (`001` platform, `002` ledger, `003` fiscal periods, drafts and approval), plain SQL, each with a down step | `backend/migrations/` |
| Fresh database | PASS | `tests/global-setup.ts` drops the schema and runs the real `npm run migrate` before every test run |
| Down and up again | PASS | `migrations.test.ts` rolls back all three migrations (no tables left), re-applies, and compares table lists. A second `migrate` is a no-op |
| RLS on every tenant table | PASS | `tenancy.test.ts` reads `pg_class`: all 14 tenant tables are `FORCE ROW LEVEL SECURITY`; `tenants` is enabled but not forced, on purpose (provisioning) |
| App role cannot bypass | PASS | `erpatio_app` is `NOLOGIN`, no `BYPASSRLS`, not superuser (tested). The API drops to it with `SET LOCAL ROLE` in every transaction |
| Fails closed | PASS | with no tenant context, 6 tables return 0 rows; `WITH CHECK` blocks writing another tenant's row (error 42501) |
| Cross-tenant references | PASS | composite foreign keys `(tenant_id, id)`; a line pointing at another tenant's account is rejected by the database even for the table owner (23503) |
| Ledger rules in the database | PASS | unbalanced entry, entry with no lines, line with both sides: all rejected at COMMIT (23514). Update and delete on posted entries and on the audit log are blocked for the app role and the owner |
| Privileges | PASS | app role has no UPDATE or DELETE on journal tables or the audit log; no INSERT on `users` |
| Column classification | PASS | `migrations.test.ts` compares `information_schema` with `classification.ts`: 107 columns, all classified; 5 hold personal data |
| Real Neon | **NOT RUN** | The `GRANT erpatio_app TO CURRENT_USER` and `SET ROLE` path is proven on a Neon-like local role only (F-02) |
| Indexes | not measured | Reasonable by inspection (tenant + date on entries, tenant + account on lines). No query plans were reviewed |
| Orphans / shared database | n/a | There is no shared database; nothing was written anywhere but the throwaway cluster |

## Evidence from real use

Run on the final build against a local database; this is not Neon.

| Step | Result |
|---|---|
| `npm run seed:demo -- --reset` | `demo tenant 'casa-verde-demo' ready with 14 journal entries` |
| `/health`, `/ready` | `{"status":"ok"}`, `{"status":"ready"}` |
| Sign in with the demo credentials | 200; role `DemoUser`; 7 permissions |
| Trial balance | `balanced = true`; debits 1,648,000.0000 = credits 1,648,000.0000; 14 accounts with activity |
| Refresh with the cookie | 200 |
| `GET /journal/abc` (single-page app deep link) | 200 `text/html` (it was 204 before the fix above) |
| `GET /api/v1/nope` | 404 `application/json` |
| Headers | `Content-Security-Policy` same-origin only, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN` |
| Real sign-in page, real fonts | Rendered correctly under the strict CSP (screenshot reviewed) |

### Finance workflow over HTTP (2026-11-14, local database)
Run as three people: the demo visitor, an accountant and a finance manager (the last two exist only on the local test database).

| Step | Result |
|---|---|
| Demo visitor reads fiscal periods | 200, 36 periods |
| Demo visitor closes a period / changes settings | 403 / 403 |
| Balance sheet (demo) | balanced; assets 1,231,300.00 |
| Income statement (demo, year to date) | revenue 400,000.00, expenses 416,700.00, net (16,700.00), equal to the Overview's earnings |
| Manager turns approval on; direct post | 409 `approval_required` |
| Accountant saves, submits, tries to approve own draft | 201, submitted, 403 |
| Manager sends it back with a note, accountant resubmits, manager approves | back to draft with the note; posted as JE-15 (8,000.00) |
| Manager closes August; posting into August | closed; 422 `period_closed` |
| Reopen without / with a reason | 422 / 200 |
| Audit log | contains draft.submitted, draft.rejected, draft.posted, period.closed, period.reopened, settings.updated |

## Acceptance criteria

Status per story. Totals follow the table.

### EPIC-01 Platform foundation
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-001 | Bootable dev environment | NOT MET (decision) | AC says compose starts db, redis, backend, frontend. Changed by D-1: compose runs the database only; API and web run with npm. `/health` and the UI on :5173 work (smoke test) |
| US-002 | Repository structure | PASS | `backend/src` + `backend/migrations`; `npm run migrate` and `npm run dev` work |
| US-003 | Secrets out of the repo | PASS | env-only config, `.env` ignored, `backend/.env.example` lists all variables; local scan clean. CI scan not yet run |
| US-004 | Config and DB session | PASS | `config/env.ts` (zod; production refuses weak secrets, tested), `db/pool.ts` |
| US-005 | Migrations pipeline | PASS | node-pg-migrate; up/down/up tested |
| US-006 | CI pipeline | PARTIAL | `ci.yml` runs lint, types, tests on PostgreSQL, build, audit, gitleaks, CodeQL. **Never run** |
| US-007 | Logging and probes | PASS | pino JSON with request id and tenant id; `/health` (liveness) and `/ready` (database) |
| US-008 | Error model and conventions | PASS | one JSON error shape with request id; `/api/v1` versioning; paginated journal list; 422 carries field paths only |

### EPIC-02 Identity, access, tenancy (M0 part)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-010 | Tenant sign-up | NOT MET (decision) | D-3: no public sign-up until e-mail verification exists. Tenants are created by script (`provisionTenant`) |
| US-011 | Login with JWT | PASS | `auth.test.ts`: token with roles and permissions, HttpOnly + SameSite=Strict cookie, 15-minute access token |
| US-012 | Password policy and hashing | PARTIAL | argon2id verified in the database (`$argon2id$`). The 12-character policy function exists but nothing sets passwords through the API yet |
| US-013 | Account lock-out | PASS | 5 failures lock for 15 minutes; even the right password is refused; audited |
| US-014 | Refresh rotation and logout | PASS | rotation, replay revokes the whole chain, expiry, logout, CSRF header, hashed storage: all tested |
| US-015 | Password reset by e-mail | NOT MET | not built |
| US-018 | RBAC guard | PASS | `requirePermission()`; Viewer gets 403 on post, edit, audit (`ledger.test.ts`) |
| US-019 | Row-Level Security | PASS | see Migration and database; cross-tenant leak tests answer 404 on every id-bearing endpoint |
| US-020 | Audit log | PASS | login, lock-out, token reuse, logout, account and journal changes written; append-only by trigger; no e-mail addresses in rows (tested) |
| US-023 | Two-factor (TOTP) | NOT MET | not built |

### EPIC-06 Security and data privacy
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-100 | Threat model review | NOT MET | the model was updated for the new stack; no security reviewer has signed off |
| US-101 | Transport security and headers | PARTIAL | helmet, strict CSP and the CORS allow-list are tested locally. HSTS is configured for production but **no test asserts it**. TLS is Render's and is unverified until deploy |
| US-102 | Rate limiting | PARTIAL | per-IP on login and refresh (429 with `Retry-After`, tested); per-account lock-out in Postgres. Not per tenant; in-process, one instance only (F-05, F-15) |
| US-103 | Validation and query standards | PASS | zod on every body, query and param; SQL parameterised, template-string SQL is an ESLint error; oversized body 413; injection strings tested |
| US-104 | Secret scanning gate | PARTIAL | gitleaks job written; not run |
| US-105 | SAST and dependency scanning | PARTIAL | CodeQL and `npm audit` jobs written, not run. Local `npm audit`: 0 and 3 moderate |
| US-106 | Container hardening | NOT MET (decision) | D-2: native Node service on Render, no containers |
| US-107 | Encryption at rest, encrypted backups | PARTIAL | provided by Neon by design; not verified. Restore drill not done (F-09) |
| US-108 | Key management and rotation | NOT MET | JWT key rotation is implemented (`kid`, `JWT_SECRET_PREVIOUS`) but **has no test**, and there is no KMS or rotation drill. No application encryption key exists |
| US-109 | Security event logging and alerts | PARTIAL | events go to the audit log; no alerting; permission-denied is not recorded (F-17) |
| US-110 | Data classification and register | PASS | `classification.ts` checked against the live schema; register generated at `03-architecture/data-classification-register.md` |
| US-111 | Field-level encryption | NOT MET | not built; no sensitive-personal data exists yet |
| US-112 | PII masking in logs | PASS | test: e-mails, bearer tokens, JWTs and `password` fields never reach log output |
| US-113 | Privacy notice and consent | NOT MET | not built |
| US-114 | Data-subject export | NOT MET | not built |
| US-115 | Erasure / anonymisation | NOT MET | not built |
| US-116 | Retention engine | NOT MET | not built |
| US-117 | Sensitive-field read audit | NOT MET | not built (depends on US-111) |
| US-118 | Breach runbook | NOT MET | not written |
| US-119 | Synthetic data in non-production | PASS | the only seed is the synthetic demo; tests use `@*.test` addresses |
| US-120 | E-mail verification | NOT MET | the verified flag is enforced at login (403 tested) but no flow sets it |
| US-121 | Breached-password check | NOT MET | not built |
| US-122 | Session list, sign out everywhere | NOT MET | not built (logout revokes the current session family only) |
| US-123 | No user enumeration | PASS | unknown user, wrong password and unknown workspace return identical bodies; equalised timing via a dummy hash (tested) |
| US-124 | Default-deny routes | PASS | `unguardedRoutes()` walks the real router at boot and in tests; the checker is itself tested; every protected route answers 401 without a token; the public allow-list is asserted exactly |
| US-125 | Sub-processor register | PARTIAL | written for Neon, Render, GitHub; regions are "planned" until the projects exist |

### EPIC-03 General ledger (the slice built ahead of M2)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-030 | Chart of accounts | PARTIAL | create, rename, deactivate; duplicate code returns 409. Flat list: no hierarchy or roll-ups |
| US-031 | Starter template | PASS | 16-account trading chart applied when a tenant is provisioned |
| US-032 | Draft journal entry | PASS | Drafts may be empty or unbalanced; only the author edits or deletes; posting checks balance; `drafts.test.ts` |
| US-033 | Balanced-entry enforcement | PARTIAL | unbalanced is rejected in the browser, the service (422) and the database (23514); nothing saved. The API message does not state the difference, which the AC asks for |
| US-034 | Post and immutability | PASS | posted entries cannot be updated or deleted by anyone (tested as app role and as owner). No edit or delete endpoint exists |
| US-035 | Reversal entry | PASS | swaps debits and credits in one transaction; once only, even under 5 concurrent attempts; a reversal cannot be reversed |
| US-036 | Fiscal periods | PASS | calendar months per fiscal year; closed or missing period refused in the service and by a database trigger (tested by direct SQL); `periods.test.ts` |
| US-037 | Period close and lock | PASS | unposted drafts block the close; already-closed and already-open refused; reopening needs a reason; both audited. The full close checklist is not built |
| US-038 | Approval workflow | PASS | per-workspace setting; submit, send back with a note, approve and post; the approver cannot be the author (403 `self_approval`); single level; `drafts.test.ts` |
| US-039 | Trial balance | PASS | ties to the ledger; honours the as-of date; decimals exact (0.1 + 0.2 = 0.3 tested) |
| US-040 | Income statement and balance sheet | PARTIAL | both computed from the ledger, date-filtered, exact decimals, balanced, tenant-isolated; CSV export. **Missing:** PDF export, comparative periods, year-end closing (earnings are cumulative) |
| US-046 | Gapless numbering | PASS | row lock on a per-tenant counter; 20 concurrent postings give 1 to 20 with no gaps. Covers the journal only |

Stories of EPIC-03 not listed (US-041 to 045, 047) are out of scope for this audit: not started.

### Totals
56 criteria audited: **27 PASS · 12 PARTIAL · 14 NOT MET · 3 NOT MET (decision)** (27 + 12 + 14 + 3 = 56).

### M0 gate (from the roadmap)
| Gate item | Status |
|---|---|
| Threat model reviewed, each threat has a mitigation story | NOT MET |
| Sign-up, verification, login, refresh, lock-out, reset, 2FA end to end | NOT MET (login, refresh, lock-out only) |
| Default-deny test | PASS |
| Cross-tenant leak test on all endpoints | PASS |
| Secret, SAST, dependency, image scans required and green in CI | NOT MET (never ran) |
| DB encrypted at rest; restore drill succeeded | NOT MET |
| PII register generated; sensitive fields encrypted; logs free of PII | PARTIAL (register and masking done; no encryption yet) |
| Data-subject export and erasure demonstrated | NOT MET |
| Breach runbook walked through | NOT MET |
| Gaps G-01, G-02, G-15, G-21, G-22 answered | PARTIAL (G-01, G-02 decided; G-15, G-21 open; G-22 partly) |

**The M0 gate does not pass.**

## Tests run (full inventory)

### Backend unit and integration tests: 103, all against real PostgreSQL
| File | Tests | What it checks |
|---|---|---|
| `auth.test.ts` | 12 | login cookie flags and shape; identical failure for unknown user, wrong password, unknown workspace; lock-out after 5 and blocked afterwards; unverified e-mail; deactivated user; only hashes stored (argon2id, SHA-256); forged, tampered and `alg=none` tokens; refresh rotation and replay revoking the family; CSRF header; logout; expired refresh |
| `tenancy.test.ts` | 8 | tenant A asking for tenant B's entry, reversal, account: 404 and nothing changed; list endpoints show own rows only; cannot post against B's account; session sees only its tenant; no context returns nothing; `WITH CHECK`; composite foreign keys; role is not bypass or superuser; all 14 tenant tables force RLS |
| `ledger.test.ts` | 21 | gapless numbering; unbalanced; exact decimals; 4 bad-amount forms (negative, 5 decimals, exponent, text); both/neither side, single line, inactive account; 20 concurrent postings; direct-SQL unbalanced, empty, two-sided lines; update/delete blocked for app role and owner; audit log append-only; reversal once, reversal of a reversal, 5 concurrent reversals; trial balance ties and as-of; audit written without personal data; duplicate code 409; Viewer and audit permissions |
| `security.test.ts` | 16 | every route has a guard (and the checker catches an unguarded one); every protected route 401 without a token; exact public allow-list; security headers; malicious request id; one error shape, no echoed values; malformed JSON 400, unknown route JSON 404, oversized body 413; no CORS for unknown origins; SQL-metacharacter input including LIKE wildcards; 429 with `Retry-After`; PII masking in logs; production boot refuses weak secret, insecure cookie, wildcard CORS; OpenAPI document; money helpers |
| `demo.test.ts` | 4 | seed gives a balanced 14-entry ledger and the published credentials work; idempotent; `--reset` restores state and triggers are back; the 100-entry cap; refuses to reset a non-demo tenant with the demo slug |
| `migrations.test.ts` | 4 | full down and up; idempotent; every column classified; personal columns tagged |
| `static.test.ts` | 3 | app shell at `/` and on deep links; unknown API path is JSON 404; strict CSP |
| `periods.test.ts` | 10 | 36 periods for a new tenant; only a manager adds a year, once; leap-year February; no period for a date; close blocks posting; the database refuses an entry in a closed period (direct SQL); reversals still work; unposted drafts block closing; close and reopen guards, reason, audit; cross-tenant close is 404 |
| `drafts.test.ts` | 17 | empty and unbalanced drafts allowed; author-only edit and delete; foreign account refused; posting a draft writes the ledger entry and records who posted; unbalanced or closed-period draft stays; non-author cannot post; approval on: direct post 409, only a manager changes the policy, full submit-approve flow with creator and approver recorded, nobody approves their own entry, send back with a note, unbalanced cannot be submitted, reversals not held, audit trail; the demo draft cap |
| `statements.test.ts` | 8 | income statement totals, ranges, defaults, bad dates, reversal; balance sheet balances with earnings, is as-of, empty and viewer cases, tenant isolation |

### Frontend: 6 tests (money parsing, round-trip, peso and ledger formatting; CSV quoting and formula neutralisation)

### Other checks
| Check | Result |
|---|---|
| Break-it check (break the code on purpose, expect failures) | **NOT RUN** (F-12) |
| End-to-end smoke test of the built app | passed, see "Evidence from real use" |
| Visual review | prototype and real sign-in page by screenshot, desktop 1280 px and phone layout at 500 px; the prototype is not the shipped UI |
| Contrast | computed for every text pair: 5.40 to 14.24, all above 4.5 |
| Manual checks by the owner | none yet |
| Load, performance | NOT RUN |

### Where the test data lived and what was cleaned up
- Throwaway PostgreSQL cluster in the session scratchpad (`…\scratchpad\pg\data`, port 5544), holding only synthetic rows. It was stopped by the system under memory pressure and has not been restarted. It can be deleted.
- My local smoke-test server was stopped by process id. Headless-browser profiles, temporary files and the cookie jar holding a demo refresh token were deleted. Screenshots remain in the scratchpad, outside the repository.
- The shared database: none exists. Nothing was written to Neon, Render or any hosted service.
- In the repo: `git grep` shows the demo credentials only in `README.md`, the runbook, this report, the seed script, the sign-in page and the prototype (all intended). Test data and passwords live in `backend/tests/` only.

## Definition of Done (doc 20)
| Item | Status |
|---|---|
| Code reviewed via PR; CI green | NOT MET (no push, no PR, CI never ran) |
| Unit tests for rules; integration test for DB flows | PASS (68 tests on real PostgreSQL) |
| Tenant isolation verified (leak test) | PASS |
| Reversible migration | PASS |
| Permission declared on every endpoint | PASS |
| Money never float | PASS (decimal strings, `bigint`, `NUMERIC(19,4)`) |
| Audit log for state-changing actions | PASS |
| OpenAPI docs updated | PARTIAL (generated; request bodies only, no response schemas) |
| No secrets in diff | PASS locally; scanner in CI not yet run |
| Docs and ADRs updated; traceability row updated | PARTIAL (docs and ADRs done; the traceability matrix was not updated for the new stories) |
| Demo'd to the PO and accepted | NOT MET |

## Decisions that change the ticket
| ID | Decision | Effect |
|---|---|---|
| D-1 | Express + React + TypeScript on PostgreSQL ([ADR-006](../03-architecture/adr/ADR-006-technology-stack.md)) | US-001, 002, 004, 005, 006 reworded; NFR-06, 09, 17 amended; closes G-02 |
| D-2 | One Render web service, no containers ([ADR-007](../03-architecture/adr/ADR-007-hosting-render-neon.md)) | US-106 not applicable; no CORS in production; closes G-06 |
| D-3 | No public sign-up until e-mail verification exists | US-010 deferred; tenants provisioned by script |
| D-4 | No Redis in v1 | US-102 limiter is per-IP in process; accounts lock in Postgres |
| D-5 | Public demo credentials ([ADR-008](../03-architecture/adr/ADR-008-public-demo-workspace.md)) | deliberate exception to "no shared credentials" |
| D-6 | Drafts live in their own tables; periods and approval added ([ADR-009](../03-architecture/adr/ADR-009-drafts-periods-and-approval.md)) | US-032, 036, 037, 038 built; the ledger stays append-only |
| D-7 | UI identity: "the ledger" ([design system](../03-architecture/design/ui-design-system.md)) | replaces the first generic design |
| D-8 | ADR-001 to 005 marked **Accepted** on 2026-11-13 on the product owner's instruction to approve | the PO should confirm in writing |

## Findings
| ID | Finding | Severity | Suggested action |
|---|---|---|---|
| F-01 | Not deployed; no live link; nothing verified on Render or Neon | High | Follow the runbook; fill the live-demo table |
| F-02 | RLS role setup (`GRANT … TO CURRENT_USER`, `SET LOCAL ROLE`) proven on a Neon-like local role only. CI runs as a superuser, which is weaker than local | High | Run migrations and the isolation tests against a Neon branch before publishing |
| F-03 | Two tabs refreshing in the same instant trip reuse detection and sign the person out | Medium | Accept the previous token for a few seconds after rotation |
| F-04 | The nightly reset needs the Neon direct (owner) string as a GitHub secret | Medium | Use a dedicated Neon role limited to the demo tenant; restrict the workflow to `main` |
| F-05 | Anyone can lock the shared demo account for 15 minutes (5 wrong passwords) | High (demo) | Do not lock accounts in `is_demo` tenants; rate-limit by IP only |
| F-06 | Sign-up, e-mail verification, password reset, 2FA, sessions list not built | High (for real use) | Finish M0 before any real tenant |
| F-07 | No field encryption, export, erasure, retention, consent, breach runbook | High (for real use) | M0 gate items; required before payroll data (M5) |
| F-08 | CI never ran; actions pinned to major tags, not commit SHAs | Medium | Open a PR, fix what fails, pin by SHA |
| F-09 | Backup retention unknown; restore drill not done | Medium | Check the Neon plan; run a drill into a branch |
| F-10 | 3 moderate advisories in `node-pg-migrate` (`glob`, `minimatch`); reachable only with our own migrations folder, below the CI gate; the offered fix is a breaking downgrade | Low | Accept; watch for a patched release |
| F-11 | No browser or end-to-end tests; the React pages have no tests | Medium | Add Playwright for sign-in, post, reverse, role gating |
| F-12 | Break-it check not run: test strength unproven | Medium | Run it next; fix any test that misses a break |
| F-13 | Permissions live in the access token: role changes take up to 15 minutes (ADR-004) | Low | Accepted |
| F-14 | Renaming or deactivating an account is last-write-wins | Low | Add a version check when more editing arrives |
| F-15 | Client IP comes from `X-Forwarded-For` with `TRUST_PROXY=1`; correct only behind Render's single proxy | Low | Re-check if the hosting changes |
| F-16 | Journal page, filter and trial-balance date are not in the URL; a refresh resets them | Low | Move paging and dates into the query string |
| F-17 | Permission-denied events are not written to the audit log (FR-SEC-11) | Medium | Record 403s with user and route, never the body |
| F-18 | The repo is public with no licence (G-15) | Medium | Choose a licence or make the repo private |
| F-19 | ~~Entry dates are unrestricted~~ **Resolved 2026-11-14:** fiscal periods lock closed months (service and database trigger) | n/a | none |
| F-20 | No test asserts that no response contains `password_hash`; the claim rests on code reading (no endpoint selects it) | Low | Add a test that walks every response |
| F-22 | JWT key rotation and the HSTS header have no automated test | Low | Add one test each |
| F-23 | Motion, the asset bar and the mobile-first stylesheet were added after the audited commit (push `6a1b899`). They were checked by screenshot with motion forced off, and by type-check, lint and build. Animations themselves were not watched at full motion, and the new finance screens (periods, drafts, approval, statements, settings) were not reviewed visually: they were checked by type-check, lint, build and the HTTP workflow above | Low | Review in a real browser once the stack runs; add Playwright (F-11) |
| F-21 | The HTML prototype loads fonts from Google Fonts; the shipped app self-hosts them | Low | Fine for a design file; do not ship the prototype as the product |

| F-24 | The public demo cannot show approval or period closing (the demo role has no such rights, by design); both are proven by tests only | Low | Optionally add a guided read-only tour |
| F-25 | No year-end closing, retained-earnings roll-forward, comparative periods or PDF export; balance sheet earnings are cumulative (US-040 partial) | Medium | Build year-end close next |
| F-26 | Approval is single-level and per workspace; any manager other than the author can approve | Low | Revisit with custom roles (M1) |
| F-27 | A draft can be saved with a date in a closed period; the block happens at submit and post | Low | Warn in the editor when the date is in a closed period |

## Gaps to ask the product owner
1. **Licence or private?** The repo is public today. Options: an open licence (MIT or Apache-2.0), a source-available licence, or make the repo private until the demo is ready. (G-15, G-16)
2. **Demo write access.** Visitors can post and reverse entries, bounded by the cap and the nightly reset. Options: keep, or make the demo read-only and rely on the seeded data. Recommendation: keep it writable, fix F-05.
3. **Neon region and plan.** Singapore is proposed. A paid plan buys a longer restore window; the free plan is enough for the demo. (G-11, NFR-06)
4. **Who signs off the threat model** (US-100): the product owner, or an outside reviewer?

## Release steps still open
1. Commit on the feature branch, push, open a pull request.
2. Make CI green; add `NEON_DIRECT_URL` as a repository secret.
3. Fix F-05, then F-03.
4. Create the Neon project (Singapore) and the Render Blueprint; seed the demo; run runbook step 6.
5. Paste the live URL into the runbook, the README and the table at the top of this report.
6. Run the break-it check; add the end-to-end tests (F-11, F-12).
7. Merge into `main` only after review.
