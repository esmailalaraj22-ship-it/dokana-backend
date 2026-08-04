# AGENTS.md

## Repository Mission

Build and maintain the **backend only** for an offline-first SaaS application for small-shop accounting and operations.

Approved backend stack:

```text
NestJS -> Drizzle ORM -> PostgreSQL
```

Backend scope includes authentication, stores, memberships, subscriptions, devices, synchronization, restore, sales, purchases, inventory, money accounts, receivables, payables, expenses, owner ledger, returns, accounting periods, reporting, auditing, migrations, security, and tests.

Do **not** implement or modify Flutter, frontend UI, screens, widgets, styling, navigation, or client-side state. SQLite exists here only as a shared-data and synchronization-contract reference.

---

## Architecture Boundaries

```text
Mobile client -> authenticated HTTPS REST API -> NestJS -> Drizzle -> PostgreSQL
```

Non-negotiable rules:

1. Clients never connect directly to PostgreSQL.
2. PostgreSQL is the central source for synchronized server state, restore, devices, subscriptions, and administration.
3. Shared mobile/server records preserve the same UUIDs and business meanings.
4. Financial, inventory, settlement, and synchronization operations are atomic.
5. Replaying the same sync operation must not duplicate effects.
6. Controllers remain thin; services/use-cases own business transactions; repositories own database access.

---

## Canonical Database References

Expected directory:

```text
database/reference/backend_database_reference/
```

Expected files:

```text
shop_ledger_postgresql_v1_all_in_one.sql
sqlite_shop_ledger_schema_v1_1.sql
sqlite_v1_2_settings_patch.sql
sqlite_postgresql_type_mapping.csv
06_runtime_tests.sql
static_validation_report.txt
sqlite_v1_1_integration_guide_ar.md
POSTGRESQL_README_AR.md
```

If this directory is missing, search once for `shop_ledger_postgresql_v1_all_in_one.sql`. If multiple copies exist, report the ambiguity and stop.

Treat the reference package as read-only. Corrections require a versioned migration or replacement artifact plus regression tests.

Source-of-truth priority:

1. Current explicit instruction from the backend owner.
2. Approved PRD and architecture documents in `docs/`.
3. Applied migrations in order.
4. Current Drizzle schema.
5. PostgreSQL all-in-one baseline SQL.
6. SQLite/PostgreSQL mapping and synchronization references.
7. Tests.
8. Existing code only when it does not conflict with a higher source.

Do not invent missing business rules. Report material gaps.

`static_validation_report.txt` proves static checks only. Run `06_runtime_tests.sql` on a real PostgreSQL instance before claiming database production readiness.

---

## PostgreSQL Schema Ownership

```text
platform  users, stores, memberships, devices, sessions, subscriptions, licenses, backups, admin operations
ledger    customers, suppliers, products, sales, purchases, money, inventory, expenses, owner ledger, returns, periods
sync      idempotency, change feed, cursors, conflicts, dead letters, restore snapshots
audit     immutable central audit records
```

Do not move, rename, or repurpose schema objects without a migration, compatibility analysis, and tests.

---

## Mandatory Data Rules

- Persistent IDs use PostgreSQL `uuid`.
- Preserve accepted client-generated UUIDs for shared records.
- Money uses `bigint` minor units; MVP currency is ILS.
- Never use floating point as the authoritative money or stock representation.
- Stock quantities use approved integer milli-units.
- Unit conversions use approved integer numerator/denominator factors.
- Server timestamps use `timestamptz` and UTC.
- Convert epoch milliseconds only at API/sync boundaries.
- Respect store timezone and operational-day settings.
- Shared mutable records use the approved version/concurrency mechanism.
- Reject stale writes explicitly; never silently overwrite them.
- Use `jsonb` only for payloads, metadata, snapshots, or audit details—not to replace relational design.

Use a lossless JSON representation for `bigint` money and quantity fields, normally strings.

---

## Tenant Isolation and RLS

Every store-owned transaction must set transaction-local context:

```sql
SELECT set_config('app.store_id',   :store_id, true);
SELECT set_config('app.user_id',    :user_id, true);
SELECT set_config('app.device_id',  :device_id, true);
SELECT set_config('app.request_id', :request_id, true);
```

Rules:

- Never disable Row-Level Security to fix a query or test.
- Never run the normal application with a PostgreSQL superuser or table-owner role.
- Derive store access from authenticated membership; never trust a request-body `store_id` alone.
- Prevent cross-store foreign-key relationships.
- Add tests proving one store cannot read, mutate, allocate, or reference another store's data.
- Any cross-tenant data leak is a release blocker.

