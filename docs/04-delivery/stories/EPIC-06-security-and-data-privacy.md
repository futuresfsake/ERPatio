# EPIC-06 — Security & Data Privacy (Milestone M0)

Authentication stories US-010…015, 018, 019, 020, 023 (in EPIC-02) are also part of M0. See [roadmap](../15-milestones-roadmap.md).

## Security
### US-100 Threat model review · 3 pts · Must — FR-SEC-01
As the product owner I want a reviewed STRIDE threat model so that mitigations are planned before code exists.
- **Then** each threat in doc 23 links to a story; security reviewer signs off.

### US-101 Transport security & headers · 3 pts · Must — FR-SEC-02/03
- **Given** a production-like deploy **When** I scan the app **Then** TLS ≥ 1.2, HSTS, CSP and strict CORS are present.

### US-102 Rate limiting · 5 pts · Must — FR-SEC-04
- **Given** 11 login attempts/min from one IP **Then** the 11th gets 429 with Retry-After.

### US-103 Validation & query standards · 3 pts · Must — FR-SEC-05, 12
### US-104 Secret scanning gate · 3 pts · Must — FR-SEC-06
### US-105 SAST + dependency scanning in CI · 3 pts · Must — FR-SEC-07
### US-106 Container hardening · 3 pts · Should — FR-SEC-08 (not applicable while deployed as a native Node service; revisit if containers return)
### US-107 Encryption at rest & encrypted backups · 5 pts · Must — FR-SEC-09
### US-108 Key management & rotation · 5 pts · Should — FR-SEC-10
### US-109 Security event logging & alerts · 3 pts · Must — FR-SEC-11

## Authentication additions
### US-120 Email verification · 3 pts · Must — FR-AUT-02
### US-121 Breached-password check · 2 pts · Should — FR-AUT-03
### US-122 Session list & sign-out everywhere · 3 pts · Should — FR-AUT-05
### US-123 No-enumeration login/reset · 2 pts · Must — FR-AUT-06
### US-124 Default-deny route test · 3 pts · Must — FR-AUT-07
As a developer I want startup to fail if a route has no declared permission so that no endpoint is accidentally public.

## Data privacy
### US-110 Data classification & PII register · 3 pts · Must — FR-PRV-01
As a privacy officer I want every column tagged by sensitivity so that I know where personal data lives.

### US-111 Field-level encryption · 8 pts · Must — FR-PRV-02
- **Given** an employee bank account is saved **When** I inspect the DB **Then** the value is ciphertext; the API returns it only to permitted roles.

### US-112 PII masking in logs · 3 pts · Must — FR-PRV-03
### US-113 Privacy notice & consent records · 3 pts · Must — FR-PRV-04
### US-114 Data-subject access export · 5 pts · Must — FR-PRV-05
### US-115 Erasure / anonymisation preserving ledger · 8 pts · Must — FR-PRV-06
As a data subject I want my identity removed on request while financial totals remain correct.
- **Then** the person is replaced by a pseudonym in all tables; trial balance unchanged.
### US-116 Retention policy engine · 5 pts · Should — FR-PRV-07
### US-117 Sensitive-field read audit · 5 pts · Must — FR-PRV-08
### US-118 Breach response runbook · 2 pts · Must — FR-PRV-10
### US-119 Synthetic data for non-prod · 2 pts · Must — FR-PRV-12
### US-125 Sub-processor & data-location register · 2 pts · Should — FR-PRV-11
