# 01 — Product Vision

**Owner:** Product Owner (PO) · **Author:** Business Analyst (BA) · **Status:** Draft v0.1 · **Date:** 2026-11-02

## Vision statement
ERPatio is a modular, cloud-hosted ERP **delivered as SaaS** for small and mid-sized businesses (50–500 staff) that have outgrown spreadsheets but cannot afford or staff a legacy ERP implementation.

## Problem
SMEs run finance in one tool, stock in spreadsheets, payroll by hand. Month-end close takes 8–12 days, stock counts disagree with the books, and nobody trusts the numbers.

## Product goals (12 months)
| # | Goal | Measure |
|---|------|---------|
| G1 | One source of truth for money and stock | Inventory valuation reconciles to GL with 0 variance |
| G2 | Fast close | Month-end close ≤ 3 business days |
| G3 | Self-service onboarding | New tenant live in < 1 day, no consultant |
| G4 | Trustworthy audit trail | 100% of postings traceable to user + document |

## Positioning
- **Modular:** FIN, SCM, PRD, HCM, BI — tenants subscribe per module.
- **Open "patio":** documented REST API, webhooks, exportable data.
- **Strict accounting integrity:** double-entry enforced at DB and service layer.

## Out of scope (v1)
CRM, e-commerce storefront, tax-authority e-filing integrations, mobile native apps, localisation beyond PHP/USD.

## Related
[02 Deployment model decision](02-deployment-model-decision.md) · [05 Business requirements](05-business-requirements.md)
