# EPIC-04 — Supply Chain & Inventory (Milestone M3)

### US-050 Item master · 5 pts · Must — FR-SCM-01
As an Inventory Manager I want to create items with SKU, UoM and category so that stock is identifiable.

### US-051 Warehouses & bins · 3 pts · Must — FR-SCM-03
### US-052 Immutable stock ledger · 8 pts · Must — FR-SCM-04
As an auditor I want every movement stored as an append-only row so that on-hand can be proven.
- **Then** on-hand per item/warehouse = Σ movements, verified by nightly check.

### US-053 Supplier master · 3 pts · Must — FR-SCM-10
### US-054 Purchase order lifecycle · 8 pts · Must — FR-SCM-10
### US-055 Goods receipt with GL posting · 8 pts · Must
As a Warehouse Supervisor I want to receive goods against a PO so that stock and ledger update together.
- **Then** one transaction: stock +qty and Dr Inventory / Cr GRNI. Failure rolls back both. Traces: FR-SCM-05, BRU-SCM-1

### US-056 Three-way match · 5 pts · Should — FR-SCM-10
### US-057 Customer master · 3 pts · Must — FR-SCM-11
### US-058 Quotation → sales order · 5 pts · Must — FR-SCM-11
### US-059 Stock reservation · 5 pts · Should — FR-SCM-16
### US-060 Delivery with COGS posting · 8 pts · Must — FR-SCM-06
### US-061 Block negative stock · 2 pts · Must — FR-SCM-14
### US-062 Inter-warehouse transfer (in-transit) · 5 pts · Must — FR-SCM-07
### US-063 Adjustments & cycle count · 5 pts · Must — FR-SCM-08
### US-064 Weighted-average costing · 8 pts · Must — FR-SCM-09
### US-065 Inventory-to-GL reconciliation report · 5 pts · Must
As a Finance Manager I want a report proving inventory value equals the GL so that I trust the close. Traces: BR-03
### US-066 Reorder alerts · 3 pts · Should — FR-SCM-12
### US-067 Barcode input · 3 pts · Could — FR-SCM-15
### US-068 UoM conversions · 3 pts · Should — FR-SCM-02
