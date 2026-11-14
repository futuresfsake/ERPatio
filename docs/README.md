# ERPatio Documentation

> Business analysis was produced against a **simulated customer** (no real customer yet). Replace assumptions with discovery findings as they arrive. Folders follow the order a reader needs them: why, what, how, when, who decides, how it runs, how good it is.

## Start here
| If you want to… | Read |
|---|---|
| See how a person uses the app and what the system does | [App flow](03-architecture/appflow.md) |
| Click through the interface | [HTML prototype](03-architecture/design/prototype/erpatio-prototype.html) (the first 8 screens; periods, drafts, statements and settings exist only in the real app) |
| Know what is done and what is not | [DoD audit](07-quality/audit-dod.md) |
| Deploy it | [Render + Neon runbook](06-operations/deployment-render-neon.md) |

## 01 Product: why
[Vision](01-product/01-product-vision.md) · [Deployment model](01-product/02-deployment-model-decision.md) · [Simulated customer](01-product/03-simulated-customer-profile.md) · [Stakeholders & personas](01-product/04-stakeholders-and-personas.md) · [Glossary](01-product/21-glossary.md)

## 02 Requirements: what
[Business requirements](02-requirements/05-business-requirements.md) · FR: [IAM](02-requirements/06-fr-iam.md) · [Finance](02-requirements/07-fr-finance.md) · [Supply chain](02-requirements/08-fr-supply-chain.md) · [Production](02-requirements/09-fr-production.md) · [HCM](02-requirements/10-fr-hcm.md) · [BI/API/Data](02-requirements/11-fr-bi-and-platform.md) · [Non-functional](02-requirements/12-non-functional-requirements.md) · [Multi-tenancy](02-requirements/13-multi-tenancy-and-saas-requirements.md) · [Security & privacy](02-requirements/22-fr-security-and-data-privacy.md)

## 03 Architecture: how
- Decisions (ADRs): [001 SaaS](03-architecture/adr/ADR-001-saas-delivery-model.md) · [002 tenant isolation](03-architecture/adr/ADR-002-tenant-isolation-strategy.md) · [003 ledger integrity](03-architecture/adr/ADR-003-ledger-integrity.md) · [004 authentication](03-architecture/adr/ADR-004-authentication-design.md) · [005 privacy by design](03-architecture/adr/ADR-005-privacy-by-design.md) · [006 technology stack](03-architecture/adr/ADR-006-technology-stack.md) · [007 hosting](03-architecture/adr/ADR-007-hosting-render-neon.md) · [008 public demo](03-architecture/adr/ADR-008-public-demo-workspace.md) · [009 drafts, periods, approval](03-architecture/adr/ADR-009-drafts-periods-and-approval.md)
- [App flow](03-architecture/appflow.md) · [Threat model](03-architecture/23-threat-model.md) · [Data classification register](03-architecture/data-classification-register.md)
- Design: [Backend structure](03-architecture/design/backend-structure.md) · [UI design system](03-architecture/design/ui-design-system.md) · [Prototype](03-architecture/design/prototype/erpatio-prototype.html) · history: [initial plan](03-architecture/design/initial-technical-plan.md), [folder sketch](03-architecture/design/step1-folder-structure.md), [schema sketch](03-architecture/design/step2-core-schema.md)

## 04 Delivery: when
[Backlog index](04-delivery/14-backlog-index.md) (epics in `stories/`) · [Milestones](04-delivery/15-milestones-roadmap.md) · [Dependencies](04-delivery/16-dependency-map.md) · [Traceability](04-delivery/19-traceability-matrix.md) · [Definition of Ready/Done](04-delivery/20-definition-of-done.md)

## 05 Governance: who decides
[**Gaps for the PO**](05-governance/17-gaps-and-open-questions-for-po.md) · [Risks & assumptions](05-governance/18-risks-and-assumptions.md)

## 06 Operations: how it runs
[Deployment runbook](06-operations/deployment-render-neon.md) · [Sub-processors and data location](06-operations/sub-processors-and-data-location.md)

## 07 Quality: how good it is
[Definition-of-Done audit](07-quality/audit-dod.md)

## Document control
Versioning via git history. Numbers in file names (`05-`, `22-`) are stable IDs used in cross-references such as "doc 22"; folders group them.
