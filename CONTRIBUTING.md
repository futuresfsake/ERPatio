# Contributing to ERPatio

## Workflow
1. Pick a story from `docs/stories/` that is *Ready* (see `docs/20-definition-of-done.md`).
2. Branch: `feat/US-033-balanced-entry`.
3. Small commits using Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
4. Open a PR that references the story ID and FR IDs; fill in the PR template.
5. CI must be green; at least one review.

## Rules
- No secrets in commits.
- Money is `Decimal`, never float.
- Every new table has `tenant_id`; add a cross-tenant test.
- Update docs and the traceability matrix when scope changes.
