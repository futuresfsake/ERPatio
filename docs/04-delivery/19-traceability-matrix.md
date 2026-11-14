# 19 — Traceability Matrix

BR → FR → Epic/Story → Milestone. Gaps in this table = untested or unbuilt requirements.

| BR | FR group | Stories | Milestone | Test level |
|---|---|---|---|---|
| BR-01 | FR-IAM-01…12, FR-AUT-01…07 | US-011–015, 018, 020, 023, 120–124 (M0); US-016, 017, 024 (M1) | M0–M1 | Unit + API + security |
| BR-02 | FR-FIN-01…07, 12 | US-030–040, 046 | M2 | Unit + DB constraint + E2E |
| BR-03 | FR-SCM-04/09, FR-FIN-15 | US-047, 052, 055, 060, 064, 065 | M2–M3 | Integration + nightly recon |
| BR-04 | FR-SCM-03/04/07/08/14 | US-051, 052, 061–063 | M3 | Integration |
| BR-05 | FR-SCM-05/10, FR-FIN-08 | US-053–056, 041 | M2–M3 | E2E |
| BR-06 | FR-SCM-06/11/16, FR-FIN-09 | US-057–060, 042 | M2–M3 | E2E |
| BR-07 | FR-PRD-01…11 | US-070–077 | M4 | Integration |
| BR-08 | FR-HCM-01…12 | US-080–089 | M5 | Integration + golden payroll cases |
| BR-09 | FR-BI-01…08 | US-090–094 | M6 | UI + perf |
| BR-10 | FR-FIN-10/11 | US-044 | M2 | Unit |
| BR-11 | FR-TEN-01…14 | US-010, 019 (M0); US-021, 022 (M1) | M0–M1 | Automated leak tests |
| BR-12 | FR-TEN-04, FR-DAT-01/02/04 | US-010, 031, 095 | M1–M6 | E2E |
| BR-13 | FR-API-01…05 | US-008, 097, 098 | M0, M6 | Contract tests |
| BR-14 | FR-DAT-03 | US-096 | M6 | E2E |
| BR-15 | FR-SEC-01…13, FR-AUT-* | US-100–109, 120–124 | M0 | SAST/DAST, header scan, pen-test (M7) |
| BR-16 | FR-PRV-01…13 | US-110–119, 125 | M0 (payroll data in M5) | Automated + tabletop |

## Coverage check
- All 16 BRs map to ≥ 1 FR and ≥ 1 story. 
- NFRs are verified at M7 (load, pen-test, restore drill) — tracked as release gates, not stories.
