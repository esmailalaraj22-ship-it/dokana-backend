# AGENTS.md

## Purpose

This file contains the permanent repository instructions for every implementation or review agent.

A task prompt defines the current objective. This file defines the rules that always apply.

If a task conflicts with this file or with an approved backend-owner decision, stop, explain the conflict, and wait for approval. Do not silently choose an interpretation.

---

## Project

This repository contains the **backend only** for an offline-first SaaS application for small-shop accounting and operations.

The product is intentionally simpler than a full ERP, but it must remain reliable, auditable, secure, multi-tenant, and suitable for real financial and inventory records.

Approved backend stack:

```text
NestJS
TypeScript
Drizzle ORM
PostgreSQL
REST APIs
```

The mobile application uses SQLite locally for offline operation. SQLite is a shared-data and synchronization-contract reference only; mobile implementation is outside this repository.

Backend scope includes authentication, stores, memberships, devices, subscriptions, customers, suppliers, products, sales, receivables, payments, supplier invoices, payables, manual inventory operations, costing, expenses, owner ledger, returns, corrections, accounting periods, synchronization, backup, restore, reports, audit, migrations, security, observability, and tests.

Do not implement Flutter, frontend UI, screens, widgets, styling, navigation, or client-side state here.

---

## Architecture Boundaries

```text
Mobile client
    -> authenticated HTTPS REST API
    -> NestJS
    -> Drizzle ORM or justified parameterized SQL
    -> PostgreSQL
```

Rules:

- Clients never connect directly to PostgreSQL.
- Controllers remain thin.
- Services or use cases own workflows and transactions.
- Database services or repositories own persistence access.
- Cross-cutting infrastructure must not contain hidden business logic.
- Financial, inventory, settlement, and synchronization operations are atomic.
- Replaying the same synchronization operation must not duplicate effects.
- Do not add speculative abstractions or future business logic without a current need.

---

## Sources of Truth

Use this priority when sources differ:

1. Current explicit backend-owner decision.
2. Approved decisions in this file.
3. Approved PRD and architecture documents under `docs/`.
4. Applied migrations in chronological order.
5. Current reviewed Drizzle schema.
6. Approved PostgreSQL baseline.
7. SQLite/PostgreSQL mapping and sync references.
8. Tests.
9. Existing code only when consistent with higher sources.

When a material conflict exists:

- identify the conflicting sources;
- explain the impact;
- recommend the smallest safe resolution;
- wait for backend-owner approval.

Do not invent missing business rules.

## Approved Product Requirements

The current approved product requirements document is:

```text
docs/product/Dokana_PRD_v1.1_APPROVED.md
```

Rules:

- Read the approved PRD completely before planning or implementing work that introduces, changes, or interprets product or business behavior.
- Older PRD versions are historical only and must not be treated as the current product authority.
- Do not copy product rules from stale documentation when a newer backend-owner decision or approved rule in this file explicitly supersedes them.
- The approved supplier rule in this file intentionally supersedes older supplier-receipt or partial-receipt requirements.
- Do not infer missing product policy from nullable columns, schema capability, implementation accidents, or test fixtures.
- If this file, the approved PRD, applied migrations, the reviewed Drizzle schema, or the approved database reference materially disagree, identify the conflict and wait for backend-owner approval rather than silently choosing an interpretation.

---

## Database References

Expected location:

```text
database/reference/backend_database_reference/
```

Treat the reference package as read-only.

Important rules:

- The all-in-one PostgreSQL SQL file is the initialization baseline, not the future migration mechanism.
- Do not rerun the baseline against a non-empty database without explicit approval for a disposable rebuild.
- Do not silently rewrite or repair reference files.
- Future schema changes require versioned migrations.
- Static validation does not prove runtime correctness.
- Run `06_runtime_tests.sql` against a disposable real PostgreSQL environment before claiming database runtime readiness.

Expected PostgreSQL schema responsibilities:

```text
platform  server-only identity/authentication, memberships, subscriptions/licenses,
          backup and administration objects
ledger    stores, devices, customers, suppliers, products, sales, supplier invoices,
          money, inventory, expenses, owner ledger, returns, accounting periods
sync      idempotency, change feed, cursors, conflicts, bootstrap, restore
audit     immutable central audit records
```

