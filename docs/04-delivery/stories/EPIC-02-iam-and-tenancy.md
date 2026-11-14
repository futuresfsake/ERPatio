# EPIC-02 — Identity, Access & Tenancy (Milestones M0 and M1)

**Split by milestone (v0.2):**
- **M0 (security foundation):** US-010, 011, 012, 013, 014, 015, 018, 019, 020, 023
- **M1 (administration):** US-016, 017, 021, 022, 024

Additional authentication and privacy stories are in [EPIC-06](EPIC-06-security-and-data-privacy.md).

### US-010 Tenant signup · 5 pts · Must
As a new customer I want to register my company so that I get my own isolated workspace.
- **Given** a unique company name and admin email **When** I submit **Then** a tenant, admin user and default settings are created and a verification email is sent. Traces: FR-TEN-04

### US-011 Login with JWT · 5 pts · Must
As a user I want to sign in with email and password so that I can access my tenant.
- Valid → access + refresh tokens containing `tenant_id`, roles. Invalid → 401. Traces: FR-IAM-01

### US-012 Password policy & hashing · 2 pts · Must — FR-IAM-02
### US-013 Account lockout · 3 pts · Must — FR-IAM-03
### US-014 Refresh rotation & logout · 3 pts · Must — FR-IAM-04
### US-015 Password reset by email · 3 pts · Must — FR-IAM-09

### US-016 Manage users · 5 pts · Must
As a Tenant Admin I want to create, deactivate and reactivate users so that staff access follows employment.
- **Then** deactivated users fail login immediately; records retained. Traces: FR-IAM-05

### US-017 Assign roles · 3 pts · Must
As a Tenant Admin I want to assign one or more roles so that people get the right access. Traces: FR-IAM-06/07

### US-018 RBAC guard · 5 pts · Must
As a developer I want a `require_permission()` dependency so that every endpoint is protected declaratively.

### US-019 Row-Level Security · 8 pts · Must
As the vendor I want PostgreSQL RLS keyed on `tenant_id` so that a code bug cannot leak data across tenants. Traces: FR-TEN-02
- **Then** automated test: tenant A token requesting tenant B ids returns 404 on all endpoints.

### US-020 Audit log · 5 pts · Must — FR-IAM-11
### US-021 Module subscription flags · 3 pts · Must — FR-TEN-05
### US-022 Platform admin console (API) · 5 pts · Should — FR-TEN-09
### US-023 Two-factor auth (TOTP) · 5 pts · Should — FR-IAM-10
### US-024 Custom roles · 5 pts · Should — FR-IAM-08
