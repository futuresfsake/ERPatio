# ADR-011: Credit and debit notes, bank reconciliation, printing, and currency

Status: accepted, 2026-11-14

## Decisions

**Credit and debit notes** use the same document engine as invoices and bills (kind `credit_note`, `debit_note`). Posting writes the mirror-image entry. A note is used up by *applying* it to open invoices or bills; an application writes no ledger entry, because both sides already sit in the control account. Applications are append-only; the documents carry running totals. Open notes show as negative items in aging, so aging still equals the control account. A note that has been applied cannot be voided, and an invoice or bill with an application cannot be voided. An application cannot be undone; void and reissue before applying.

**Bank reconciliation** matches imported statement lines one to one with ledger lines of the same account and the same signed amount. Imports are idempotent (a content fingerprint plus an occurrence number, so a re-import adds nothing and two genuinely identical lines in one file are both kept). Automatic matching accepts only unambiguous pairs (one candidate each way within seven days); everything doubtful is left for a person. A line with no counterpart (a fee) is posted from the statement through the normal posting path, so period locks and the audit log apply. Statement lines are append-only.

**PDF output** is the browser's print dialog with a print stylesheet ("Save as PDF"). No server-side PDF library is added: it would be a new dependency in the request path and a new surface for injection through document text, for a result that the browser produces already.

**Currency**: the workspace is single-currency (PHP). Multi-currency (rates, revaluation, realised and unrealised gains) is deliberately not built. It touches every posting path, and a half-built version would be worse than none because it could produce books that look right and are not. Revisit when a pilot customer trades in a foreign currency; the design would add a currency and a rate to documents and postings, store both amounts, and add a revaluation entry at period end.

## Consequences
- Statement balances are not entered; the report shows the difference between the ledger and the imported statement and says whether the unmatched lines explain it. This assumes the imported statement starts where the books do (audit F-47).
- Printing depends on the browser's print engine; layout is checked by eye only.