---

## Core Accounting Invariants

### Sales and Customers

- Fully paid anonymous sales are allowed.
- Credit or partial payment requires a customer.
- Customer debt is a receivable, not an expense.
- Credit does not increase a money account.
- Mixed payment creates one payment record per selected account.
- Later debt payment increases only the selected receiving account.
- Allocations cannot exceed the payment amount or remaining receivable.
- Overpayment becomes customer credit or follows an explicit refund flow.

### Money Accounts

- One active cash account per store; multiple bank, wallet, and transfer accounts are allowed.
- Internal transfers are neither revenue nor expense.
- Posted money creates auditable money movements.
- Never overwrite account balances as the source of truth.

### Purchases and Suppliers

- A purchase invoice alone does not increase stock.
- Stock increases only through a posted goods receipt.
- Partial receipt is supported.
- Supplier payment reduces payable and money; it does not create a second expense.
- Allocations cannot exceed the payment amount or remaining payable.

### Inventory

- `inventory_movements` is the source of truth.
- `stock_balances` is a protected cache/projection.
- Movement and cache update occur in one transaction.
- Use row locking or the approved database function.
- Negative stock is allowed only by effective store/product policy.
- Never silently edit stock.

### Cost, Expenses, and Owner Ledger

- Recognize cost of goods sold when goods are sold.
- Unknown cost remains explicitly unknown; zero is not a known cost.
- Paying an already recognized due expense must not recognize it twice.
- Owner withdrawal is not an operating expense.
- Distinguish contribution, owner loan, reimbursement, personal withdrawal, profit withdrawal, and capital withdrawal.

### Returns, Corrections, and Periods

- Returns reference original documents/items where required.
- Correct posted records through reversal and replacement, not silent editing.
- Do not post financial or inventory operations inside a closed period.
- Do not reopen a closed period through ordinary application code.

---

## Transaction Boundaries

The following effects must commit or roll back together:

- Sale, items, payments, money movements, receivable, inventory, stock cache, audit, and sync event.
- Goods receipt, items, inventory, stock cache, payable effect, audit, and sync event.
- Customer/supplier payment, allocations, money or owner-ledger effect, audit, and sync event.
- Return, settlement, money/ledger effect, inventory effect, audit, and sync event.
- Accounting-period close and all validations/audit records.

Do not split one business operation across independent commits. Do not acknowledge sync before commit. Avoid external network calls while holding a database transaction open.

---

## Synchronization Rules

### Push

- Every client mutation carries a stable `operation_id`.
- Claim the operation using the approved idempotency mechanism before applying effects.
- Same ID + same canonical payload must not duplicate effects.
- Same ID + different payload must be rejected and audited.
- Record change-feed events inside the successful transaction.

### Pull and Restore

- Use the approved ordered change feed and cursor.
- Do not infer deletion from missing data; send explicit archive/reversal/deletion events.
- Restore only committed server data.
- Bootstrap must provide a consistent snapshot plus subsequent changes without gaps or duplicates.

### Conflicts

- Never use silent last-write-wins for posted financial, inventory, settlement, or period-closing operations.
- Return explicit conflict data and preserve unresolved cases in approved conflict/dead-letter structures.

---

## NestJS, Drizzle, and SQL Rules

Preferred modules include:

```text
auth, platform, stores, subscriptions, devices, sync,
customers, suppliers, products, sales, purchases, inventory,
money-accounts, expenses, owner-ledger, returns,
accounting-periods, reports, audit
```

Rules:

- Keep SQL out of controllers.
- Prefer explicit posting use-cases over generic CRUD for financial operations.
- Validate every external input with DTO/runtime validation.
- Use parameterized queries.
- Raw SQL is allowed only for PostgreSQL features or justified performance needs; isolate, document, parameterize, and test it.
- Drizzle schema must match the applied PostgreSQL schema.
- Preserve advanced SQL objects that Drizzle cannot fully express: RLS, policies, functions, triggers, partial indexes, and grants.
- Review generated SQL before applying it.

---

## Migration Policy

- Never edit an applied migration.
- Every schema change requires a new migration.
- Test migrations from an empty database and from the previous released version.
- Use expand-migrate-contract for destructive changes.
- Backfill before adding required constraints when old data may violate them.
- Do not remove or rename synchronized fields until compatibility is proven.
- Update mapping and sync documentation when shared fields change.
- Add regression tests for every database defect.
- The all-in-one SQL file is the initial baseline, not the mechanism for future changes.

