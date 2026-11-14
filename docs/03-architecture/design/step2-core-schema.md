> Implemented in `backend/migrations/001_platform_tenancy_identity.sql` and `002_general_ledger.sql` (PostgreSQL). Tables and rules differ in detail from this first sketch; the migrations are the source of truth.

Step 2: Designing the Core Database Schema
Here is how our relational tables map out for Users/Auth and the General Ledger:

1. Users & Roles (IAM)
users table: Stores user profile info, hashed passwords, and active status.

roles & user_roles tables: Implements Role-Based Access Control (RBAC) so you can assign roles like Accountant, InventoryManager, or Admin.

2. General Ledger (FIN)
accounts table (Chart of Accounts): Defines ledger accounts (e.g., Assets, Liabilities, Revenue, Expenses) with account codes and types.

journal_entries table: Represents a header for financial transactions (date, description, reference).

journal_entry_lines table: The individual debit and credit rows tied to a journal entry. Crucial rule for accounting: Total debits must equal total credits per entry.