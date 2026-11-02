# 07 — Functional Requirements: Finance (FIN)

Traces to: BR-02, BR-03, BR-05, BR-06, BR-10

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-FIN-01 | Maintain a hierarchical Chart of Accounts (type: Asset, Liability, Equity, Revenue, Expense) | Must | Unique code per tenant; parent/child rollups |
| FR-FIN-02 | Create journal entries with ≥ 2 lines | Must | Header: date, reference, description |
| FR-FIN-03 | Reject any entry where Σdebits ≠ Σcredits | Must | Enforced in service AND DB constraint/trigger |
| FR-FIN-04 | Posted entries are immutable; corrections via reversing entry | Must | Edit/delete of posted returns 409 |
| FR-FIN-05 | Draft → Posted workflow with optional approval | Should | Approver ≠ creator when enabled |
| FR-FIN-06 | Fiscal years and periods; open/closed status | Must | Posting to closed period rejected |
| FR-FIN-07 | Period close checklist and lock | Should | Unposted drafts block close |
| FR-FIN-08 | Accounts Payable: vendor bills, payment, aging | Must | Bill posts Dr Expense/Inventory, Cr AP |
| FR-FIN-09 | Accounts Receivable: customer invoices, receipts, aging | Must | Invoice posts Dr AR, Cr Revenue |
| FR-FIN-10 | Multi-currency transactions with exchange-rate table | Should | Stored in txn + base currency |
| FR-FIN-11 | Unrealised FX revaluation at period end | Could | Generates adjusting entry |
| FR-FIN-12 | Reports: Trial Balance, Income Statement, Balance Sheet, GL detail | Must | Export CSV/PDF; ties to ledger |
| FR-FIN-13 | Tax codes (VAT) on invoices/bills | Should | Configurable rates; VAT report |
| FR-FIN-14 | Bank reconciliation (manual match) | Could | Imports CSV statement |
| FR-FIN-15 | Auto-posting from SCM/HCM events via posting rules | Must | See dependency map |
| FR-FIN-16 | Attachments on documents | Could | Stored in object storage |

## Business rules
- BRU-FIN-1: amounts stored as `DECIMAL(19,4)`; never float.
- BRU-FIN-2: document numbers are gapless per tenant per type.
- BRU-FIN-3: every posting records `created_by`, `posted_by`, timestamps.
