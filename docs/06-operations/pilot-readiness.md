# Pilot readiness

Status on 2026-11-14. The pilot customer is the simulated CVTC profile (`01-product/03-simulated-customer-profile.md`):
**close the books in 3 days or fewer, stock variance under 1%, a payroll run in under an hour, all users trained in two sessions.**
This page is the honest list of what is ready, what the software now measures for those criteria, and what must happen before real money or real people's data go in.

## The four pilot criteria

| Criterion | What the software gives | Measured how | Status |
|---|---|---|---|
| Close in 3 days or fewer | Fiscal periods with close and lock, year-end close into retained earnings, bank reconciliation, aging and tax reports, drafts that block a close | Count the steps for one month: reconcile bank (import, auto-match, post fees), clear drafts, run aging and tax reports, close the period. Each is one screen | Ready to trial; timing is for the pilot to record |
| Stock variance under 1% | Stock valuation report that equals the inventory account to the cent; a stock entry cannot be reversed by hand, so book and stock cannot drift | `Reports > Stock valuation` shows the variance; the test suite asserts it is zero after receipts, deliveries, returns, adjustments and production | Variance of the books against the ledger is 0 by construction. Physical-count variance needs the pilot's stock counts through Adjustments |
| Payroll run in under an hour | Attendance with shifts, statutory rules as data, a payroll run computed in one request, approval by a second person, posting and payment in two clicks | Create run, review warnings, approve, pay | **Not ready for real pay**: rates must be confirmed by an accountant (audit F-53) and 13th month, leave, loans, bank file and government reports are missing (F-54) |
| Users trained in two sessions | One consistent screen pattern, plain language, role-based menus, a demo workspace with sample data in every module | Walk the demo workspace with each role | Ready to trial |

## Before any real data goes in

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Deploy to Render and Neon and run the deployment checklist (`deployment-render-neon.md`) | Owner | Not done: needs the owner's accounts. Nothing has run on real hosting yet (audit F-01, F-02) |
| 2 | Restore drill from a real Neon backup, timed, using `runbook-backup-restore.md` | Owner and engineer | A local dump-and-restore drill passes (`scripts/restore-drill.sh`); the Neon drill is not done |
| 3 | Breach tabletop using `runbook-breach-response.md` | Owner | Not done |
| 4 | Sign off the threat model (`03-architecture/23-threat-model.md`) | Owner | Not done |
| 5 | Legal review of privacy notice, terms and the payroll rules (G-21), and a licence decision (G-15) | Owner | Not done |
| 6 | Accountant confirms statutory rates, withholding brackets and the VAT code (F-53) | Accountant | Not done |
| 7 | A real mail provider is configured, one real message sent, and one Have I Been Pwned range call made (F-30) | Engineer | Not done |
| 8 | Outside penetration test | Owner | Not done. The internal break-it check and the generated authorization matrix are not a substitute |
| 9 | Browser and end-to-end checks of every screen on phone and desktop (F-11, F-23, F-39, F-46) | Engineer | Smoke test only; screens were checked by type-check, lint and build |
| 10 | Turn on branch protection so no change reaches `main` without the checks (F-34) | Owner | Not done |
| 11 | Set the master key, rotate JWT secrets, and store them in the host's secret store | Owner | Not done |
| 12 | Decide who is the privacy contact and who can approve payroll | Owner | Not done |

## What changed in hardening

- A generated authorization matrix calls every protected route with no token, with a person who holds no permission, and as a viewer, and fails on any wrong answer or server error. A new route is covered the day it is added.
- A break-it check (`scripts/break-it.mjs`) breaks 39 money- and security-critical rules one at a time and fails if the tests do not notice.
- Hot queries were measured on a large synthetic ledger and indexed where they were slow (see the audit).
- A local backup and restore drill proves that a dump restores to the same row counts and the same ledger totals.

## Known limits of the pilot build

- One stock location per workspace (F-42); single currency (ADR-011); no payment collection (F-63).
- Webhooks and the cache run inside the web process (F-57, F-61).
- Payroll excludes 13th month, leave balances, loans, bank files and statutory reports (F-54).
