# 23 — Threat Model (STRIDE, v0.1)

Scope: ERPatio SaaS — browser → React SPA served by Express → PostgreSQL (Neon). Draft by BA; security review needed (US-100).

## Assets
Financial ledger · Personal/payroll data · Credentials & tokens · Tenant isolation · Availability.

## Trust boundaries
1. Internet ↔ edge (TLS)  2. Browser ↔ API  3. API ↔ database  4. Tenant A ↔ Tenant B  5. Vendor staff ↔ tenant data

## Threats and mitigations
| ID | STRIDE | Threat | Mitigation | Story |
|---|---|---|---|---|
| T-01 | Spoofing | Credential stuffing / brute force | Lockout, rate limits, breach-password check, 2FA | US-013, 102, 023 |
| T-02 | Spoofing | Stolen refresh token | Hashed storage, rotation, reuse detection | US-014 |
| T-03 | Tampering | SQL injection | Parameterised ORM queries, lint, SAST | US-103, 105 |
| T-04 | Tampering | Edit posted ledger entries | Immutability, DB constraints, audit | ADR-003 |
| T-05 | Repudiation | User denies a posting | Append-only audit log with user, IP, time | US-020 |
| T-06 | Info disclosure | Cross-tenant data access (IDOR) | tenant_id + RLS + leak tests | US-019 |
| T-07 | Info disclosure | PII in logs / backups | Masking, field encryption, encrypted backups | US-112, 111, 107 |
| T-08 | Info disclosure | Secrets in git | Scanner, env-only secrets | US-104 |
| T-09 | Info disclosure | Verbose errors | Generic error model | US-008 |
| T-10 | DoS | Abusive API calls / heavy reports | Rate limits, query timeouts, caching | US-102 |
| T-11 | Elevation | Missing permission check | Default-deny guard + startup test | US-018 |
| T-12 | Elevation | Vendor admin abuses impersonation | Time-boxed, audited, reason required | US-022 |
| T-13 | Tampering | Vulnerable dependency / image | SCA + image scan in CI | US-105, 106 |
| T-14 | Info disclosure | Insecure non-prod data | Synthetic data only | US-119 |

## Residual risks (for PO)
Insider threat at vendor, third-party provider compromise, zero-days. Accepted with monitoring (US-109) — see Gap G-23.

## Added threats (2026-11-14)
| ID | STRIDE | Threat | Mitigation | Story |
|---|---|---|---|---|
| T-15 | Spoofing | Stolen password used without the second factor | TOTP 2FA, mandatory per role; codes single-use (replay refused); recovery codes hashed and single-use; wrong codes count towards lock-out | US-023 |
| T-16 | Spoofing | Emailed link intercepted or reused | One-time tokens, SHA-256 stored, 30-minute reset and 48-hour verify expiry, a newer link replaces an older one, reset ends all sessions | US-015, US-120 |
| T-17 | DoS | Mass sign-up creating workspaces | Sign-up off unless enabled and mail configured; per-IP rate limit; email must be confirmed before sign-in | US-010 |
| T-18 | Info disclosure | Database copy read without the master key | Field-level envelope encryption; per-tenant data keys wrapped by a master key held outside the database; key rotation by re-wrap | US-111, US-108 |
| T-19 | Info disclosure | Personal data kept longer than needed or impossible to remove | Retention engine for technical records; export and pseudonymising erasure that keeps the ledger | US-114, US-115, US-116 |
| T-20 | DoS | Locking the shared demo account by guessing | The demo tenant is exempt from lock-out and rate-limited by address only | F-05 |
| T-21 | Repudiation | Token replayed from two tabs mistaken for theft | Ten-second grace window for a just-rotated token; later replay revokes the family | F-03 |

## Mitigation status (2026-11-14)
Every threat is either **Done** (built and tested) or **Scheduled**. Residual risk and sign-off remain open: US-100 needs a security reviewer, who is not yet named.

| Threat | Status | Evidence |
|---|---|---|
| T-01, T-02 | Done | `auth.test.ts`, `mfa.test.ts` |
| T-03 | Done | parameterised SQL, lint rule, injection tests |
| T-04, T-05 | Done | ledger and audit triggers, `ledger.test.ts` |
| T-06 | Done | `tenancy.test.ts` |
| T-07 | Done | field encryption, log masking, `privacy.test.ts`, `security.test.ts` |
| T-08, T-13 | Partial | secret and dependency scans run in CI; first runs were green on 2026-11-14 |
| T-09, T-10, T-11 | Done | error model, per-IP limits, default-deny |
| T-12 | Scheduled | platform-admin impersonation (M1, US-022) |
| T-14 | Done | synthetic data only (ADR-008) |
| T-15 to T-21 | Done | `mfa.test.ts`, `account.test.ts`, `privacy.test.ts` |
