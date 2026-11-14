# ADR-001: Deliver ERPatio as multi-tenant SaaS

- **Status:** Accepted (2026-11-13) · **Date:** 2026-11-02 · **Deciders:** Product owner. Closes Gap G-01.

## Context
Target SMEs lack IT staff. Options: SaaS, PaaS, self-hosted. See [doc 02](../../01-product/02-deployment-model-decision.md).

## Decision
Offer ERPatio as a vendor-hosted, multi-tenant SaaS with module-based subscriptions. Expose a public API to allow a later platform (PaaS-like) extension.

## Consequences
+ One codebase, easy upgrades, recurring revenue.
− We own uptime, backups, security, billing, support.
− Tenant isolation becomes a top-priority quality attribute (ADR-002).

## Alternatives rejected
PaaS (wrong customer), self-hosted only (support burden; kept as possible enterprise tier).
