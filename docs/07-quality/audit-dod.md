# Definition-of-Done audit: M0, M1 and the finance slice

| | |
|---|---|
| **Date** | 2026-11-14 |
| **Audited** | Branch `feat/m0-complete`, cut from `main` at `25693e8` (the squash-merge of PR #1). Work is uncommitted until the single push |
| **Compared with** | `main` (PR #1: foundation, ledger, drafts, periods, statements) |
| **How it was run** | Windows 11, Node 22.14, npm 10.9. PostgreSQL 17.4 on a throwaway local cluster with an owner role that mimics Neon's (not superuser, `CREATEROLE`, `BYPASSRLS`). No mocks: tests talk to real PostgreSQL |
| **Not audited** | See the list under the verdict |
| **Definition of Done used** | [`04-delivery/20-definition-of-done.md`](../04-delivery/20-definition-of-done.md), the stories in `04-delivery/stories/` (EPIC-01, EPIC-02 incl. M1, EPIC-06, and the EPIC-03 stories built), and the M0 gate in [`15-milestones-roadmap.md`](../04-delivery/15-milestones-roadmap.md) |

There is no Jira ticket, so the criteria come from the repo's own stories. Story IDs are used as AC numbers.

## Live demo

| | |
|---|---|
| **URL** | **Not deployed. There is no live link yet.** Nothing in this report was verified on Render or Neon. |
| Workspace / email / password | `casa-verde-demo` / `demo@erpatio.app` / `ERPatio-Demo-2026` (public on purpose, [ADR-008](../03-architecture/adr/ADR-008-public-demo-workspace.md)) |
| What is ready | `render.yaml`, the [runbook](../06-operations/deployment-render-neon.md), seed and nightly-reset scripts, the nightly workflow |
| What it needs | Your Neon and Render accounts, a master key, an SMTP account if sign-up is to be opened, then runbook steps 1 to 7 |
| Last verified live | never |

## Verdict

**Approved as the foundation to build on. Not approved for production or for real customer data.**

What was built since the first audit: the rest of M0 (self-service sign-up, e-mail confirmation, password reset, two-factor sign-in, sessions list, field-level encryption, data export and erasure, retention, security events), all of M1 (people and roles administration, custom roles, module subscriptions, platform-operator tools with read-only support sessions), plus two runbooks. **M2's receivables and payables slice is now built (customers, suppliers, invoices, bills, receipts, payments, tax codes, aging, tax report; migration 006, 24 tests). Still open in M2: year-end closing, multi-currency, payment reversal and credit notes, bank reconciliation, PDF export and M3 to M7 (supply chain, production, HR and payroll, dashboards and platform, hardening) are not started.**

Why it is still not ready:
1. **Not deployed.** No live URL. Nothing has run on real Neon or Render (F-01, F-02).
2. **The M0 gate is still open.** Not done: restore drill, breach tabletop, security-reviewer sign-off on the threat model, legal review of the privacy notice (G-21), licence decision (G-15).
3. **No real mail provider.** E-mail is held in memory unless `SMTP_URL` is set; production refuses `SIGNUP_ENABLED` without one. Sign-up, invitations and password reset have never sent a real message (F-30).
4. **Test strength is unproven.** The break-it check has still not been run (F-12).
5. **No end-to-end browser tests** for the React screens (F-11).

What is solid, with evidence: tenant isolation by the database, tested by crossing it; an unbalanced, edited or out-of-period ledger entry is impossible even by writing SQL; every route must declare a guard; sign-in does not reveal which accounts exist; refresh-token theft is detected without punishing two tabs; two-factor codes cannot be replayed; encrypted fields are ciphertext in the database; erasure leaves the books unchanged; nobody can grant permissions they do not hold or remove the last administrator.

**Not audited:**
- The live deployment (Render, Neon, TLS, cold starts) and a real SMTP provider.
- The live Have I Been Pwned call (the code path is tested with an injected checker).
- The React pages in a browser beyond the screenshots reviewed in earlier rounds; the new People, Roles, Operator, Security, sign-up and reset screens were checked by type-check, lint, build and the HTTP workflow below, not visually.
- Real phones, screen readers, keyboard-only use. Load and timing.
- Behaviour on Linux (development was on Windows; CI is Linux and ran green on PR #1).

**Not run (and why):**
- **Break-it check** (break the code on purpose, expect failures). Not run. It is the most valuable remaining check.
- **CI on this branch.** CI ran green on PR #1 (backend, frontend, secrets, CodeQL, GitGuardian). It has not run on the work in this report.

## Engineering checks

| Check | Command | Result |
|---|---|---|
| Backend lint / types / build | `eslint .` / `tsc --noEmit` / `tsc -p tsconfig.build.json` | 0 problems / 0 errors / builds |
| Backend tests | `vitest run` | **180 passed, 15 files** |
| Frontend lint / types / build | `eslint .` / `tsc --noEmit` / `vite build` | 0 problems / 0 errors / builds |
| Frontend tests | `vitest run` | 6 passed, 2 files |
| Dependencies | `npm audit --omit=dev` | frontend 0; backend 3 moderate in `node-pg-migrate` (`glob`, `minimatch`; F-10) |
| Secret scan | patterns over every committable file; GitGuardian and gitleaks on PR #1 | clean; the only allow-listed value is the public demo password (`.gitleaks.toml`, `.gitguardian.yaml`) |
| Docs links | script over all `.md` | 0 broken |

Bugs found by the checks while building, all fixed with a regression test:

| Found by | Bug |
|---|---|
| Tests | The demo reset script did not know new tables (three times, as migrations 003 to 005 added tables). Each time a test failed; it now lists every table |
| Tests | **Owner-connection queries in the platform module had no explicit `tenant_id`.** The owner role has `BYPASSRLS`, so the tenant setting filtered nothing: user counts and module lists leaked across workspaces, and suspending one workspace would have revoked every workspace's sessions. Fixed; `platform.test.ts` "suspending one workspace never signs anyone out of another" |
| Tests (intermittent) | A deadlock between a late fire-and-forget audit write and the next test's `TRUNCATE`. Security-event writes are now tracked and flushed (also on shutdown) |
| Tests | First-use creation of a tenant's encryption key raced under concurrency. Now `ON CONFLICT DO NOTHING` then re-read; tested |
| Tests | The public-config route captured the environment at start-up instead of per request |
| ESLint | An early return before hooks in the Overview page (moved to the route) |
| Smoke test | The single-page-app fallback answered 204 (fixed in round 1) |

## Migration and database

| Check | Result | Evidence |
|---|---|---|
| Migrations | 5, plain SQL, each with a working down step | `migrations.test.ts` rolls back all five (no tables left), re-applies, compares |
| RLS on every tenant table | PASS | `tenancy.test.ts` reads `pg_class`: all 18 tenant tables are `FORCE ROW LEVEL SECURITY` (`tenants` is enabled, not forced, on purpose) |
| App role cannot bypass | PASS | `erpatio_app` is `NOLOGIN`, no `BYPASSRLS`, not superuser (tested) |
| Fails closed / WITH CHECK / composite FKs | PASS | tested with direct SQL (`tenancy.test.ts`) |
| Ledger rules in the database | PASS | balance, immutability, one reversal, closed or missing period: all refused by direct SQL |
| Audit log append-only | PASS | updates and deletes refused; the **one** exception (clearing `ip` while `app.erasure` is on, nothing else changing) is itself tested to refuse every other change |
| Column classification | PASS | `migrations.test.ts`: every column classified, none stale; register regenerated |
| Encrypted at rest in the database | PASS | `users.totp_secret_enc` and `tenant_keys.wrapped_key` hold ciphertext (tested) |
| Real Neon | **NOT RUN** | role grants and `SET ROLE` proven on a Neon-like local role only (F-02) |
| Backup and restore | **NOT RUN** | [procedure written](../06-operations/runbook-backup-restore.md); no drill performed (F-09) |

## Evidence from real use

Run against the built app on a local database, over HTTP (this is not Neon):

| Step | Result |
|---|---|
| Sign-up; sign in before confirming the e-mail | 202; refused (`email_not_verified`) |
| New administrator opens the app without 2FA | blocked (`mfa_enrollment_required`) |
| Enrol with a computed authenticator code | 200, 8 recovery codes; the app then opens |
| Next sign-in | asks for a code (`mfa_required`); a code one step ahead completes it |
| Create a custom role; invite a person | 201; 201, invitation pending |
| The only administrator deactivates themselves | refused (`not_allowed`) |
| Export my data | consent on record |
| Operator lists workspaces; a workspace administrator tries | both workspaces with people counts; 403 |
| Support session | 201; reads the balance sheet 200; writes 403; the customer's own audit log shows it |
| Operator switches a module; suspends the workspace | enabled; sign-in then 401 |
| Finance workflow from round 1 | approval, period close, statements: unchanged and still passing |

## Acceptance criteria

### EPIC-01 Platform foundation
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-001 | Bootable dev environment | NOT MET (decision) | AC changed by D-1: compose runs the database only; API and web run with npm |
| US-002 | Repository structure | PASS | `backend/src`, `backend/migrations`; `npm run migrate`, `npm run dev` |
| US-003 | Secrets out of the repo | PASS | env-only config; `.env.example`; scans green on PR #1 |
| US-004 | Config and DB session | PASS | zod config (production refuses weak secrets, tested); `db/pool.ts` |
| US-005 | Migrations pipeline | PASS | node-pg-migrate; up, down, up tested |
| US-006 | CI pipeline | PASS | all checks green on PR #1 (run `43557360411`); not yet run on this branch |
| US-007 | Logging and probes | PASS | JSON logs with request and tenant ids; `/health`, `/ready` |
| US-008 | Error model and conventions | PASS | one error shape; `/api/v1`; pagination; field paths only |

### EPIC-02 Identity, access, tenancy (M0 and M1)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-010 | Tenant sign-up | PASS | `account.test.ts`: workspace, administrator, 36 periods, 16 accounts, consent, confirmation e-mail; off unless `SIGNUP_ENABLED`. Real e-mail untested (F-30) |
| US-011 | Login with JWT | PASS | `auth.test.ts` |
| US-012 | Password policy and hashing | PASS | argon2id; 12-character policy enforced at sign-up, reset and via invitation |
| US-013 | Account lock-out | PASS | 5 failures lock 15 minutes, audited; the shared demo account is exempt (F-05 fixed) |
| US-014 | Refresh rotation and logout | PASS | rotation, replay revokes the chain, 10-second grace for two tabs (F-03 fixed) |
| US-015 | Password reset by e-mail | PASS | identical answers for known and unknown accounts; one-time, 30-minute link; ends every session; a newer link replaces an older one |
| US-016 | Manage people | PASS | invite by e-mail, deactivate and reactivate (sessions end), rename, resend; records kept; `admin.test.ts` |
| US-017 | Assign roles | PASS | several roles per person, permissions are the union; cannot grant what you do not hold; last administrator protected |
| US-018 | RBAC guard | PASS | `requirePermission()` on every route |
| US-019 | Row-Level Security | PASS | see Migration and database |
| US-020 | Audit log | PASS | sign-in, lock-out, token reuse, drafts, postings, periods, settings, roles, people, privacy, platform, **permission denials** |
| US-021 | Module subscription flags | PASS | per-workspace flags in the token; a disabled module answers 403 `module_disabled`, core administration keeps working |
| US-022 | Platform admin console (API) | PASS | list, suspend, switch modules, read-only 15-minute support session with a mandatory reason, written to the customer's own audit log; UI page included |
| US-023 | Two-factor (TOTP) | PASS | RFC 6238 vectors; enrolment, 8 hashed single-use recovery codes, replay refused, mandatory per role, QR code |
| US-024 | Custom roles | PASS | create, edit, delete when unused; built-in roles fixed; unknown or platform permissions refused |

### EPIC-06 Security and data privacy
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-100 | Threat model review | PARTIAL | every threat has a mitigation and status; **no security reviewer has signed off** |
| US-101 | Transport security and headers | PARTIAL | helmet, strict CSP, CORS allow-list tested; HSTS configured but untested; TLS is Render's, unverified |
| US-102 | Rate limiting | PARTIAL | per-IP on every public auth route; per-account lock-out in Postgres; not per tenant; in-process (F-15) |
| US-103 | Validation and query standards | PASS | zod everywhere; parameterised SQL (lint-enforced); 413, 400, injection tested |
| US-104 | Secret scanning gate | PASS | gitleaks and GitGuardian green on PR #1; branch protection making them *required* is not configured |
| US-105 | SAST and dependency scanning | PASS | CodeQL and `npm audit` green on PR #1; it found a real prototype issue, fixed |
| US-106 | Container hardening | NOT MET (decision) | D-2: native Node service, no containers |
| US-107 | Encryption at rest, encrypted backups | PARTIAL | provided by Neon, unverified; restore drill not run (F-09) |
| US-108 | Key management and rotation | PARTIAL | master key outside the database, per-tenant wrapped keys, re-wrap script, JWT `kid` rotation; rotation tested for the master key; no KMS; no rotation drill; JWT rotation untested (F-22) |
| US-109 | Security event logging and alerts | PARTIAL | denials audited; a burst of 10 in 5 minutes logs a `security_alert` line; nothing pages anyone |
| US-110 | Data classification and register | PASS | checked against the live schema; register regenerated |
| US-111 | Field-level encryption | PARTIAL | mechanism built and proven (TOTP secrets are ciphertext; rotation, tamper, cross-tenant tested); no employee or bank fields exist yet to encrypt (M5) |
| US-112 | PII masking in logs | PASS | tested |
| US-113 | Privacy notice and consent | PARTIAL | notice page and consent record with version and time at sign-up; employee-data consent arrives with HR (M5) |
| US-114 | Data-subject access export | PASS | admin export of any person, self-export for everyone; audited; tested |
| US-115 | Erasure preserving the ledger | PASS | person pseudonymised, sessions and addresses cleared, **trial balance and entries byte-identical before and after** (tested) |
| US-116 | Retention policy engine | PARTIAL | dry-run report then delete for expired sign-in tokens and e-mail links; other data classes have no policy yet |
| US-117 | Sensitive-field read audit | NOT MET | no readable sensitive-personal fields exist yet (M5); exports are audited |
| US-118 | Breach response runbook | PARTIAL | [written](../06-operations/runbook-breach-response.md); **tabletop not held** |
| US-119 | Synthetic data in non-production | PASS | |
| US-120 | E-mail verification | PASS | gate enforced, link flow built, resend |
| US-121 | Breached-password check | PASS | k-anonymity range lookup, fails open; tested with an injected checker; live call not exercised |
| US-122 | Session list and sign out everywhere | PASS | list, revoke one, revoke all; cannot touch another person's |
| US-123 | No user enumeration | PASS | |
| US-124 | Default-deny routes | PASS | now 60+ routes; public allow-list asserted exactly |
| US-125 | Sub-processor register | PARTIAL | regions "planned" until the projects exist |

### EPIC-04b Credit notes and bank (M2, migration 010)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-051 | Credit notes (customers) and debit notes (suppliers) | PASS | mirror-image postings; separate gapless numbers; wrong-side tax code and wrong party kind refused (`notes-bank.test.ts`) |
| US-052 | Apply a note to open items | PASS | over-application, other party, draft note refused; two simultaneous applications cannot use one credit twice; aging and ledger still agree |
| US-053 | Bank statement import | PASS | idempotent; identical lines in one file kept; zero, empty and non-asset refused; append-only |
| US-054 | Match, auto-match, unmatch | PASS | only unambiguous pairs auto-match; amount and account must agree; one to one |
| US-055 | Post a statement line (fee, interest) | PASS | goes through normal posting; matched in the same step; once only |
| US-056 | Reconciliation report | PASS | ledger vs statement difference, unmatched on both sides, whether the difference is explained |
| US-057 | Printable documents (PDF via print) | PARTIAL | print stylesheet; layout checked by eye only (ADR-011) |
| US-058 | Multi-currency | NOT MET (decision) | single currency by design, ADR-011 |

### EPIC-05 Supply chain (M3 core, migration 008)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-060 | Items and stock on hand | PASS | `stock.test.ts`; unique SKU, deactivate |
| US-061 | Stock ledger (append-only) with stock card | PASS | running balance; rows cannot be changed or deleted; a database check ties each movement to its sign |
| US-062 | Purchase orders: draft, approve (gapless number), receive in parts | PASS | over-receipt refused; a received order closes itself; cancel only before stock moves |
| US-063 | Sales orders: draft, approve, deliver in parts | PASS | delivery refused when stock is short, nothing changes; two simultaneous deliveries cannot oversell |
| US-064 | Moving-average costing | PASS | the last unit out takes the remaining value, so no residue; awkward thirds still reconcile |
| US-065 | Stock adjustments with reason | PASS | both directions post to Inventory Adjustments |
| US-066 | Inventory equals the ledger (gate: variance 0) | PASS | valuation report compares stock value with the inventory account for any date and flags a manual entry; a stock entry cannot be reversed by hand |
| US-068 | Three-way match: bill from receipt | PASS | draft bill for received-and-unbilled goods on the goods-received account; billing counted at posting, so two drafts cannot bill the same goods; void releases; a price difference stays visible on 2050 (`stock-gaps.test.ts`) |
| US-069 | Invoice from delivery | PASS | draft invoice for delivered-and-uninvoiced goods; once only; void releases |
| US-070a | Returns to supplier and from customer | PASS | only unbilled or uninvoiced goods (the rest by credit or debit note); returns at order price or at the delivery's cost; order reopens; stock still equals ledger |
| US-070b | Reorder levels and report | PASS | flag on items, report shows on hand, on order, committed |
| US-067 | Module subscription gate | PASS | a workspace without `supply_chain` gets 403 `module_disabled` |

### EPIC-03 General ledger (built ahead of M2)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-030 | Chart of accounts | PARTIAL | flat list; no hierarchy or roll-ups |
| US-031 | Starter template | PASS | 16 accounts at provisioning and sign-up |
| US-032 | Draft journal entry | PASS | `drafts.test.ts` |
| US-033 | Balanced-entry enforcement | PARTIAL | browser, service and trigger; the API message does not state the difference |
| US-034 | Post and immutability | PASS | |
| US-035 | Reversal entry | PASS | once only, even under concurrency |
| US-036 | Fiscal periods | PASS | |
| US-037 | Period close and lock | PASS | |
| US-038 | Approval workflow | PASS | |
| US-039 | Trial balance | PASS | |
| US-040 | Income statement and balance sheet | PARTIAL | no PDF, no comparatives, no year-end close (earnings cumulative) |
| US-046 | Gapless numbering | PASS | journal, invoices and bills each have a counter; a void keeps its number (`subledger.test.ts`) |

### EPIC-04 Receivables and payables (M2 slice, migration 006)
| ID | Story | Status | Evidence |
|---|---|---|---|
| US-041 | Customers and suppliers | PASS | tax number encrypted, never listed, reveal is audited |
| US-042 | Customer invoices (draft, post, void) | PASS | totals in integer units, cent rounding half up, balanced entry on post |
| US-043 | Vendor bills | PASS | same engine, input tax side |
| US-044 | Receipts and payments with allocation | PASS | partial, multi-document, over-allocation refused, concurrent receipts cannot over-collect, a trigger checks allocations sum to the payment |
| US-045 | Tax codes and tax report | PASS | output and input codes, report nets them; drafts never count |
| US-047 | Aging | PASS | five buckets, payments after the cut-off ignored, compared with the ledger control account |
| US-049 | Year-end close into retained earnings | PASS | one flagged entry dated 31 Dec; income statement for the year unchanged; balance sheet still balances; once only, even concurrently (`yearend.test.ts`) |
| US-050 | Undo a receipt or payment | PASS | reversing entry, balances restored, aging honours the void date, once only; the payment row stays |
| US-048 | Subledger and ledger cannot drift | PASS | invoice, bill and payment entries cannot be reversed by hand (409); a void reverses the entry |

Not started: EPIC-03 US-041 to 045 and 047 (bills, invoices, aging, currency, VAT, posting-rule engine); all of EPIC-04 (supply chain), EPIC-05 (production, HR, BI) and US-095 to 099 (import, export, API keys, webhooks, billing).

### Totals
61 criteria audited: **44 PASS · 14 PARTIAL · 1 NOT MET · 2 NOT MET (decision)** (44 + 14 + 1 + 2 = 61).

### M0 gate (from the roadmap)
| Gate item | Status |
|---|---|
| Threat model reviewed, every threat has a mitigation story | PARTIAL (mitigated; reviewer sign-off missing) |
| Sign-up, verification, login, refresh, lock-out, reset, 2FA end to end | PASS (tests and HTTP; real mail untested) |
| Default-deny test | PASS |
| Cross-tenant leak test on all endpoints | PASS |
| Secret, SAST, dependency scans in CI and green | PASS on PR #1 (not configured as *required* checks) |
| DB encrypted at rest; restore drill succeeded | **NOT MET** (drill not run) |
| PII register generated; sensitive fields encrypted; logs free of PII | PASS for the data that exists |
| Data-subject export and erasure demonstrated on synthetic data | PASS |
| Breach runbook walked through | **NOT MET** (written, tabletop not held) |
| Gaps G-01, G-02, G-15, G-21, G-22 answered | PARTIAL (G-15 and G-21 open, G-22 partly) |

**The M0 gate does not pass yet.** What is left is procedure and people, not code.

## Tests run (full inventory)

### Backend: 180 tests, all against real PostgreSQL
Many are deliberate attack simulations; they are catalogued, with their gaps, in [security testing](../03-architecture/security-testing.md).

| File | Tests | What it checks |
|---|---|---|
| `auth.test.ts` | 12 | sign-in shape and cookie flags; identical failures; lock-out; unverified; deactivated; hashed storage; forged and `alg=none` tokens; rotation, replay, CSRF header, logout, expiry |
| `account.test.ts` | 17 | slug generation; sign-up creates everything, consent, hashed token; unconfirmed cannot sign in, link works once; expired or invented tokens; weak, breached, consent-less sign-up creates nothing; duplicate company names; closed unless enabled; new administrator gated to 2FA; resend; password reset (identical answers, one use, ends sessions, newer link wins, unlocks, never for the demo); the demo account is never locked |
| `mfa.test.ts` | 17 | RFC 6238 vectors, drift, replay; enrolment, encrypted secret, recovery codes; step token and code; replay refused; step token cannot act as access token; wrong codes lock; recovery codes once; disable needs password and code; mandatory roles gated and cannot disable; sessions list, revoke, revoke all, cross-person; concurrent refresh grace; permission denials audited without the body |
| `privacy.test.ts` | 14 | encryption round-trip, nonce, cross-tenant and tamper, concurrent first key, blind index, master-key rotation; export (content, audit, self vs others, cross-tenant); erasure keeps ledger and totals identical, clears addresses, audit log stays append-only, guards (self, twice, last administrator, demo); retention dry run and apply |
| `admin.test.ts` | 18 | invite and accept; duplicates, bad roles, permissions; resend; cross-workspace 404; demo locked; role replacement and union; no privilege escalation; last administrator; deactivation ends sessions; rename; custom roles (list, create effective at next sign-in, refusals, escalation, system roles fixed, in-use delete, audit); module visibility and 403 `module_disabled` |
| `platform.test.ts` | 11 | only the operator; permission alone is not enough; listing; suspend and reactivate; **no cross-workspace session loss**; protected targets; module switching; support sessions (reason, audit, read-only, no refresh, suspended) |
| `ledger.test.ts` | 21 | posting, decimals, bad amounts, concurrency, direct-SQL rules, reversal, trial balance, audit, roles |
| `tenancy.test.ts` | 8 | cross-tenant 404s, RLS, fail-closed, WITH CHECK, composite FKs, role flags, all 18 tables forced |
| `security.test.ts` | 16 | default-deny, 401 without a token for every protected route, exact public list, headers, error hygiene, rate limit, PII masking, production config guards, OpenAPI, money |
| `periods.test.ts` | 10 | periods, leap February, close and lock (service and trigger), reversal still works, drafts block close, reopen with reason, cross-tenant |
| `drafts.test.ts` | 17 | drafts, posting, approval workflow, send-back, self-approval refused, demo cap |
| `statements.test.ts` | 8 | income statement and balance sheet |
| `demo.test.ts` | 4 | seed, idempotent reset, cap, refuses a non-demo tenant |
| `migrations.test.ts` | 4 | full down and up, idempotent, classification |
| `static.test.ts` | 3 | app shell and deep links, JSON 404, strict CSP |

### Frontend: 6 tests (money parsing and formatting; CSV quoting and formula neutralisation)

### Other checks
| Check | Result |
|---|---|
| Break-it check | **NOT RUN** (F-12) |
| HTTP workflow (sign-up through support session) | passed, see Evidence |
| Visual review | earlier rounds only (prototype, sign-in, header alignment) |
| Load, performance | NOT RUN |

### Where the test data lived and what was cleaned up
- Throwaway PostgreSQL cluster in the session scratchpad (port 5544), synthetic rows only. It is still running for local viewing and can be deleted.
- Local-only logins (`*@erpatio.local`) exist only in that database. The helper script that created them was deleted and never committed; `git grep` confirms none of those credentials are in the repository.
- My local server runs on port 8123 until stopped. Browser profiles and temporary files were removed.
- Nothing was written to Neon, Render or any hosted service.

## Definition of Done (doc 20)
| Item | Status |
|---|---|
| Code reviewed via PR; CI green | PARTIAL: PR #1 was green; this branch has not been through a PR yet |
| Unit tests for rules; integration test for DB flows | PASS (180 tests on real PostgreSQL) |
| Tenant isolation verified (leak test) | PASS |
| Reversible migration | PASS |
| Permission declared on every endpoint | PASS |
| Money never float | PASS |
| Audit log for state-changing actions | PASS |
| OpenAPI docs updated | PARTIAL (generated; request bodies only) |
| No secrets in diff | PASS |
| Docs and ADRs updated; traceability row updated | PARTIAL (docs and ADRs done; the traceability matrix was not updated for new stories) |
| Demo'd to the PO and accepted | NOT MET |

## Decisions that change the ticket
| ID | Decision | Effect |
|---|---|---|
| D-1 | Express + React + TypeScript on PostgreSQL ([ADR-006](../03-architecture/adr/ADR-006-technology-stack.md)) | US-001, 002, 004, 005, 006 reworded |
| D-2 | One Render web service, no containers ([ADR-007](../03-architecture/adr/ADR-007-hosting-render-neon.md)) | US-106 not applicable |
| D-3 | Sign-up is off by default and needs a mail provider | production refuses `SIGNUP_ENABLED` without `SMTP_URL` |
| D-4 | No Redis in v1 | per-IP limiter is in-process; accounts lock in Postgres |
| D-5 | Public demo credentials ([ADR-008](../03-architecture/adr/ADR-008-public-demo-workspace.md)) | the demo is exempt from lock-out and cannot change passwords, 2FA, people or roles |
| D-6 | Drafts, periods, approval ([ADR-009](../03-architecture/adr/ADR-009-drafts-periods-and-approval.md)) | US-032, 036, 037, 038 built |
| D-7 | UI identity "the ledger" | see the design system |
| D-8 | ADR-001 to 005 accepted on the product owner's instruction | the PO should confirm in writing |
| D-9 | **Platform operator uses the owner connection** ([ADR-010](../03-architecture/adr/ADR-010-platform-operator.md)) | every query in that module must filter by `tenant_id` itself; support sessions are read-only |
| D-10 | Mandatory 2FA is a per-workspace list of roles | on for the administrator role of every workspace created by sign-up, and for the operator role; off for seeded and demo workspaces |

## Findings
| ID | Finding | Severity | Suggested action |
|---|---|---|---|
| F-01 | Not deployed; no live link; nothing verified on Render or Neon | High | Follow the runbook |
| F-02 | RLS role setup proven on a Neon-like local role only; CI runs as a superuser | High | Run migrations and isolation tests against a Neon branch |
| F-03 | ~~Two tabs refreshing together sign the person out~~ **Resolved:** 10-second grace window, tested | n/a | none |
| F-04 | The nightly reset needs the Neon owner string as a GitHub secret | Medium | Use a dedicated Neon role limited to the demo tenant |
| F-05 | ~~Anyone can lock the shared demo account~~ **Resolved:** demo tenants are exempt from lock-out; tested | n/a | none |
| F-06 | ~~Sign-up, verification, reset, 2FA, sessions not built~~ **Resolved** except real mail delivery (F-30) | n/a | none |
| F-07 | Field encryption, export, erasure, retention, consent built; **no sensitive-personal data exists yet to encrypt, and the breach tabletop and legal review are not done** | Medium | M5 uses the mechanism; hold the tabletop; get legal review (G-21) |
| F-08 | ~~CI never ran~~ **Resolved:** green on PR #1. Actions are pinned to major tags, not commit SHAs; the checks are not set as *required* in branch protection | Low | Pin by SHA; require the checks |
| F-09 | Backup retention unknown; restore drill not done | Medium | Check the Neon plan; run the drill |
| F-10 | 3 moderate advisories in `node-pg-migrate` (dev-time, behind the CI gate) | Low | Accept; watch for a fix |
| F-11 | No browser or end-to-end tests; the React pages have no tests | Medium | Add Playwright |
| F-12 | Break-it check not run: test strength unproven | Medium | Run it next |
| F-13 | Permissions live in the access token: role, deactivation and suspension reach an open session within 15 minutes (refresh is refused immediately) | Low | Accepted (ADR-004) |
| F-14 | Renaming or deactivating an account is last-write-wins | Low | Version check when editing grows |
| F-15 | Client IP comes from `X-Forwarded-For` with `TRUST_PROXY=1`; the limiter is per-process | Low | Revisit if hosting changes or scales out |
| F-16 | Journal tab and filters: the tab is in the URL, paging and dates are not | Low | Move paging and dates into the query string |
| F-17 | ~~Permission denials not audited~~ **Resolved** | n/a | none |
| F-18 | The repo is public with no licence (G-15) | Medium | Choose one |
| F-19 | ~~Entry dates unrestricted~~ **Resolved** (fiscal periods) | n/a | none |
| F-20 | No test asserts that no response contains `password_hash` | Low | Add a test that walks every response |
| F-21 | The HTML prototype loads fonts from Google Fonts and shows only the first 8 screens | Low | Fine for a design file; refresh it before showing it as current |
| F-22 | JWT key rotation and HSTS have no automated test | Low | Add one test each |
| F-23 | Motion, new screens and the mobile-first stylesheet were reviewed by type-check, lint, build and screenshots only; animations not watched at full motion | Low | Review in a browser; add Playwright |
| F-24 | The public demo cannot show approval, closing, administration or 2FA (by design); tests only | Low | Optional guided tour |
| F-25 | ~~No year-end closing~~ **Resolved**. Still missing: comparatives, PDF export, multi-currency, credit notes, bank reconciliation | Medium | Rest of M2 |
| F-35 | Invoices, bills and receipts are posted directly; they bypass the optional journal approval (approver is not the author) | Medium | Add approval to documents if a customer requires it |
| F-42 | One location per workspace: no warehouses, bins, lots, serials or unit-of-measure conversion. **Decision:** accepted for the pilot; build when a pilot customer has more than one stock room | Medium | Revisit after M7 pilot feedback |
| F-43 | ~~Bill does not clear goods received~~ **Resolved** (bill from receipt). A price difference is left on 2050 as a visible variance; there is no automatic price-variance posting | Low | Add a purchase price variance account if a customer needs it |
| F-44 | ~~No invoice from delivery, returns or reorder points~~ **Resolved**. Landed cost (freight, duty added to item cost) is still missing | Low | Add with locations |
| F-47 | Bank reconciliation assumes the imported statement starts where the books do; no statement closing balance or opening balance is entered | Low | Add opening balance and statement closing balance if a customer needs a signed-off reconciliation |
| F-48 | A credit or debit note application cannot be undone | Low | Add an un-apply that reverses the totals |
| F-49 | Multi-currency is not built (ADR-011) | Medium | Build when a pilot customer needs it |
| F-45 | Orders carry no tax, currency or discount; the invoice or bill carries them | Low | Revisit with three-way match |
| F-46 | The new stock screens were checked by type-check, lint and build only, not in a browser | Low | Same as F-39 |
| F-36 | ~~A payment cannot be undone~~ **Resolved** (payment void). Credit notes, refunds and unapplied cash are still missing | Medium | Next in M2 |
| F-37 | Customer and supplier contact details (email, phone) are not yet in the data-subject export or the erasure routine | Medium | Extend DSAR and erasure to parties before any real customer data is entered |
| F-38 | `npm audit` reports 3 moderate findings in `glob` and `minimatch`, pulled in by `node-pg-migrate` (a deploy-time tool, not on the request path) | Low | Update when the tool releases a fix; Dependabot is watching |
| F-39 | The new pages (invoices, bills, aging, tax report) were checked by type-check, lint and build only, not in a browser | Low | Run them in the browser; add Playwright (F-11) |
| F-40 | Tax codes have no effective dates, withholding, or per-line tax-inclusive pricing; amounts are PHP only | Low | Multi-currency and withholding in the next M2 step |
| F-26 | Approval is single-level and per workspace | Low | Revisit if a customer needs more |
| F-27 | A draft can be saved with a date in a closed period; blocked at submit and post | Low | Warn in the editor |
| F-28 | A deactivated person's open access token works for up to 15 minutes | Low | Accepted; shorten or add a per-request check if required |
| F-29 | **The owner connection ignores RLS (`BYPASSRLS`)**: every query in the platform module must carry its own `tenant_id`. A real leak was found and fixed here | Medium | Keep that module small; add a lint rule or a test that scans it for unfiltered queries |
| F-30 | No real SMTP provider has been used; the Have I Been Pwned call has never been made live | Medium | Configure a provider, send real mail, and make one live range call before opening sign-up |
| F-31 | Mandatory 2FA is off for seeded workspaces and the demo; the platform operator script turns it on | Low | Decide whether existing administrators must enrol |
| F-32 | A support session ends on reload (it has no refresh token) | Low | By design |
| F-33 | Invitation and reset links go to `APP_URL`; a wrong value sends people to a dead page | Low | Set `APP_URL` in Render |
| F-34 | No branch protection or required reviews on `main` | Medium | Enable in repository settings |

## Gaps to ask the product owner
1. **Licence.** PolyForm Noncommercial was recommended (portfolio now, commercial rights kept). Not yet applied. (G-15)
2. **Mail provider.** Which SMTP service (for example Brevo, Resend, SES)? Needed before sign-up, invitations and password reset can work in production.
3. **Legal review.** The privacy notice and retention periods need a lawyer's eye (Philippine Data Privacy Act). (G-21)
4. **Who signs off the threat model and attends the breach tabletop?** (US-100, US-118)
5. **Next scope.** Finish finance (M2 remainder), or open sign-up and deploy first so there is a live link?

## Release steps still open
1. Squash to one commit, push once, open a pull request; let CI run on it.
2. Enable branch protection and make the scans required (F-34, F-08).
3. Create the Neon project and the Render service; set `MASTER_KEY`, `SMTP_URL`, `APP_URL`; seed the demo; create the platform administrator; run runbook step 7.
4. Run the restore drill and the breach tabletop; get the threat-model sign-off.
5. Run the break-it check; add the browser tests (F-11, F-12).
6. Then M2 remainder and M3 onward.

## Dependency review (Dependabot PRs #2 to #7), 2026-11-14

| PR | Change | Result | Decision |
|---|---|---|---|
| #2 | `github/codeql-action` 3 to 4 | Official GitHub action, CI green | Applied |
| #3 | `actions/setup-node` 4 to 7 | Official GitHub action, CI green | Applied |
| #4 | `gitleaks/gitleaks-action` 2 to 3 | Publisher is the gitleaks project, same one already used; CI green | Applied |
| #5 | `actions/checkout` 4 to 7 | Official GitHub action, CI green | Applied |
| #6, #7 | `typescript` 6.0.3 to 7.0.2 (backend, frontend) | **CI fails**: `typescript-eslint` 8.72 does not accept TypeScript 7 (`ERESOLVE` on `npm ci`) | Not applied. Wait for a `typescript-eslint` release that supports it |

Method: read each diff (workflow files only, no other change), confirmed the publisher, checked CI on the PR. Not done: workflows reference actions by version tag, not by commit SHA, so a moved tag would be picked up (finding F-41). The four action bumps were applied in one commit with the next change; Dependabot closes its PRs when the change lands.

| F-41 | GitHub Actions are pinned to version tags, not commit SHAs | Low | Pin to SHAs and let Dependabot update them |
