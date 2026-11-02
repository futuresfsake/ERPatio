# 13 — Multi-Tenancy & SaaS Platform Requirements (TEN)

Traces to: BR-11, BR-12

| ID | Requirement | Priority |
|---|---|---|
| FR-TEN-01 | Every business table carries `tenant_id`; all queries tenant-scoped | Must |
| FR-TEN-02 | DB-level isolation via SQL Server Row-Level Security as defence in depth | Must |
| FR-TEN-03 | Tenant resolved from JWT claim (and subdomain `acme.erpatio.app`) | Must |
| FR-TEN-04 | Self-service signup creates tenant, admin user, default CoA template | Must |
| FR-TEN-05 | Module subscription flags per tenant; disabled module → 403/hidden | Must |
| FR-TEN-06 | Trial (30 days) → paid / suspended → data-retained grace → deletion | Should |
| FR-TEN-07 | Usage metering: active users, storage, API calls | Should |
| FR-TEN-08 | Subscription billing integration (hosted payment provider) | Should |
| FR-TEN-09 | Platform admin console: list tenants, suspend, impersonate (audited) | Must |
| FR-TEN-10 | Per-tenant settings: base currency, fiscal year, number formats | Must |
| FR-TEN-11 | Noisy-neighbour protection: per-tenant rate limits and query timeouts | Should |
| FR-TEN-12 | Tenant data deletion on request (right to erasure) with certificate | Should |
| FR-TEN-13 | Dedicated-database option for large tenants | Could |
| FR-TEN-14 | Zero-downtime deploys; backward-compatible migrations | Should |

## Test must-haves
- Automated cross-tenant leak test: user A requests tenant B IDs on every endpoint → 404.
- Cache keys prefixed with tenant id.
