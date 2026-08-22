# Product and Unit Write Contract v1

## Scope and Authority

This document records Station 5 / Task 5.4 idempotent Product and ProductUnit **create and
update**. It consumes the closed Task-5.1 persistence, Task-5.2 validation, and Task-5.3 read
contracts and the explicit backend-owner decisions P54-D1 through P54-D11. It adds no archive,
restore, reactivation, lifecycle removal, inventory, costing, accounting, sales, supplier, or Sync
behavior, and no migration. PostgreSQL constraints, forced RLS, and database triggers remain
authoritative.

## Write Authorization and Store State

A Product/Unit mutation requires an authenticated **active `owner`** membership whose trusted
server session store, user, and device match the tenant transaction context. Non-owner and
cross-context principals receive `403 PRODUCT_WRITE_NOT_ALLOWED`. The trusted store is derived from
the session; a client-supplied `store_id` is never authoritative. New business writes require an
`active` store; a `read_only` (or otherwise non-active) store yields `403 BUSINESS_WRITE_NOT_ALLOWED`
for new operations (see P54-D10 for completed-replay behavior). SaaS administrators and other roles
receive no ordinary Product write access.

## Routes

- `POST /v1/products` — atomic Product + initial base Unit create.
- `PATCH /v1/products/:productId` — Product metadata update.
- `POST /v1/products/units` — standalone **non-base** conversion Unit create.
- `PATCH /v1/products/units/:unitId` — Unit metadata/price update.

Responses reuse the Task-5.3 public representation plus `operationId`. Server-internal fields
(`store_id`, `device_id`, `operation_id`, `normalized_name`, `request_hash`, provenance) are never
exposed. Bigint values are decimal strings; `null` is distinct from `0`; ratios such as `2/4` are
preserved exactly.

## Product Create (P54-D7 atomic Product + base Unit)

A successful create atomically inserts the Product **and** its initial base Unit, or rolls both
back. The client supplies stable UUIDs for both the Product and the base Unit; valid client UUIDs
are preserved (canonicalized to lowercase). Server-authoritative on the base Unit: `is_base = true`,
`factor_num = 1`, `factor_den = 1`, `measurement_type` derived from the Product, `status = active`,
version, timestamps, and provenance. A newly created Product never exists with zero Units. Standalone
base-Unit creation is **not** part of Task 5.4 (P54-D9).

Server-derived Product fields (`store_id`, `normalized_name`, `status = active`, `version = 1`,
timestamps, provenance) are never client-writable. `normalized_name` is always derived server-side
from the display name via the frozen Product Normalization V1.

## Product Field Mutability (P54-D1/D2/D3)

- **Mutable:** `name` (recomputes `normalized_name`), `sku`, `barcode`, `description`, `is_pinned`,
  `low_stock_threshold_milli`, `allow_negative_stock_override`.
- **Immutable after create:** `measurement_type` (P54-D2), `track_inventory` (P54-D3).
- **Lifecycle-only (Task 5.5):** `status`.
- **Server-derived:** `store_id`, `normalized_name`, `version`, timestamps, provenance.

The update DTO rejects immutable, lifecycle, and server-owned fields through the strict global
validation boundary (`whitelist` + `forbidNonWhitelisted`).

### PATCH semantics

`OMITTED` means unchanged. For nullable mutable fields, `null` means explicit clear; a supplied
value is canonicalized per Task 5.2 (SKU/barcode outer-trim with empty-after-trim → `null`).
`OMITTED`, `null`, `"0"`, and `false` are kept distinct and never collapsed. An update must supply at
least one mutable field; a request with only `operationId` + `expectedVersion` is
`400 productMutableField`.

### No-op update (P54-D4)

When at least one mutable field is supplied and every supplied canonical value already equals the
persisted value, the update is a successful canonical no-op: no row mutation, no version increment,
no row-update change event or audit effect. The operation still completes deterministically and is
replayable.

## ProductUnit Create and Update (P54-D5/D6/D9/D11)