`ledger.stores` and `ledger.devices` are deliberate parts of the approved database contract. Do not relocate or duplicate them merely to match conceptual product grouping.

Do not rename, move, repurpose, or duplicate schema objects without an approved migration, compatibility analysis, tests, and remediation guidance.

---

## Data Rules

- Persistent identifiers use PostgreSQL `uuid`.
- Preserve accepted client-generated UUIDs for synchronized records.
- Money uses `bigint` minor units.
- MVP currency is ILS unless explicitly changed.
- Never use floating point as the authoritative money representation.
- Stock quantities use approved integer milli-units.
- Unit conversions use approved integer numerator/denominator factors.
- PostgreSQL timestamps use `timestamptz` in UTC.
- Respect store timezone and operational-day settings.
- Shared mutable records use the approved concurrency/version mechanism.
- Reject stale writes explicitly.
- Never silently overwrite posted financial or inventory state.
- Use `jsonb` only for justified payloads, metadata, snapshots, or audit details.
- Represent `bigint` values losslessly in APIs, normally as decimal strings.
- Never trust client-calculated balances, totals, costs, roles, store IDs, or subscription state.

---

## Tenant Isolation and RLS

Every store-owned operation must set transaction-local context on the same connection and transaction used for that operation:

```sql
SELECT set_config('app.store_id',   :store_id, true);
SELECT set_config('app.user_id',    :user_id, true);
SELECT set_config('app.device_id',  :device_id, true);
SELECT set_config('app.request_id', :request_id, true);
```

Rules:

- Never disable RLS to fix a query or test.
- Never use a superuser, database owner, table owner, or `BYPASSRLS` role for runtime access.
- Runtime access must not inherit migration or administrative privileges.
- Derive store access from authenticated membership.
- Never trust a request-body `store_id` alone.
- Missing tenant context must fail closed.
- Prevent cross-store references.
- Store-owned queries must use the approved transaction wrapper.
- Pooled connections must not leak tenant context.
- Test commit, rollback, error, timeout, and concurrency paths.
- Any plausible cross-tenant data leak is a release blocker.

Runtime-role validation should reject unsafe privileges, ownership, migrator membership, or schema access that can bypass intended RLS boundaries.

---

## Business Invariants

### Sales and Money

- Fully paid anonymous sales are allowed.
- Credit or partial payment requires a customer.
- Customer debt is a receivable, not an expense.
- Credit does not increase a money account.
- Mixed payment creates one payment record per receiving account.
- Later receivable payment increases only the selected receiving account.
- Payment allocations cannot exceed the payment amount or remaining balance.
- Overpayment becomes customer credit or follows an explicit refund flow.
- Do not invent a walk-in customer record or customer type for fully paid anonymous sales.
- Customer role permissions, normalization semantics, archive visibility, or restore/reactivation behavior must come from an approved source or explicit backend-owner decision; do not infer them merely because the database can represent a state.
- One active cash account per store is allowed.
- Multiple bank, wallet, or transfer accounts are allowed.
- Internal transfers are neither revenue nor expense.
- Posted money creates auditable movements.
- Account balances are projections, not the authoritative source.

### Suppliers — Approved Rule

This rule is explicitly approved by the backend owner:

- A supplier is managed through supplier invoices, payments, credits, reversals, and supplier balance.
- A supplier invoice affects supplier payable and supplier balance only.
- Posting a supplier invoice must not automatically create inventory, stock movements, goods receipts, shelf entries, warehouse entries, storage-location entries, or partial receipt flows.
- Inventory additions are entered manually through a separate inventory operation.
- A supplier invoice and a manual inventory entry may optionally reference each other for traceability only.
- Neither operation automatically creates the other.
- Supplier payment reduces payable and the selected money account.
- Supplier payment must not create a second expense.
- Older requirements that mandate automatic or partial goods receipt must be reported as conflicts before implementation.

### Inventory and Cost

