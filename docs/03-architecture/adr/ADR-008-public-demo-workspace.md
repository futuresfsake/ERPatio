# ADR-008: Public demo workspace

- **Status:** Accepted · **Date:** 2026-11-13

## Context
Visitors (recruiters, prospects) must be able to use a live ERPatio without signing up.

## Decision
A seeded tenant `casa-verde-demo` ("Casa Verde Trading Corp. (Demo)") with **synthetic data only**
(FR-PRV-12). Its credentials are published on the login page and in the README, a deliberate,
documented exception to "no shared credentials".

Guard rails:
1. Role `DemoUser`: post and reverse journal entries, manage accounts, read the audit log. No user or tenant administration.
2. Tenant flag `is_demo` caps the workspace at 100 journal entries (`DEMO_MAX_ENTRIES`).
3. The demo tenant is isolated by the same RLS as any tenant; the cross-tenant tests cover it.
4. Reset to a known state with `npm run seed:demo -- --reset` (run nightly from a scheduled GitHub Action, secrets in repository settings).
5. No real e-mail addresses, names or financial data may ever be loaded.

## Consequences
Anyone can post entries into the demo; the cap and nightly reset bound the abuse.
The reset script is the only code allowed to lift the append-only triggers, and only for `is_demo` tenants.