Standalone Unit create is **non-base only** (P54-D9): `is_base` is server-forced `false`; the client
cannot request a base Unit.

**Parent-state precondition (P54-D11):** standalone ProductUnit create requires the parent Product
to be **active and visible in the trusted current store**. An archived same-store Product cannot
accept a new ordinary active ProductUnit and is rejected with `PRODUCT_ARCHIVED` (no Unit inserted,
no hidden restore/reactivation, no false completed operation). A missing or foreign-store parent is
non-disclosing (`PRODUCT_NOT_FOUND`). Restore/reactivation of an archived Product remains Task 5.5;
Task 5.4 never changes lifecycle status. `measurement_type` is derived from the Product. Ratios use
the exact Task-5.2 non-base contract (positive `int4`, non-base `1/1` allowed, no float, no GCD
reduction).

- **Mutable Unit fields:** `unit_name`, `unit_code`, `sale_price_minor`, `purchase_price_minor`.
- **Immutable after create (P54-D6):** `product_id`, `measurement_type`, `is_base`, `factor_num`,
  `factor_den`.
- **Lifecycle-only (Task 5.5):** `status`.
- **Server-derived:** `store_id`, `version`, timestamps, provenance.

Because Task 5.4 never mutates `is_base`, `product_id`, `measurement_type`, or the conversion
factors, structural conversion values are immutable in this task; a future conversion change requires
a separately approved replacement/lifecycle workflow.

## Historical Conversion and Price Non-Retroactivity (P54-D6, §11)

Structural conversion values are immutable in Task 5.4, so already-persisted base-unit quantity
meaning cannot be reinterpreted in place. `sale_price_minor` and `purchase_price_minor` are current
master-data values only.

- **CURRENT RETROACTIVE PRICE DEPENDENCY: NONE FOUND.** No currently implemented business fact reads
  current ProductUnit price to recompute a historical amount; no view or trigger recomputes historical
  values from current master-data price.
- **MASTER-DATA PRICE NON-RETROACTIVITY CONTRACT: FROZEN FOR FUTURE TASKS.** Future
  Sales/Supplier/Inventory/Costing implementations must persist and use their own transaction-time
  values and must not reinterpret historical facts from current ProductUnit price.

## Archived Normal-Update Boundary (P54-D8)

Archived Products and archived ProductUnits reject ordinary Task-5.4 updates
(`PRODUCT_ARCHIVED` / `PRODUCT_UNIT_ARCHIVED`). Adding a Unit to an archived Product is rejected. A
Task-5.4 update never restores, reactivates, or changes lifecycle status. Lifecycle remains Task 5.5.

## Rule A and Rule B (P52-D6, P54-D-BASE-MUTABILITY)

**Rule A** (an active conversion Unit requires an active base structure) is enforced transactionally
in the only Task-5.4 path that can create an active conversion state: standalone non-base Unit
create. The transaction locks the Product row `FOR UPDATE`, then verifies an active base Unit exists
before inserting the conversion Unit; if none exists it rejects with `PRODUCT_BASE_UNIT_REQUIRED`.
This is a database-state precondition and transaction-time invariant, not pure input validation.

**Rule B** (an active base structure must not be invalidated while active dependents remain): Task
5.4 has no approved path that changes `is_base`, `product_id`, `measurement_type`, or factors, so it
cannot invalidate a base structure. The current Rule-B owner remains **Task 5.5** lifecycle paths.

## Lock Anchor and Deadlock Protocol

The single structural lock anchor is the **Product row (`FOR UPDATE`)**. Every per-Product structural
mutation acquires the Product row first, then any child Unit. Product update and Unit update take the
Product/Unit row lock through the versioned `UPDATE ... WHERE version = expectedVersion` predicate.
**Future Task 5.5 must acquire the Product row `FOR UPDATE` before archiving/removing a base Unit**,
so Rule-A create and Rule-B lifecycle serialize on the same anchor with no lock-order inversion. Lock
correctness does not depend on the number of client devices.

## Idempotency, Canonical Identity, and Replay