- Manual inventory entry is independent from supplier invoicing.
- `inventory_movements` is the authoritative source of stock changes.
- `stock_balances` is a protected projection.
- Movement creation and stock projection update occur in one transaction.
- Use approved locking or database functions for concurrent updates.
- Negative stock is allowed only by effective store/product policy.
- Never silently edit posted stock.
- Unknown cost remains explicitly unknown; zero is not a known cost.
- Supplier-invoice references are optional traceability only.

### Expenses, Owner Ledger, Returns, and Periods

- Paying an already recognized due expense must not recognize it twice.
- Owner withdrawal is not an operating expense.
- Distinguish contribution, owner loan, reimbursement, personal withdrawal, profit withdrawal, and capital withdrawal.
- Correct posted records through reversal and replacement, not silent editing.
- Do not post prohibited financial or inventory operations inside a closed period.
- Every correction must remain auditable.

---

## Transaction Rules

Related effects must commit or roll back together.

Examples:

- sale, items, payments, money movements, receivable, inventory effects, audit, and sync event;
- supplier invoice, payable effect, audit, and sync event;
- manual inventory entry, inventory movements, stock projection, costing effect, audit, and sync event;
- customer or supplier payment, allocations, money effect, audit, and sync event;
- return, settlement, money effect, inventory effect, audit, and sync event;
- sync idempotency claim, business effects, change event, and audit record.

Do not:

- split one business operation across independent commits;
- acknowledge synchronization before commit;
- perform external network calls while holding a database transaction open;
- create inventory effects as a side effect of supplier-invoice posting.

---

## Synchronization Rules

- Every client mutation carries a stable `operation_id`.
- Claim the operation before applying business effects.
- Same ID plus the same canonical payload must not duplicate effects.
- Same ID plus a different payload must be rejected and audited.
- Change-feed events are written inside the successful business transaction.
- Pull uses the approved ordered change feed and cursor.
- Do not infer deletion from missing data.
- Restore only committed server data.
- Bootstrap must provide a consistent snapshot plus later changes without gaps or duplicates.
- Never use silent last-write-wins for posted financial, inventory, settlement, or period-closing operations.
- Conflicts and unresolved cases remain explicit and auditable.

---

## NestJS, Drizzle, SQL, and Migrations

- Keep SQL out of controllers.
- Prefer explicit business use cases over generic CRUD for posted operations.
- Validate all external input with DTO and runtime validation.
- Use parameterized queries.
- Raw SQL is allowed only for justified PostgreSQL features or performance requirements; isolate, document, parameterize, and test it.
- Drizzle schema must match the applied PostgreSQL schema.
- Preserve RLS, policies, functions, triggers, partial indexes, exclusion constraints, grants, and role behavior.
- Review generated SQL before applying it.
- Do not generate migrations that recreate the approved baseline.
- Administrative database access must not be injectable into ordinary runtime modules.
- Never edit an applied migration.
- Every schema change requires a new versioned migration.
- Test migrations from empty and previous-version databases.
- Use expand-migrate-contract for destructive changes.
- Preserve synchronization compatibility.
- Document ownership, runtime-role, rollback, and remediation impact.

---

## Security and API Rules

Never:

- commit `.env`, passwords, tokens, keys, production dumps, or real customer data;
- concatenate untrusted input into SQL;
- log credentials, tokens, cookies, authorization headers, or secret database URLs;
- trust client totals, balances, costs, roles, store IDs, or subscription state;
- expose another tenant’s existence through detailed errors;
- weaken RLS, constraints, triggers, or tests to make a change pass;
- expose raw SQL errors or stack traces through the API;
- use a production database for ordinary integration tests.

API rules:

- Preserve UUIDs exactly.
- Use lossless `bigint` representations.
- Use stable error codes.
- Use deterministic pagination.
- Mutation responses include required version and idempotency metadata.
- Roll back after partial financial or inventory failure.
- Validate trusted proxy and incoming request-ID behavior.
- Bound request size and health-check duration.
- Readiness may depend on PostgreSQL; liveness must not.

---

## Verification

Use scripts defined in `package.json`; do not guess command names.