---

## Security and API Rules

Never:

- commit `.env`, passwords, tokens, private/signing keys, production dumps, or real customer data;
- concatenate user input into SQL;
- log passwords, access/refresh tokens, or secret license data;
- trust client totals, balances, costs, roles, store IDs, or subscription status;
- expose another tenant's existence through detailed errors;
- weaken RLS, triggers, constraints, or tests to make a change pass.

API rules:

- Preserve UUIDs exactly.
- Use lossless `bigint` representations.
- Use stable documented error codes.
- Use deterministic pagination ordering.
- Mutation responses include required version/idempotency metadata.
- Never expose SQL errors, stack traces, secrets, or cross-tenant identifiers.
- Roll back after any partial financial failure.

At minimum distinguish authentication, authorization, tenant isolation, validation, not found, idempotent replay, payload mismatch, stale conflict, insufficient stock, credit-limit violation, closed period, invalid allocation, subscription/license restriction, database unavailable, and unexpected internal error.

---

## Required Tests

Before database production approval, execute:

```text
database/reference/backend_database_reference/06_runtime_tests.sql
```

Required categories:

- domain unit tests;
- PostgreSQL repository integration tests;
- migration tests;
- RLS/tenant-isolation tests;
- rollback tests;
- idempotency replay and payload-mismatch tests;
- separate-connection concurrency tests;
- accounting scenario tests;
- sync push/pull/bootstrap/conflict/retry tests;
- authentication, authorization, subscription, and device tests;
- backup/restore tests;
- critical API end-to-end tests.

Critical scenarios include cash, bank/wallet, mixed and credit sales; later debt payment; overpayment; purchase without stock change; partial receipt; supplier payment; owner-paid obligations; customer/supplier returns; stock count; negative stock; unknown cost; closed periods; reversal/replacement; duplicate sync; payload mismatch; concurrent stock and allocation updates; cross-store attempts; and new-device restore.

Tests must assert balances and ledger side effects, not only HTTP status codes. Do not mock database integrity, RLS, locking, migrations, or transactions.

---

## Agent Workflow

For every non-trivial task:

1. Read this file and relevant source documents.
2. Inspect existing code and migrations before editing.
3. Identify accounting, tenancy, sync, security, and compatibility impact.
4. State a short plan.
5. Make the smallest complete change.
6. Add or update tests alongside the change.
7. Run repository-defined commands from `package.json`; do not guess script names.
8. Fix root causes; do not bypass constraints or weaken tests.
9. Review the diff for unrelated changes, secrets, destructive SQL, and tenant risk.
10. Update documentation when behavior, schema, setup, or contracts change.
11. Report exactly what ran and what remains unverified.

Do not perform broad refactors during a focused task unless required for correctness and explicitly explained.

---

## High-Risk Change Gate

High-risk areas: money/quantity representation, posting, reversals, allocations, balances, costing, stock locking, period closing, sync/idempotency, RLS, auth, subscriptions/licenses, backup/restore, destructive migrations, encryption/signing, and audit immutability.

For high-risk changes:

- add happy-path, rejection, duplicate, rollback, cross-tenant, and concurrency tests as applicable;
- document migration and backward-compatibility impact;
- request backend-owner review before claiming production readiness;
- clearly state when runtime verification was not performed.

Suggested review roles:

```text
Codex         implementation, migrations, tests
Kimi K3       review against PRD, contracts, and repository rules
Fable 5       high-risk accounting, sync, security, closing, restore, subscriptions
Backend owner final approval
```

---

## Definition of Done

A task is complete only when all applicable conditions are met:

- behavior matches the approved requirement;
- schema changes use a reviewed migration;
- RLS, constraints, and advanced database objects remain intact;
- relevant tests were added and executed;
- accounting balances, side effects, rollback, and duplicate behavior were asserted;
- synchronization compatibility was reviewed;
- no secrets or real customer data were added;
- documentation was updated;
- unrelated files were not changed;
- unexecuted tests and remaining risks are disclosed.

Do not claim “fully verified”, “production ready”, or “no issues” unless required PostgreSQL runtime, migration, security, concurrency, and scenario tests actually passed.

Final coding reports must include: implemented behavior, main files changed, migration name, tests and exact results, tests not run and why, compatibility impact, and remaining risk.