Every mutation carries a client `operationId` and is claimed through `sync.claim_operation` inside
the mutation transaction; the business effect and the operation completion commit atomically.

- **Actions:** processed-operation `action` is `create`/`update`, distinguished by
  `aggregate_type` `products` or `product_units`.
- **Canonical request identity:** `request_hash` is computed from a server-built canonical projection,
  never from raw request bytes or JSON property order. Each projection embeds a versioned action
  domain — `product.create` / `product.update` / `product_unit.create` / `product_unit.update` — with
  `v: 1`. `OMITTED` fields are absent from the projection while `null` fields are present as `null`,
  preserving the PATCH distinction. `expectedVersion` participates in update identity. The nested
  Product create projects all base-Unit fields as one identity.
- **Identity version recoverability: PASS.** The version/domain is embedded in the hashed projection
  and the V1 projection is preserved; a future V2 uses new domain constants and never reinterprets a
  stored V1 hash under V2 semantics. No migration is required.
- **Replay result mode:** ORIGINAL STORED RESPONSE SNAPSHOT. A completed operation stores its response
  body in `sync.processed_operations`; an identical replay returns the stored snapshot without
  re-executing the mutation, re-incrementing the version, or duplicating audit/change effects.
- **Reuse conflict:** the same `operationId` with a different canonical identity yields
  `OPERATION_ID_CONFLICT` and records a `sync.conflicts` row. Concurrent identical operations produce
  exactly one business effect.

## Optimistic Concurrency and Ordering (P54-D10)

Updates require `expectedVersion` (canonical positive decimal `bigint`). A real update atomically
requires the trusted tenant, a visible active target, and `version = expectedVersion`, and increments
the version exactly once via the database `touch_mutable_row` trigger. A stale version yields
`PRODUCT_VERSION_CONFLICT` / `PRODUCT_UNIT_VERSION_CONFLICT`.

The request ordering is: current authentication/session/tenant validation → completed-operation
lookup / exact replay → (only for a new operation) active-store write gate → new mutation. A
**completed exact idempotent replay may return the prior stored result even after the store becomes
`read_only`**, because replay creates no new business effect; a new operation on a `read_only` store
remains blocked. Authentication, tenant, and session-validity rules are never bypassed; cross-tenant
replay is impossible.

## UUID, Uniqueness, and Non-Disclosure

Client UUIDs are preserved and never overwrite an existing row: a different operation reusing an
existing same-store Product/Unit UUID is `CONFLICT`; a completed identical operation replays. SKU,
barcode, and per-Product Unit-name uniqueness, and the one-active-base-Unit index, remain database
authority; races are translated into stable application errors (`PRODUCT_SKU_CONFLICT`,
`PRODUCT_BARCODE_CONFLICT`, `PRODUCT_UNIT_NAME_CONFLICT`) without exposing SQL, constraint names, or
`request_hash`. Archived rows continue reserving SKU/barcode per Task 5.1. A same-store missing target
and a foreign-store existing target return the same non-disclosing not-found.

## Precision, Mass-Assignment, and Transport Safety

Money and thresholds use exact `bigint` minor units validated against the PostgreSQL bigint bound;
JavaScript numbers and permissive coercion are rejected (no `Number → BigInt`). Persistence uses
explicit field mapping only — no request object is spread into an `INSERT`/`UPDATE`, so server-owned
and future fields can never become writable. Unknown request fields are rejected by the strict global
validation pipe. **WRITE TRANSPORT SAFETY: PASS — the existing shared JSON body-size and validation
envelope is sufficient;** Task 5.4 introduces no unbounded request path and no Product-domain length
limit is invented for transport.

## Deferred Work

Product/Unit archive, restore, reactivation, base replacement, and all lifecycle transitions
(Task 5.5); inventory, stock, costing, accounting, sales, supplier, money-movement workflows; the
SQLite/mobile runtime, Sync, and multi-device conflict-resolution. A separately reviewed forward
PostgreSQL migration for database-level Rule-A/Rule-B enforcement may be considered later if the
authoritative transaction design requires it.
