# 06 — Functional Requirements: Identity & Access (IAM)

Traces to: BR-01, BR-11

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-IAM-01 | System shall allow a user to sign in with email + password | Must | Valid creds → JWT access (15 min) + refresh (7 d); invalid → 401, generic message |
| FR-IAM-02 | Passwords shall be stored hashed (argon2id) with min length 12 | Must | No plaintext anywhere; weak password rejected |
| FR-IAM-03 | System shall lock an account for 15 min after 5 failed logins | Must | 6th attempt blocked; event logged |
| FR-IAM-04 | System shall support refresh-token rotation and logout (revocation) | Must | Reused refresh token invalidates the chain |
| FR-IAM-05 | Tenant Admin shall create, deactivate and reactivate users | Must | Deactivated user cannot sign in; history retained |
| FR-IAM-06 | System shall implement RBAC with roles defined in doc 04 | Must | Endpoint returns 403 if role lacks permission |
| FR-IAM-07 | Tenant Admin shall assign multiple roles per user | Must | Effective permission = union of roles |
| FR-IAM-08 | System shall support custom roles built from permission sets | Should | Admin picks permissions per module/action |
| FR-IAM-09 | System shall support password reset by emailed one-time link (30 min expiry) | Must | Link single-use |
| FR-IAM-10 | System shall support optional TOTP two-factor auth | Should | Enforceable per role |
| FR-IAM-11 | System shall write an audit log of auth events and permission changes | Must | Who/what/when/IP, immutable |
| FR-IAM-12 | System shall support SSO (OIDC) | Could | Deferred; see Gaps |

## Data (from design Step 2)
`users`, `roles`, `user_roles`, `permissions`, `role_permissions`, `refresh_tokens`, `audit_log` — all with `tenant_id`.
