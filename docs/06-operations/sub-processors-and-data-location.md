# Sub-processors and data location (FR-PRV-11, US-125)

Services that can touch ERPatio data or traffic. Update this file before adding a new one.

| Sub-processor | Purpose | Data it can see | Region | Status |
|---|---|---|---|---|
| Neon (PostgreSQL) | Database hosting, encrypted at rest, backups | Everything in the database. Sensitive-personal fields will be application-encrypted before they reach it (ADR-005, not built yet) | Singapore (`aws-ap-southeast-1`) once the project is created | Planned |
| Render | Application hosting, TLS termination, logs | Request metadata and application logs (emails and tokens are masked before logging) | Singapore | Planned |
| GitHub | Source code, CI, nightly demo reset | Source and CI logs. The demo reset sees the Neon direct string as a secret | United States | In use |

Not used: analytics, error-reporting SaaS, e-mail provider (none yet; arrives with US-120), fonts CDN (fonts are self-hosted), payment provider.

Data location: customer data stays in the Singapore region (Gap G-11 recommendation: PH/SEA). GitHub holds code only, never customer data.
