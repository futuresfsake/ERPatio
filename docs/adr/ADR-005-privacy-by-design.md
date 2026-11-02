# ADR-005: Privacy by design

- **Status:** Proposed · **Date:** 2026-11-02

## Decision
1. Classify every column (FR-PRV-01); the register is generated from model metadata and checked in CI.
2. Sensitive-Personal fields use **application-level envelope encryption** (data key per tenant, wrapped by a master key) so DB admins and backups never see plaintext.
3. Personal data is **pseudonymised, not deleted**, when it is entangled with financial records: a `person` row is replaced by a pseudonym while ledger rows remain.
4. PII is forbidden in logs, URLs and cache keys; a log filter and test enforce this.
5. Reads of Sensitive-Personal data are audited.
6. Non-production uses synthetic data only.

## Consequences
- Encrypted fields cannot be searched or sorted by SQL; use blind indexes (HMAC) where lookup is required.
- Key loss = data loss: key backup and rotation procedures are part of M0.
- Legal retention vs erasure conflicts are resolved by BRU-PRV-1 (Gap G-21).
