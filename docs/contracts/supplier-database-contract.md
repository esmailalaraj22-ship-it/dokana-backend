# Supplier Database Contract

## Scope and Authority

This record freezes Station 6 / Task 6.1 Supplier persistence semantics only. It does not
implement or define Supplier APIs, validation code, search, pagination, mutation replay,
archive/restore endpoints, Supplier invoices, payables, payments, Goods Receipts, inventory,
accounting, or synchronization policy.

The governing sources are the current backend-owner decisions, root `AGENTS.md`, the approved
PRD v1.1, applied migrations, the live PostgreSQL catalog, and the immutable database reference
package, in that order. The applicable reusable normalization source is
`docs/customer-normalization-v1.md`; Task 6.2 owns its Supplier validation implementation.

The authoritative central object is `ledger.suppliers`. It predates the versioned migration
ledger and is part of the approved PostgreSQL baseline. Migrations `0001` through `0005` preserve
its shape; migration `0002` verifies the object inventory and transfers table ownership to
`shop_app_migrator`.

## Durable Identity and Business Boundary

- `id` is the durable Supplier identity. It is a client-preservable PostgreSQL `uuid` primary
  key with no server default.
- Phone is a tenant-scoped contact and uniqueness attribute. It is not a primary key, foreign-key
  identity, accounting identity, payable identity, or historical transaction identity.
- A later approved phone change does not replace the Supplier row or UUID. Exact update behavior
  belongs to Task 6.4.
- Supplier master-data create, update, archive, and restore have no accounting or inventory
  effect.
- Supplier master data is separate from Supplier Invoice, Supplier Payment, Goods Receipt, and
  manual inventory entry. A Supplier Invoice may affect payable under a future approved contract,
  but it must not automatically create inventory, stock movements, Goods Receipts, storage
  locations, or partial-receipt flows.

## PostgreSQL Storage Contract

`ledger.suppliers` has the following persisted shape:

| Column             | PostgreSQL contract                                                        |
| ------------------ | -------------------------------------------------------------------------- |
| `id`               | `uuid`, primary key, not null, no default                                  |
| `store_id`         | `uuid`, not null, store tenant key                                         |
| `name`             | `text`, not null, trimmed database value must be nonempty                  |
| `normalized_name`  | `text`, not null, trimmed database value must be nonempty                  |
| `phone`            | nullable `text`, no database presence check                                |
| `normalized_phone` | nullable `text`, no database presence check                                |
| `notes`            | nullable `text`                                                            |
| `status`           | `text`, not null, default `active`, limited to `active` or `archived`      |
| `archived_at`      | nullable `timestamptz`; required by the database when status is `archived` |
| `device_id`        | nullable `uuid` provenance                                                 |
| `operation_id`     | `uuid`, not null                                                           |
| `created_at`       | `timestamptz`, not null, default `now()`                                   |
| `updated_at`       | `timestamptz`, not null, default `now()`                                   |
| `version`          | `bigint`, not null, default `1`, constrained to at least `1`               |

The table has these identity and relationship constraints:

- primary key `(id)` and tenant-safe unique key `(store_id, id)`;
- tenant-scoped unique keys `(store_id, normalized_phone)` and
  `(store_id, operation_id)`;
- `(store_id) -> ledger.stores(id)` with update cascade and delete restrict;
- nullable tenant-safe provenance FK from `(store_id, device_id)` to
  `ledger.devices(store_id, id)` with update cascade and delete restrict;
- search index `(store_id, status, normalized_name, normalized_phone)`.

Existing Supplier references from `purchase_invoices`, `supplier_ledger_entries`,
`supplier_payments`, `supplier_returns`, and legacy `goods_receipts` use tenant-safe
`(store_id, supplier_id) -> ledger.suppliers(store_id, id)` foreign keys with delete restrict.
Those dependencies protect historical identity; they do not authorize or create any future
Supplier workflow in this task.

## Application-Required, Storage-Nullable Phone

For every supported new Supplier creation, phone is required by the authoritative application or
domain layer. A supported create must eventually reject a missing, null, blank, or malformed
phone. Requiredness is not merely a UI rule, but it is intentionally not a PostgreSQL or SQLite
`NOT NULL` rule.

