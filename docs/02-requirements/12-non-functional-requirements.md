# 12 — Non-Functional Requirements (NFR)

| ID | Category | Requirement | Target |
|---|---|---|---|
| NFR-01 | Performance | API p95 latency for reads | < 300 ms |
| NFR-02 | Performance | Journal posting p95 | < 500 ms |
| NFR-03 | Scalability | Concurrent users per tenant | 100 (v1), 50 tenants |
| NFR-04 | Availability | Monthly uptime | 99.5% (v1) |
| NFR-05 | Durability | RPO / RTO | 15 min / 4 h |
| NFR-06 | Backup | Managed point-in-time restore (Neon); retention per plan, to be confirmed (audit F-09) | Restore drill quarterly |
| NFR-07 | Security | OWASP ASVS L2 baseline; TLS 1.2+ everywhere | Pen-test before GA |
| NFR-08 | Security | Secrets in env/secret manager, never in repo | Scanner in CI |
| NFR-09 | Security | Encryption at rest for the DB and backups (provided by Neon) | — |
| NFR-10 | Integrity | ACID transactions for all postings; no float money | — |
| NFR-11 | Auditability | Append-only audit log, 7-year retention | — |
| NFR-12 | Privacy | Data-privacy law compliance (PH DPA; GDPR-ready); detailed in doc 22 | Privacy notice, DSAR + erasure working (M0) |
| NFR-13 | Usability | Core flows learnable in ≤ 2 training sessions | UAT feedback |
| NFR-14 | Accessibility | WCAG 2.1 AA for main screens | — |
| NFR-15 | Observability | Structured logs, metrics, traces, per-tenant dashboards | — |
| NFR-16 | Maintainability | ≥ 80% unit coverage on services; migrations versioned | CI gate |
| NFR-17 | Portability | Database runs from `docker compose up db`; API and web run with `npm` (ADR-006) | — |
| NFR-18 | Localisation | English UI; PHP/USD; date/number formats configurable | — |
| NFR-19 | Browser support | Latest 2 versions Chrome, Edge, Firefox, Safari | — |
