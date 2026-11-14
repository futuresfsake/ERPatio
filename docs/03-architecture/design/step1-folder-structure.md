> **Superseded (2026-11-13).** The stack changed to Express + React + PostgreSQL (ADR-006). Kept as history; see [backend structure](backend-structure.md) and the [app flow](../appflow.md).

Folder Structure

erpatio/
├── backend/
│   ├── alembic/                 # Database migrations
│   ├── app/
│   │   ├── core/                # Config, database session, security/JWT
│   │   ├── models/              # SQLAlchemy ORM models (SQL Server tables)
│   │   ├── schemas/             # Pydantic models for request/response validation
│   │   ├── api/                 # API routers (v1 endpoints)
│   │   │   ├── v1/
│   │   │   │   ├── auth.py
│   │   │   │   ├── users.py
│   │   │   │   └── finance.py
│   │   │   └── api.py
│   │   └── main.py              # FastAPI app initialization
│   ├── Dockerfile
│   ├── requirements.txt         # fastapi, uvicorn, sqlalchemy, aioodbc, alembic, pydantic
│   └── alembic.ini
├── docker-compose.yml
└── README.md