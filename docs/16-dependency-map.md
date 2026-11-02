# 16 — Dependency Map

## Module dependencies
```mermaid
graph TD
  M0[M0 Foundation] --> M1[M1 IAM + Tenancy]
  M1 --> M2[M2 Finance / GL]
  M2 --> M3[M3 Supply Chain]
  M3 --> M4[M4 Production]
  M2 --> M5[M5 HCM]
  M2 --> M6[M6 BI]
  M3 --> M6
  M4 --> M6
  M5 --> M6
  M6 --> M7[M7 Hardening + Pilot]
```

## Story-level dependencies (critical path in bold)
| Story | Depends on | Why |
|---|---|---|
| **US-019 RLS** | US-004, US-010 | Needs session + tenant context |
| US-018 RBAC guard | US-011 | Needs token claims |
| **US-033 Balanced entry** | US-032 | Journal model |
| **US-047 Posting engine** | US-034, US-036 | Needs posted/immutable + periods |
| **US-055 GR + GL** | US-047, US-052, US-054 | Stock + posting + PO |
| US-060 Delivery + COGS | US-047, US-064, US-058 | Costing needed for COGS |
| US-065 Inv↔GL recon | US-055, US-060, US-064 | All inventory postings exist |
| US-073 Work order | US-070, US-052 | BOM + stock |
| US-076 WIP accounting | US-047, US-074 | Posting + issues |
| US-086 Payroll run | US-080, US-085, US-087 | Employees, components, rules |
| US-089 Payroll GL | US-047, US-086 | Posting + locked run |
| US-090 Exec dashboard | M2 complete | Needs ledger data |
| US-099 Billing | US-021, US-010 | Module flags + tenant |

## External dependencies
| Dependency | Needed by | Owner | Risk |
|---|---|---|---|
| Email provider (SMTP/API) | US-010, US-015 | DevOps | Low |
| Payment provider | US-099 | PO decision | Medium |
| Cloud hosting + managed SQL Server licence | M7 / beta | PO/Finance | **High (cost)** |
| PH statutory tables | US-087 | HR SME | Medium |
| PDF generation lib | US-088 | Dev | Low |
| Object storage | FR-FIN-16 | DevOps | Low |

## Technical constraints
- SQL Server Developer edition for dev only; production needs a licence or Azure SQL (see Gap G-02).
- Async driver (`aioodbc`) requires the ODBC Driver 18 in the Docker image.
