# 11 — Functional Requirements: BI, API & Data (BI / API / DAT)

## Business Intelligence — BR-09
| ID | Requirement | Priority |
|---|---|---|
| FR-BI-01 | Executive dashboard: cash, revenue MTD/YTD, AR/AP aging, top items | Must |
| FR-BI-02 | Inventory dashboard: stock value, low stock, turnover | Should |
| FR-BI-03 | Product/customer profitability report | Should |
| FR-BI-04 | Filter by date range, warehouse, department | Must |
| FR-BI-05 | Dashboards cached with ≤ 60 s staleness (cache store chosen at M6; Redis only if needed) | Should |
| FR-BI-06 | Scheduled email of reports (PDF/CSV) | Could |
| FR-BI-07 | Responsive layout for phone/tablet | Should |
| FR-BI-08 | Saved custom reports / simple report builder | Could |

## Public API — BR-13
| ID | Requirement | Priority |
|---|---|---|
| FR-API-01 | Versioned REST API (`/api/v1`) with OpenAPI docs | Must |
| FR-API-02 | API keys / OAuth client credentials per tenant | Should |
| FR-API-03 | Rate limiting per tenant | Should |
| FR-API-04 | Webhooks for key events (invoice posted, stock low) | Could |
| FR-API-05 | Idempotency keys on POST for postings | Should |

## Data portability — BR-12, BR-14
| ID | Requirement | Priority |
|---|---|---|
| FR-DAT-01 | CSV import templates (accounts, items, customers, suppliers, opening balances) | Must |
| FR-DAT-02 | Import validation report before commit | Must |
| FR-DAT-03 | Full tenant data export (CSV/JSON zip) | Must |
| FR-DAT-04 | Opening balance wizard (trial balance + stock on hand) | Should |
