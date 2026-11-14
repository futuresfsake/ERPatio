# Security testing

ERPatio holds other companies' books, so its protections are **tested by attacking them**. A claim like "one company cannot see another's data" is only believed here once a test has tried to break it and failed.

This page says what is tested, how to run it, what has been caught, and, just as important, what is **not** covered.

## What these tests are, and are not
- They are **automated attack simulations** that run against a **throwaway PostgreSQL with fake data** on a developer machine or in CI. No real system is touched and no real person is involved.
- They are **not** a penetration test by an outside party. That is planned for M7 (hardening) and has not happened.
- They are **not** monitoring of a live system. Nothing is deployed yet; when it is, the [breach runbook](../06-operations/runbook-breach-response.md) covers real incidents.

## Attacks we simulate

| Attack | What the test does | Defence it proves | Where |
|---|---|---|---|
| **Reading another company's data** | A person from company A asks for company B's entries, accounts, drafts, people, periods and exports | Every id-bearing route answers 404 and nothing changes | `tenancy.test.ts`, `admin`, `drafts`, `periods`, `privacy` |
| **Getting around row-level security** | Queries with no tenant set; writes naming another tenant; a line pointing at another company's account, even as the table owner | The database returns nothing, refuses the write, and refuses the reference | `tenancy.test.ts` |
| **Guessing passwords** | Wrong passwords until the account locks; the right password while locked; 11 attempts a minute from one address | Lock-out for 15 minutes and a `429` with `Retry-After` | `auth.test.ts`, `security.test.ts` |
| **Finding out who has an account** | Unknown user vs wrong password vs unknown workspace; forgot-password, resend and sign-up for known and unknown addresses | Identical responses everywhere | `auth.test.ts`, `account.test.ts` |
| **Forging or tampering with a login token** | Edit the permissions inside a token; `alg=none`; unknown key; use a 2FA step token as an access token | All refused (401) | `auth.test.ts`, `mfa.test.ts` |
| **Stealing a refresh token** | Replay a token that was already rotated | The whole session chain is revoked and the event is audited | `auth.test.ts` |
| **Cross-site request forgery** | Refresh and sign-out without the required header | `403` | `auth.test.ts` |
| **Beating two-factor** | Replay a used code; guess codes; reuse a recovery code; try to skip enrolment when the role requires it | Each is refused; wrong codes count towards lock-out; the app stays gated until enrolled | `mfa.test.ts` |
| **Abusing e-mail links** | Reuse a link, use an expired or invented one, use an older link after a newer one | One-time, time-limited, newest wins | `account.test.ts` |
| **SQL injection and look-alikes** | `'; DROP TABLE users;--` as a workspace; `s_m@…` and `%` (LIKE wildcards) as an e-mail | Treated as data; never matches another person | `security.test.ts` |
| **Malformed or hostile input** | Broken JSON, a 200 kB body, negative amounts, five decimal places, `1e3` | `400`, `413`, `422`; no stack trace or submitted value in the reply | `security.test.ts`, `ledger.test.ts` |
| **Giving yourself more power** | Grant permissions you do not hold; create a role with the platform permission; remove the last administrator; hold the platform permission from an ordinary workspace | Refused every time | `admin.test.ts`, `platform.test.ts` |
| **Tampering with the books** | Post an unbalanced entry; edit or delete a posted entry; post into a closed period; each by the API **and by writing SQL directly as the app role and as the table owner** | Refused by the database itself, not only by the application | `ledger.test.ts`, `periods.test.ts` |
| **Tampering with the audit log** | Update or delete audit rows; try to change anything else while erasure mode is on | Only clearing an address is ever allowed | `ledger.test.ts`, `privacy.test.ts` |
| **Reading stored secrets** | Look at what the database holds for 2FA secrets and keys; decrypt one company's field as another; flip a bit of ciphertext | Ciphertext only; cross-tenant decrypt and tampering both fail | `mfa.test.ts`, `privacy.test.ts` |
| **Leaking personal data through logs** | Log an e-mail, a bearer token, a JWT and a password | All masked or redacted | `security.test.ts` |
| **Misusing support access** | Open a support session and try to write, refresh, or reach platform and admin routes | Read-only; no refresh; audited with the reason | `platform.test.ts` |
| **Sabotaging the public demo** | Hammer the demo login; try to change its password, 2FA, people or roles; flood it with drafts and entries | Never locked; those features refused; capped | `account`, `mfa`, `admin`, `demo`, `drafts` |
| **Exposed routes and weak configuration** | Every route must declare who may call it; every protected route is called with no token; production boots with the dev secret, an insecure cookie, wildcard CORS or no master key | Start-up or request refused | `security.test.ts` |

## Automated scanners (run on every pull request)

| Tool | Looks for | Status |
|---|---|---|
| **CodeQL** | Insecure code patterns (injection, unsafe calls, weak hashing) | Green on the foundation PR; it found one real issue in the prototype, fixed |
| **gitleaks** and **GitGuardian** | Passwords, tokens and keys committed by mistake | Green; the only allow-listed value is the public demo password, documented in ADR-008 |
| **npm audit** | Known-vulnerable dependencies | High and critical fail the build; 3 moderate advisories are accepted and logged (audit F-10) |
| **ESLint rules** | String-built SQL (banned), raw HTML in React (banned) | Enforced in CI |
| **Dependabot** | Outdated dependencies | Weekly pull requests |

## What these tests have caught
Each of these was a real defect, found by a test and fixed with a regression test (see the [audit](../07-quality/audit-dod.md)):

- Login matched e-mails with `LIKE`, so `s_m@…` could match `sam@…`.
- An operator query ignored company boundaries because the database owner bypasses row-level security: counts and module lists leaked across companies, and suspending one company would have signed everyone out.
- Log masking missed a message when the fields object came first, and left a top-level `password` visible.
- The page fallback answered `204`, and the default security policy allowed third-party fonts and styles.
- A deadlock between a late audit write and test clean-up.
- The first encryption key of a company could be created twice under concurrency.

## What is **not** covered
Being honest about the gaps matters more than the list above:

- **Break-it check** (deliberately breaking the code to prove the tests notice) has not been run. Until it is, passing tests prove less than they appear to.
- **No outside penetration test** yet (planned for M7).
- **No browser-level testing**: the security policy is checked as a header, and React escapes output, but no automated test loads the pages and tries cross-site scripting.
- **Not run against real Neon or Render**: grants, TLS, and the hosted network are unverified until the deploy.
- **No load or denial-of-service testing** beyond the per-address rate limit.
- **Real e-mail and the live breached-password lookup** have not been exercised.
- **People**: phishing and social engineering are outside what code can test; the runbook and mandatory 2FA are the mitigation.
- Supply-chain attacks beyond `npm audit` and Dependabot.

## How to run them
```bash
docker compose up -d db                # or any disposable PostgreSQL 16 or 17
cd backend && npm ci
npm test                               # 180 tests, about a minute
```
Set `TEST_DATABASE_URL` if your database is not the default in `backend/tests/config.ts`.

> **Never point `TEST_DATABASE_URL` at a real database.** The test set-up drops and recreates the `public` schema. It now refuses to run unless the host is `localhost` or `127.0.0.1` and the database name contains `test`.

## Rules for contributors
1. A new table or endpoint ships with a **cross-tenant test** (Definition of Done).
2. A new route cannot exist without a declared permission; the start-up check and the "401 without a token" test enforce it.
3. A security bug gets a **regression test before the fix is merged**, and a line in the audit.
4. Never weaken or delete a security test to make a build pass; fix the code, or record the decision as an ADR.