Typical checks include:

```text
npm ci
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:integration
npm run db:check
npm run db:check:admin
npm run dev
```

Rules:

- Do not report a command as passed unless it actually ran.
- Report skipped or unexecuted tests explicitly.
- A partially skipped suite is not full runtime verification.
- Tests must not target an unapproved or production database.
- Tests must prove the relevant behavior, not only HTTP status codes.
- Do not mock away the exact database property being tested.
- RLS, locking, transactions, migrations, and concurrency require real PostgreSQL tests where applicable.

Before database production approval, run:

```text
database/reference/backend_database_reference/06_runtime_tests.sql
```

against an approved disposable PostgreSQL environment.

---

## Working Method

For every non-trivial task:

1. Read this file and the current task prompt.
2. If the task introduces, changes, or interprets product/business behavior, read `docs/product/Dokana_PRD_v1.1_APPROVED.md` completely.
3. Inspect relevant code, migrations, tests, configuration, and documents.
4. Identify accounting, tenancy, sync, security, migration, and compatibility impact.
5. State a short plan.
6. Make the smallest complete change.
7. Add or update tests with the change.
8. Run repository-defined verification commands.
9. Fix root causes; do not bypass rules or weaken tests.
10. Review the diff for unrelated changes, secrets, destructive SQL, and tenant risk.
11. Update documentation when behavior, setup, schema, or contracts change.
12. Produce a complete handoff.
13. Stop at the requested task boundary.

Do not begin unrelated future work or broad refactoring without a correctness reason and explicit justification.

---

## Independent Review and Approval

Implementation and review are separate responsibilities:

```text
Codex          implementation, migrations, tests, and remediation
Fable          independent architecture, security, RLS, accounting,
               synchronization, migration, and release-gate review
Kimi K3        optional PRD, contract, and documentation review
Backend owner  final decisions, risk acceptance, and approval
```

The first independent review is read-only unless the backend owner explicitly authorizes changes.

The reviewer must:

- review the exact commit or diff;
- verify claims against code and tests;
- separate defects from preferences;
- classify severity accurately;
- identify blocking and deferrable findings;
- recommend the smallest safe correction;
- state whether work may safely continue.

A significant task or station handoff must include:

- implemented scope;
- branch and commit when available;
- changed files and dependencies;
- migrations and database objects changed;
- environment and API changes;
- commands and exact results;
- skipped or unexecuted tests;
- accounting, RLS, sync, migration, compatibility, and security impact;
- known risks;
- backend-owner decisions required;
- exact files or diff ready for review.

Do not continue to the next major task until verification is complete, review findings are resolved or explicitly accepted, and the backend owner approves progression.

---

## High-Risk Changes

High-risk areas include:

- money or quantity representation;
- posting, reversals, allocations, and balances;
- costing and inventory concurrency;
- period closing;
- synchronization and idempotency;
- RLS and tenant context;
- authentication and authorization;
- subscriptions and licenses;
- backup and restore;
- destructive migrations;
- encryption, signing, and secrets;
- audit immutability.

High-risk changes require applicable happy-path, rejection, duplicate, rollback, cross-tenant, and concurrency tests, plus independent review and backend-owner approval.

Passing current tests does not automatically make a high-risk change safe.

---

## Definition of Done

A task is complete only when all applicable conditions are met:

- behavior matches approved requirements;
- conflicts are resolved or explicitly approved;
- schema changes use reviewed versioned migrations;
- RLS, policies, constraints, triggers, functions, grants, and ownership remain intact;
- relevant tests were added and executed;
- balances and side effects were asserted where applicable;
- rollback, duplicate, stale-write, and concurrency behavior were tested where applicable;
- synchronization compatibility was reviewed;
- no secrets or real customer data were added;
- documentation was updated;
- unrelated files were not changed;
- skipped tests and remaining risks were disclosed;
- independent review was completed where required;
- the backend owner approved completion.

Do not claim `fully verified`, `production ready`, `secure`, `migration safe`, or `no issues` unless the required runtime, migration, security, RLS, concurrency, and scenario tests actually passed.
