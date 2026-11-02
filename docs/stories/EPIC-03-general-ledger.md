# EPIC-03 — General Ledger & Finance (Milestone M2)

### US-030 Chart of accounts · 5 pts · Must
As a Finance Manager I want to define a hierarchical chart of accounts so that reports roll up correctly. Traces: FR-FIN-01
- **Given** code `1010` exists **When** I create another `1010` **Then** 409 conflict.

### US-031 CoA starter template · 3 pts · Should
As a new tenant I want a default chart for trading companies so that I can start fast. Traces: FR-TEN-04

### US-032 Draft journal entry · 5 pts · Must
As an Accountant I want to enter a multi-line journal as draft so that I can review before posting. Traces: FR-FIN-02

### US-033 Balanced-entry enforcement · 5 pts · Must
As an auditor I want unbalanced entries rejected so that the ledger is always consistent. Traces: FR-FIN-03
- **Given** debits 100 and credits 90 **When** I post **Then** 422 with the difference; nothing saved.
- DB check/trigger as second line of defence.

### US-034 Post & immutability · 5 pts · Must
As an auditor I want posted entries to be immutable so that history cannot be altered. Traces: FR-FIN-04

### US-035 Reversal entry · 3 pts · Must — FR-FIN-04
### US-036 Fiscal periods · 5 pts · Must — FR-FIN-06
### US-037 Period close & lock · 5 pts · Should — FR-FIN-07
### US-038 Approval workflow · 5 pts · Should — FR-FIN-05
### US-039 Trial balance report · 5 pts · Must — FR-FIN-12
### US-040 Income statement & balance sheet · 8 pts · Must — FR-FIN-12
### US-041 Vendor bills & payments (AP) · 8 pts · Must — FR-FIN-08
### US-042 Customer invoices & receipts (AR) · 8 pts · Must — FR-FIN-09
### US-043 AP/AR aging · 3 pts · Should — FR-FIN-08/09
### US-044 Exchange rates & multi-currency · 8 pts · Should — FR-FIN-10
### US-045 VAT codes · 5 pts · Should — FR-FIN-13
### US-046 Gapless document numbering · 3 pts · Must — BRU-FIN-2
### US-047 Posting-rule engine (auto-posting API) · 8 pts · Must — FR-FIN-15