This is an application/domain rule for every supported write path, including future offline
mobile creation. It must not exist only in an HTTP controller or presentation layer.

Consequently, all of these statements are simultaneously authoritative:

- a new Supplier phone is required by Dokana business validation;
- PostgreSQL `phone` and `normalized_phone` remain nullable;
- SQLite `phone` and `normalized_phone` remain nullable;
- future Drizzle fields must mirror that PostgreSQL nullability;
- no PostgreSQL migration or SQLite patch is required for phone presence.

Database storage capability does not define valid new business input. Task 6.2 owns exact
validation and normalization behavior, and Task 6.4 owns enforcement in supported create/update
workflows.

## Name and Phone Semantics

Supplier name and phone normalization reuse the approved Customer normalization-v1 semantics.
Task 6.1 does not redesign those algorithms or define Supplier-specific error codes.

Name is descriptive master data. Neither `name` nor `normalized_name` is a unique Supplier
identity.

For phone:

- one non-null `normalized_phone` may identify at most one Supplier row within a store;
- the same normalized phone may be used in different stores;
- the non-partial `(store_id, normalized_phone)` unique key means an archived Supplier continues
  to reserve its non-null normalized phone;
- there is no global uniqueness, release period, warning-based duplicate, duplicate override, or
  automatic reassignment rule;
- `NULL` phone has no Supplier identity meaning. Standard PostgreSQL and SQLite unique-null
  semantics may represent more than one legacy row without a normalized phone.

## Legacy Data and Lifecycle Identity

Rows with null `phone` and/or `normalized_phone` are storage-permitted legacy states, not valid
current new-Supplier input. Task 6.1 does not fabricate or backfill phones, guess normalization,
merge rows, archive rows, delete rows, or rewrite UUIDs.

The Supplier lifecycle is `active <-> archived`. Restore preserves the same row and UUID, and an
archived non-null normalized phone remains reserved. Normal business lifecycle has no hard-delete
operation. The database currently requires a non-null `archived_at` for `archived`; at the storage
level, the check does not require `archived_at` to be null for `active`.

How a future mutation treats an existing legacy null-phone Supplier is deferred: name-only update,
phone repair, restore requirements, and any temporary read-only or repair behavior are not decided
here. Task 6.2 owns validation semantics, Task 6.4 owns create/update semantics, and Task 6.5 owns
archive/restore semantics.

## Tenant Isolation and Historical Safety

`ledger.suppliers` is owned by `shop_app_migrator`. PostgreSQL RLS is enabled and forced. Its
`ALL` policy uses `store_id = platform.current_store_id()` for both visibility and writes. The
context function reads trusted transaction-local server context through the applied migration
security configuration; absent tenant context matches no rows and rejects writes.

The normal runtime login is not the table owner, is not superuser, has no `BYPASSRLS`, is not a
migrator member, and cannot assume the migrator role. Runtime table grants remain subject to
forced RLS. Client-supplied `store_id` cannot establish authority, and future Supplier persistence
must use the approved same-transaction tenant-context wrapper. Feature-level Supplier actor
authorization is deferred to the applicable API task and must not be copied from Customer or
Product policy without authority.

A `BEFORE DELETE` trigger invokes `ledger.prevent_delete()`. Tenant-safe incoming foreign keys
also use delete restrict. Migration or administrative ownership is not normal application
authority and does not weaken the no-hard-delete business contract.

## Version, Provenance, Audit, and Change Infrastructure

The Supplier row carries `version`, nullable `device_id`, and mandatory `operation_id`.
`ledger.touch_mutable_row()` updates `updated_at` and increments `version` before update.

Shared PostgreSQL mutation infrastructure is separate from the Supplier row:

- `sync.processed_operations` provides tenant-scoped operation claims, request hash, status, and
  stored response/error fields;
- `sync.change_events` receives Supplier insert/update events through
  `trg_suppliers_change_event`;
- `audit.central_audit_logs` receives Supplier insert/update/delete audit rows through
  `trg_suppliers_central_audit`.

These facts provide persistence capability only. Exact Supplier request hashing, operation claim
ordering, replay responses, changed-payload conflicts, and business action naming are deferred to
Task 6.4. Generic change capture may represent restoration to `active` as `update`; later Sync work
must not assume generic change-event action always equals Supplier business lifecycle semantics.

