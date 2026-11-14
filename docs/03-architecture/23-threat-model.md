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
