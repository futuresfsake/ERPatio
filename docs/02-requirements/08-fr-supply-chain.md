# 08 — Functional Requirements: Supply Chain & Inventory (SCM)

Traces to: BR-03, BR-04, BR-05, BR-06

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-SCM-01 | Item master: SKU, name, UoM, category, costing method, active flag | Must | SKU unique per tenant |
| FR-SCM-02 | Unit-of-measure conversions | Should | e.g. box ↔ piece |
| FR-SCM-03 | Multiple warehouses and bin locations | Must | Stock tracked per item+warehouse(+bin) |
| FR-SCM-04 | Stock ledger: every movement is an immutable row | Must | On-hand = Σ movements |
| FR-SCM-05 | Goods receipt against a purchase order | Must | Updates stock; posts Dr Inventory, Cr GRNI |
| FR-SCM-06 | Goods issue against a sales order | Must | Posts Dr COGS, Cr Inventory |
| FR-SCM-07 | Inter-warehouse transfers (in-transit state) | Must | Two-step ship/receive |
| FR-SCM-08 | Stock adjustments and cycle counts with reason codes | Must | Variance posts to GL |
| FR-SCM-09 | Valuation: weighted average (v1); FIFO later | Must | Inventory report equals GL balance |
| FR-SCM-10 | Supplier master + purchase requisition → PO → receipt → bill | Must | 3-way match flag (PO/receipt/bill) |
| FR-SCM-11 | Customer master + quotation → sales order → delivery → invoice | Must | Credit-limit warning |
| FR-SCM-12 | Reorder points and low-stock alerts | Should | Notification to Procurement |
| FR-SCM-13 | Lot/serial tracking with expiry | Could | Deferred; see Gaps |
| FR-SCM-14 | Negative stock prevented (tenant setting) | Must | Default: block |
| FR-SCM-15 | Barcode scan input on receipt/issue/count screens | Could | Camera or USB scanner |
| FR-SCM-16 | Reservation/allocation of stock to sales orders | Should | Available = on-hand − reserved |

## Business rules
- BRU-SCM-1: Stock movement and its GL posting commit in one DB transaction (ACID).
- BRU-SCM-2: A document cannot be cancelled once downstream documents exist.
