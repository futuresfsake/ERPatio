# 09 — Functional Requirements: Manufacturing & Production (PRD)

Traces to: BR-07

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-PRD-01 | Multi-level Bill of Materials with versioning | Must | One active version per item at a time |
| FR-PRD-02 | BOM component quantities with scrap % | Should | Required qty = qty × (1 + scrap) |
| FR-PRD-03 | Work centers and routing (operation sequence, std time) | Should | Routing linked to item |
| FR-PRD-04 | Create work order from BOM + quantity + due date | Must | Status: Draft → Released → In Progress → Completed → Closed |
| FR-PRD-05 | Component availability check at release | Must | Shortage report shown |
| FR-PRD-06 | Issue materials to a work order | Must | Stock out of warehouse into WIP |
| FR-PRD-07 | Report completed output and receive finished goods | Must | Stock in; WIP relieved |
| FR-PRD-08 | WIP and production variance accounting | Should | Posts to WIP and variance accounts |
| FR-PRD-09 | Backflush (auto-issue on completion) option | Could | Per-BOM setting |
| FR-PRD-10 | Shop-floor status updates per operation | Could | Simple tablet screen |
| FR-PRD-11 | Simple MRP: suggest purchase for shortages | Could | Deferred; see Gaps |

## Dependencies
Requires SCM item master & stock ledger and FIN posting engine.
