# ADR-004: Authentication design

- **Status:** Proposed · **Date:** 2026-11-02

## Decision
- Email + password with **argon2id**; min length 12; breached-password check.
- **JWT access token** (15 min) containing `sub`, `tenant_id`, `roles`; **opaque refresh token** (7 d) stored **hashed**, rotated on every use, reuse revokes the chain.
- Web client keeps the refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie; access token in memory.
- TOTP 2FA, mandatory for privileged roles.
- Lockout + Redis rate limits; identical responses for unknown/known accounts.
- SSO (OIDC) deferred (Gap G-12) but the token layer is built so an external IdP can be added.

## Alternatives considered
Server-side sessions (simpler revocation, but harder to scale statelessly); third-party IdP such as Auth0/Keycloak (faster, adds cost/dependency — revisit if SSO becomes Must).

## Consequences
Key rotation for JWT signing needed (`kid` header). Access-token revocation is by short expiry only.
