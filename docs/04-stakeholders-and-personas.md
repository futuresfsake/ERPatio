# 04 — Stakeholders & Personas

## Internal (ERPatio vendor)
| Stakeholder | Interest | Influence |
|---|---|---|
| Product Owner | Scope, priority, ROI | High |
| Business Analyst | Requirements quality | Medium |
| Dev team | Feasibility, tech debt | High |
| QA | Testability | Medium |
| DevOps/SRE | Reliability, cost | Medium |
| Support | Supportability | Low–Med |

## Customer-side personas → system roles
| Persona | RBAC role | Modules | Typical tasks |
|---|---|---|---|
| Tenant Admin | `TenantAdmin` | All + settings | Users, roles, subscriptions |
| Finance Manager | `Accountant` | FIN, BI | Post journals, close period, reports |
| AP/AR Clerk | `FinanceClerk` | FIN | Invoices, payments |
| Warehouse Supervisor | `InventoryManager` | SCM | Receipts, issues, counts, transfers |
| Buyer | `Procurement` | SCM | POs, supplier mgmt |
| Production Lead | `ProductionPlanner` | PRD, SCM(read) | BOMs, work orders |
| HR Officer | `HRManager` | HCM | Employees, shifts, payroll |
| Owner / Executive | `Executive` | BI (read) | Dashboards |
| External Auditor | `Auditor` | FIN (read-only) | Ledger inspection, audit log |
| Platform Operator (vendor) | `PlatformAdmin` | Control plane | Tenant provisioning, billing |

## RACI (documents)
| Artefact | PO | BA | Dev | QA |
|---|---|---|---|---|
| Vision | A | R | C | I |
| Functional reqs | A | R | C | C |
| Stories | A | R | R | C |
| Acceptance tests | C | C | I | R/A |
