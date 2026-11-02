# ERPatio

## Overview
ERPatio is a full-stack, modular Enterprise Resource Planning (ERP) platform designed to centralize and automate core business operations—ranging from General Ledger accounting and Supply Chain management to Human Resources and Production routing. 

Unlike legacy enterprise systems that lock data behind heavy monolithic walls, ERPatio provides a clean, open architectural playground ("the patio") built for seamless data flow, strict ACID compliance, and high-performance extensibility.

## Key Modules
1. **Financial Management (FIN):** General Ledger, Accounts Payable/Receivable, and multi-currency tracking.
2. **Supply Chain & Inventory (SCM):** Multi-warehouse stock tracking, procurement workflows, and order fulfillment.
3. **Human Capital Management (HCM):** Personnel records, payroll processing, and shift scheduling.
4. **Manufacturing & Production (PRD):** Bill of Materials (BOM), work orders, shop floor control, and routing.
5. **Business Intelligence (BI):** Real-time executive dashboards and custom operational reporting.

## Technology Stack
* **Frontend:** Next.js (TypeScript) for high-performance, type-safe UI components.
* **Backend:** Python (FastAPI) for asynchronous, high-throughput enterprise logic and auto-generated API docs.
* **Database:** SQL Server for bulletproof relational integrity and financial ledger compliance.
* **Caching & Queueing:** Redis for session management, fast read caching, and background task orchestration.
* **Infrastructure:** Docker & Docker Compose for containerized environment parity across development and production.
## Documentation
Full business-analysis documentation (vision, requirements, stories, milestones, dependencies, PO gaps) lives in [`docs/`](docs/README.md).
