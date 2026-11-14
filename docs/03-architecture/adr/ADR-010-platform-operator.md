# ADR-010: Platform operator, the owner connection and support sessions

- **Status:** Accepted · **Date:** 2026-11-14 · **Builds on:** [ADR-002](ADR-002-tenant-isolation-strategy.md)

## Context
Someone has to run the platform: list workspaces, suspend an abusive one, switch modules on a subscription, and look at a customer's data when asked (FR-TEN-09, US-022). That is the one job that legitimately crosses tenants. Everything else in the product is confined to one tenant by Row-Level Security and the unprivileged `erpatio_app` role. Threat T-12 is an operator abusing that reach.

## Decision
1. **The operator has their own workspace** (`platform`) with the role `PlatformAdmin`, the only role that holds `platform:manage`. That permission cannot be put in any custom role (the permission catalogue a workspace can grant excludes it) and the API double-checks that the caller belongs to the `platform` workspace.
2. **Platform operations run on the owner connection** (`withOwner`), because they must see across tenants. The owner role normally has `BYPASSRLS` (Neon's does), so the tenant setting does **not** filter anything there. Therefore every query in `modules/platform` carries an explicit `tenant_id` condition, and the module is kept small. A real cross-tenant leak of exactly this kind was found by a test and fixed (audit F-29).
3. **Mandatory two-factor** for the `PlatformAdmin` role (set by `npm run platform:admin`).
4. **Support sessions are read-only, 15 minutes, no refresh token, and need a reason** of at least 8 characters. The token carries read permissions only (accounts, journal, reports, audit), so no write route can succeed, and the user id on it is the operator's, not a customer user's. Starting one writes `platform.support_session_started` with the reason and the operator's id into **the customer's own audit log**, which the customer's administrators can read.
5. **Suspension** sets the workspace status. Sign-in is refused, refresh is refused, and its refresh tokens are revoked. Access tokens already issued lapse within 15 minutes.
6. **Module switches** are made only by the operator; a workspace administrator can see its subscription but not change it.

## Consequences
+ Customers can see exactly when the operator looked at their books, and why.
+ Compromising an operator cannot silently change customer data through a support session.
− The operator account is the highest-value target in the system: it needs 2FA, a strong password, and ideally a hardware key. There is no second approver yet.
− The owner-connection module relies on discipline (explicit `tenant_id`). Audit F-29 asks for a lint rule or test that scans it.
− Impersonating a *write* action (for example fixing a customer's entry for them) is deliberately impossible; the customer's own administrator must do it.

## Alternatives rejected
Impersonating a real customer administrator (ambiguous audit trail, write access). A separate database role for the operator (more moving parts than v1 needs; revisit with a pilot customer). A shared "support" user inside each tenant (a standing credential in every workspace).
