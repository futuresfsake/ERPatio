# 22 — Functional Requirements: Security & Data Privacy (SEC / PRV)

**Milestone M0.** Nothing that stores business or personal data ships before these exist.
Traces to: BR-01, BR-11, BR-15, BR-16 (see doc 05), NFR-07…NFR-12.

## Security (SEC)
| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-SEC-01 | A documented threat model (STRIDE) covers auth, tenancy, ledger and API | Must | Reviewed; each threat has a mitigation story |
| FR-SEC-02 | All traffic uses TLS 1.2+; HSTS enabled | Must | HTTP redirects to HTTPS in non-dev |
| FR-SEC-03 | Security headers (CSP, X-Content-Type-Options, frame protection, Referrer-Policy) and strict CORS allow-list | Must | Header scan passes |
| FR-SEC-04 | Rate limiting per IP, per account and per tenant (Redis) | Must | Excess → 429 with Retry-After |
| FR-SEC-05 | Validate all input with typed schemas; parameterised queries only | Must | No string-built SQL (lint rule) |
| FR-SEC-06 | Secrets only from environment/secret manager; CI blocks committed secrets | Must | Secret scanner is a required check |
| FR-SEC-07 | CI runs SAST, dependency and container-image vulnerability scans | Must | High/critical findings fail the build |
| FR-SEC-08 | Containers run as non-root with pinned base images | Should | Verified in CI |
| FR-SEC-09 | Database encrypted at rest (TDE); backups encrypted | Must | Verified on restore drill |
| FR-SEC-10 | Encryption keys are managed centrally and rotatable without downtime | Should | Rotation runbook tested |
| FR-SEC-11 | Security events logged (login failure, permission denied, privilege change) and alertable | Must | Alert on burst of failures |
| FR-SEC-12 | Generic error messages to clients; no stack traces or SQL in responses | Must | Negative tests |
| FR-SEC-13 | Cross-tenant isolation enforced by tenant_id + SQL Server RLS | Must | See FR-TEN-01/02; leak test in CI |

## Authentication (extends doc 06, delivered in M0)
FR-IAM-01, 02, 03, 04, 09, 10, 11 and FR-TEN-04 are delivered in M0. Additional requirements:

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-AUT-01 | Access tokens short-lived (15 min), signed with rotating key; refresh tokens stored hashed | Must | Stolen DB does not reveal usable tokens |
| FR-AUT-02 | Email verification before first login | Must | Unverified → 403 |
| FR-AUT-03 | Password breach check (k-anonymity range lookup) at set/reset | Should | Known-breached password rejected |
| FR-AUT-04 | TOTP 2FA available to all users; mandatory for TenantAdmin and Accountant roles | Should | Enforcement flag per role |
| FR-AUT-05 | Session list and "sign out everywhere" | Should | Revokes all refresh tokens |
| FR-AUT-06 | Constant-time credential checks; no user enumeration on login/reset | Must | Same response and timing class |
| FR-AUT-07 | Authorisation guard on every route, default-deny | Must | Route without declared permission fails startup test |

## Data privacy (PRV)
| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-PRV-01 | Data classification: every column tagged Public / Internal / Confidential / Personal / Sensitive-Personal | Must | Register generated from model metadata |
| FR-PRV-02 | Sensitive-Personal fields (government IDs, bank account, salary) encrypted at field level | Must | DB dump shows ciphertext |
| FR-PRV-03 | PII masked in logs, error reports and analytics | Must | Log scanner finds none |
| FR-PRV-04 | Privacy notice and consent captured at signup and for employee data, with version and timestamp | Must | Consent record queryable |
| FR-PRV-05 | Data-subject access: export all personal data held about a person | Must | Delivered within SLA as JSON/CSV |
| FR-PRV-06 | Erasure/anonymisation of a person on request, while retaining ledger integrity | Must | Ledger totals unchanged; identity replaced by pseudonym |
| FR-PRV-07 | Retention policies per data class with scheduled purge/anonymise | Should | Dry-run report before delete |
| FR-PRV-08 | Access to Sensitive-Personal fields requires explicit permission and is logged (read audit) | Must | Reads appear in audit log |
| FR-PRV-09 | Data minimisation: optional fields are off by default and configurable | Should | Tenant setting |
| FR-PRV-10 | Breach response runbook with 72-hour notification timeline | Must | Tabletop exercise done |
| FR-PRV-11 | Sub-processor and data-location register published | Should | Linked from privacy notice |
| FR-PRV-12 | Non-production environments use synthetic or masked data only | Must | Policy + seed scripts |
| FR-PRV-13 | Tenant offboarding: export, then verified deletion with certificate | Should | See FR-TEN-12 |

## Business rules
- BRU-PRV-1: Financial records are retained per statutory period even after erasure; only identifying attributes are pseudonymised.
- BRU-PRV-2: PII never appears in URLs, cache keys or log lines.
- BRU-SEC-1: Security-relevant defaults are deny/closed.

## Open points
Legal basis and retention periods need PO/legal input — Gaps G-21, G-22.
