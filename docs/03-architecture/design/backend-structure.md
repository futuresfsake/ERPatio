# Backend structure (Express 5 + TypeScript)

Replaces the Python layout in [step1-folder-structure](step1-folder-structure.md). Decision: [ADR-006](../adr/ADR-006-technology-stack.md).

```
backend/
├── migrations/            plain SQL, node-pg-migrate (-- Up Migration / -- Down Migration)
├── scripts/
│   ├── seed-demo.ts       create or reset the public demo tenant (synthetic data only)
│   └── pii-register.ts    regenerate docs/03-architecture/data-classification-register.md
├── src/
│   ├── server.ts          process entry: listen, graceful shutdown
│   ├── app.ts             createApp(): middleware order, routers, static React build, default-deny check
│   ├── config/env.ts      zod-validated environment; production refuses weak secrets
│   ├── db/
│   │   ├── pool.ts        pg pool; withTenant() and withSystem() transactions (SET LOCAL ROLE + set_config)
│   │   └── classification.ts   column-by-column data classification (FR-PRV-01)
│   ├── lib/
│   │   ├── route.ts       the only way to declare a route; requires a guard; feeds OpenAPI
│   │   ├── permissions.ts permission catalogue, system roles, guards, unguardedRoutes()
│   │   ├── security.ts    argon2id, JWT (kid rotation), refresh-token hashing
│   │   ├── errors.ts      ApiError
│   │   ├── logger.ts      pino + request context + PII masking
│   │   └── money.ts       decimal-string <-> bigint units (no floats)
│   ├── middleware/        requestContext, errorHandler (DB rule violations -> clean 4xx)
│   └── modules/
│       ├── auth/          routes.ts (HTTP) + service.ts (login, refresh, logout)
│       ├── ledger/        routes.ts, schemas.ts (zod), service.ts (accounts, journal, reports)
│       ├── audit/         audit.ts (append-only writer)
│       └── tenants/       provision.ts (owner-connection provisioning, default chart of accounts)
└── tests/                 vitest + supertest against a real PostgreSQL
```

## Conventions
1. **One module = schemas (zod) -> service -> routes -> tests -> migration.** Routes are thin; rules live in services.
2. **Declare routes only through `route()`.** A guard is a required argument (`publicRoute(reason)`, `requirePermission(null)` or `requirePermission(P.X)`). `assertAllRoutesGuarded()` walks the real Express router at startup and in tests.
3. **Every query runs inside `withTenant(tenantId, fn)`.** It opens one transaction, drops to `erpatio_app` (no BYPASSRLS), sets `app.tenant_id` locally, and commits at the end so deferred ledger triggers run before the response is sent.
4. **SQL is parameterised.** Template literals inside `.query()` are an ESLint error. Fixed fragments are concatenated constants.
5. **Money is a decimal string on the wire and `bigint` units in code.** `NUMERIC(19,4)` in the database.
6. **Errors** are `{ error: { code, message, request_id, details? } }`. Validation details carry field paths only, never submitted values.
7. **The database is the last line of defence.** Balance, immutability, reversal-once, same-tenant references and RLS are all enforced in SQL, and tested by writing to the database directly.
8. **New table checklist:** `tenant_id`, `UNIQUE (tenant_id, id)`, composite foreign keys, RLS enabled and forced with the standard policy, least-privilege grants, a down migration, an entry in `classification.ts`, a cross-tenant test.
