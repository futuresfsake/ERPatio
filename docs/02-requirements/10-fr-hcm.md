# 10 — Functional Requirements: Human Capital (HCM)

Traces to: BR-08

| ID | Requirement | Priority | Acceptance summary |
|---|---|---|---|
| FR-HCM-01 | Employee master (personal, employment, department, position) | Must | Sensitive fields restricted to HRManager |
| FR-HCM-02 | Departments & cost centers | Should | Linked to GL dimensions |
| FR-HCM-03 | Shift definitions and weekly schedule | Must | Conflict/overlap detection |
| FR-HCM-04 | Attendance capture (manual entry, CSV import) | Must | Late/undertime computed |
| FR-HCM-05 | Leave types, balances, request/approve | Should | Balance never negative unless allowed |
| FR-HCM-06 | Pay components: basic, allowances, deductions | Must | Configurable per employee |
| FR-HCM-07 | Payroll run per cut-off: compute, review, approve, lock | Must | Reproducible; locked run immutable |
| FR-HCM-08 | Statutory deductions table (configurable, not hardcoded) | Must | Rates versioned by effective date |
| FR-HCM-09 | Payslip generation (PDF) | Should | Employee self-view |
| FR-HCM-10 | Payroll posting to GL | Must | Dr Salaries Exp, Cr Payable/Withholding |
| FR-HCM-11 | Bank payout file export | Could | Format per bank; see Gaps |
| FR-HCM-12 | Employee self-service portal | Could | View payslip, leave |

## Compliance note
Payroll law varies by country; v1 ships with a configurable rules engine and a **PH sample ruleset flagged "not legal advice"** — see Gaps G-07.
