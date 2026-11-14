# 20 — Definition of Ready / Done

## Definition of Ready (story may enter a sprint)
- [ ] Acceptance criteria in Given/When/Then
- [ ] Traces to ≥ 1 FR/NFR
- [ ] Dependencies (doc 16) satisfied or scheduled
- [ ] No blocking PO question (doc 17)
- [ ] Estimated ≤ 13 points

## Definition of Done
- [ ] Code reviewed via PR; CI green (lint, tests, build)
- [ ] Unit tests for business rules; integration test for DB-touching flow
- [ ] Tenant isolation verified (leak test) for any new table/endpoint
- [ ] Migration (`backend/migrations/*.sql`) included with a working down step
- [ ] Permission check declared on every endpoint
- [ ] Money uses `Decimal`; no float
- [ ] Audit log written for state-changing financial/IAM actions
- [ ] OpenAPI docs updated
- [ ] No secrets in diff (scanner passes)
- [ ] Docs/ADR updated; traceability matrix row updated
- [ ] Demo'd to PO and accepted against the acceptance criteria
