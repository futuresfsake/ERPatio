# 05 — Business Requirements (BR)

Customer needs translated from [03](../01-product/03-simulated-customer-profile.md). Each BR is decomposed into functional requirements (FR) in docs 06–11.

| ID | Business requirement | Priority | Source | Satisfied by |
|---|---|---|---|---|
| BR-01 | Users sign in securely and only see what their role permits | Must | Auditor, Finance | FR-IAM-* |
| BR-02 | Every financial posting follows double-entry and is permanently traceable | Must | Finance, Auditor | FR-FIN-* |
| BR-03 | Inventory and the general ledger always reconcile | Must | Finance, Warehouse | FR-SCM-*, FR-FIN-* |
| BR-04 | Support multiple warehouses with accurate real-time stock | Must | Warehouse | FR-SCM-* |
| BR-05 | Manage purchasing from request to supplier payment | Must | Procurement | FR-SCM-*, FR-FIN-* |
| BR-06 | Manage sales orders through fulfilment and invoicing | Must | Sales, Finance | FR-SCM-*, FR-FIN-* |
| BR-07 | Plan and track assembly using BOMs and work orders | Should | Production | FR-PRD-* |
| BR-08 | Track shifts and process payroll accurately | Should | HR | FR-HCM-* |
| BR-09 | Executives see live KPIs on any device | Should | Owner | FR-BI-* |
| BR-10 | Multi-currency (PHP/USD) with revaluation | Should | Finance | FR-FIN-* |
| BR-11 | Multiple companies' data fully isolated (SaaS) | Must | Vendor | FR-TEN-* |
| BR-12 | Customer can self-onboard and import existing data | Should | Vendor, Customer | FR-TEN-*, FR-DAT-* |
| BR-13 | Open API for integrations | Could | Owner | FR-API-* |
| BR-14 | Data can be exported at any time (no lock-in) | Must | Owner | FR-DAT-* |
| BR-15 | The platform is secure by default and resists common attacks | Must | Owner, Auditor | FR-SEC-*, FR-AUT-* |
| BR-16 | Personal data is protected and handled per privacy law (access, erasure, consent) | Must | HR, Owner, Vendor | FR-PRV-* |

Priority = MoSCoW. PO to confirm in [17 Gaps](../05-governance/17-gaps-and-open-questions-for-po.md).