## PostgreSQL and SQLite Semantics

The approved SQLite `suppliers` table has the same 14 logical fields, lifecycle values,
tenant-scoped unique keys, tenant-safe store/device relationships, search-index order, and
no-delete behavior. No SQLite schema change is introduced.

| Concept                              | PostgreSQL                                       | SQLite                                          | Classification                                               |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| Supplier/store/device/operation IDs  | native `uuid`                                    | UUID text                                       | Expected platform difference                                 |
| Phone storage                        | nullable `text`                                  | nullable `TEXT`                                 | Semantic match                                               |
| Non-null normalized-phone uniqueness | `(store_id, normalized_phone)`                   | same logical unique key                         | Semantic match                                               |
| Lifecycle                            | checked `active/archived`, nullable archive time | same states and logical check                   | Semantic match                                               |
| Version                              | `bigint`                                         | `INTEGER`                                       | Expected platform difference; transport must remain lossless |
| Timestamps                           | UTC `timestamptz`, server defaults               | UTC epoch `INTEGER`, supplied locally           | Expected platform difference                                 |
| Tenant isolation                     | forced central PostgreSQL RLS                    | no local RLS                                    | Expected architecture difference                             |
| Audit and changes                    | central database triggers                        | local `audit_logs` and `sync_outbox` mechanisms | Expected architecture difference                             |
| Hard delete                          | generic PostgreSQL guard trigger                 | Supplier-specific SQLite guard trigger          | Semantic match                                               |

Semantic compatibility, rather than identical DDL, is required. Mobile and Sync implementations
must preserve UUIDs, tenant ownership, non-null phone uniqueness, archived phone reservation,
versions, UTC instants, and historical identity without silently converting null legacy phone into
business identity.

## Future Drizzle Mapping Target

No Supplier Drizzle table is present at this freeze point. Future Task 6.1 implementation must map
the exact live PostgreSQL `ledger.suppliers` shape, including nullable `phone`, nullable
`normalizedPhone`, UUID fields, `bigint` version mode, defaults, checks, tenant-safe FKs, unique
keys, and search index where supported by repository convention.

Drizzle represents database storage, not application input validity. It must not encode the
application-required phone rule as false database non-nullability. RLS, ownership, grants,
triggers, audit, and change capture remain database-authoritative where Drizzle cannot express
them faithfully.

## Migration Decision

Task 6.1 requires no PostgreSQL migration, no SQLite patch, no baseline rewrite, and no legacy
data remediation for phone requiredness. The current five applied migrations and immutable
reference package remain unchanged. This decision does not waive remediation of a future,
independently evidenced database defect.

## Deferred Work

- Task 6.2: required phone, name/phone normalization, field validation, and identifier validation.
- Task 6.3: tenant-safe reads, default-active and explicit-archived visibility, search, pagination,
  and query privacy.
- Task 6.4: client-compatible UUIDs, idempotent create/update, version conflicts, replay, duplicate
  phone conflicts, and unresolved legacy null-phone mutation policy.
- Task 6.5: same-row archive/restore, archived phone reservation, lifecycle idempotency, and any
  legacy restore policy.
- Task 6.6: privacy regression, final documentation, verification, independent review, and Station
  6 closure.

## Future Implementation Verification Gates

Future mapping work must prove, without mutating the approved baselines:

1. PostgreSQL and SQLite Supplier storage remain unchanged and phone fields remain nullable.
2. Non-null normalized phone remains unique per store, archived values remain reserved, and
   cross-store reuse remains possible.
3. Supplier UUID, tenant-safe FKs, lifecycle storage, version, operation/provenance fields, indexes,
   no-delete guards, audit, and change infrastructure match the authoritative databases.
4. PostgreSQL RLS remains enabled, forced, fail-closed, and non-bypassable by normal runtime.
5. Drizzle mirrors PostgreSQL without encoding business-required phone as database `NOT NULL`.
6. No Supplier master-data operation creates accounting, payable, payment, inventory, receipt,
   movement, stock, or costing effects.
7. Migration status/checksums and reference-package integrity remain valid, with no generated or
   unjustified migration.
