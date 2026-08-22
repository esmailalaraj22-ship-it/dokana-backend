# Product and Unit Lifecycle Contract v1

## Scope and Authority

This document records Station 5 / Task 5.5 Product and ProductUnit **lifecycle safety**: archive
and restore of Products and of base/conversion ProductUnits. It consumes the closed Task-5.1
persistence, Task-5.2 validation, Task-5.3 read, and Task-5.4 write/idempotency contracts and the
explicit backend-owner decisions **P55-D1 through P55-D4**. It adds no base replacement/re-basing, no
inventory, costing, accounting, sales, supplier, or money-movement behavior, no SQLite/mobile runtime
or Sync behavior, and **no migration**. PostgreSQL constraints, forced RLS, the one-active-base
partial unique index, and the `touch_mutable_row` version trigger remain authoritative.

Decisions labelled **BACKEND-OWNER APPROVED** are explicit owner policy. Everything else is an
**engineering derivation from closed authority** that resolves implementation mechanics only and
changes no business meaning, authorization, historical interpretation, or accounting/inventory
meaning.

## Authorization, Tenant, and Store State

A lifecycle mutation reuses the Task-5.4 write authority unchanged: an authenticated **active
`owner`** membership whose trusted server session store, user, and device match the tenant
transaction context; non-owner and cross-context principals receive `403
PRODUCT_WRITE_NOT_ALLOWED`. The store is server-derived; a client `store_id` is never authoritative.
A **new** lifecycle operation requires an `active` store; a `read_only` (or otherwise non-active)
store yields `403 BUSINESS_WRITE_NOT_ALLOWED`. Forced RLS, the non-owner/non-superuser/non-`BYPASSRLS`
runtime role, and fail-closed missing context are unchanged. No new Product-specific RBAC is added.

## Routes and Request

- `POST /v1/products/:productId/archive`
- `POST /v1/products/:productId/restore`
- `POST /v1/products/units/:unitId/archive`
- `POST /v1/products/units/:unitId/restore`

Route spelling follows the existing Product controller convention (static `units` segment precedes
the `:productId` parameter). Each request body carries exactly a client `operationId` and an
`expectedVersion` (canonical positive decimal `bigint`). There is no client-writable `status`,
`store_id`, `is_base`, factor, `product_id`, `archived_at`, version, or provenance. Responses reuse
the Task-5.3 public representation plus `operationId`; server-internal fields are never exposed.

## Persisted Lifecycle State vs Effective Operational Availability

**BACKEND-OWNER APPROVED (P55-D1):** Product archive/restore changes **Product status only** and does
**not** cascade to ProductUnits. Consequently an archived Product may hold ProductUnits whose
persisted `status` is still `active` (no child version increment, no child audit/change effect).

The contract therefore distinguishes two things:

- **Persisted child lifecycle state** — the `product_units.status` row value, governed solely by
  explicit ProductUnit lifecycle commands.
- **Effective operational availability** — whether a ProductUnit may be used for a **new** business
  operation.

**Effective availability rule (derived from closed authority — Task-5.4 P54-D11 new-dependent gate,
P55-D1, and lifecycle semantics):** a ProductUnit is operationally eligible for a **new** business
operation only when

```text
Product.status = active
AND ProductUnit.status = active
AND any feature-specific structural requirement of the consuming domain
```

Thus an `active` child under an `archived` Product remains **persisted `active`** while its
**effective operational availability is unavailable**. This is a necessary condition, stated
conservatively: it never grants availability and never mutates child state; future
Sales/Inventory/Costing domains may add further structural requirements but must honor this
necessary condition. Historical and read visibility remain governed by the Task-5.3 read contract
(Product detail still embeds active and archived Units and exposes each Unit status).

## Product Lifecycle State Machine

**ACTIVE → ARCHIVE.** Requires valid auth/session, trusted tenant, the new-write store gate, a valid
`operationId`, a same-store Product, and `expectedVersion = current version`. Effects: `status →
archived`; `archived_at` set per the persistence contract; `version` increments exactly once;
provenance/timestamp updated. ProductUnits receive **no** lifecycle mutation. Zero accounting and
zero inventory effect.

**ARCHIVED → RESTORE.** Requires the same authorization/concurrency checks. Effects: the **same**
Product row and UUID; `status → active`; `archived_at → null`; `version` increments exactly once;
ProductUnits unchanged. Under P55-D2 a restored Product may temporarily have no active base Unit.

**ACTIVE → RESTORE (new operationId)** and **ARCHIVED → ARCHIVE (new operationId)** are semantic
no-ops (see below).

## Base ProductUnit Lifecycle State Machine

**ACTIVE → ARCHIVE.** Acquire the Product row `FOR UPDATE` first, then evaluate **Rule B**: if any
active same-Product conversion Unit exists, reject; otherwise archive the base. The parent Product
may be `active` or `archived` (**P55-D3**). Product status is unchanged; no replacement base is
created (**P55-D2**: base archive does not force a replacement and leaves the Product active without
an active base). Zero accounting/inventory effect.

**ARCHIVED → RESTORE.** Requires parent **Product = active**. Acquire the Product row `FOR UPDATE`
first, restore the **same** base row, and require `expectedVersion` plus the one-active-base
invariant (no competing active base). Preserve UUID, `product_id`, `measurement_type`, `is_base`,
`factor_num`, `factor_den` — no rebasing, no replacement, no factor reinterpretation.

**ACTIVE → RESTORE / ARCHIVED → ARCHIVE (new operationId)** are semantic no-ops.

## Conversion ProductUnit Lifecycle State Machine

**ACTIVE → ARCHIVE.** Allowed under an `active` or `archived` parent Product provided normal
authorization/version/idempotency checks pass. No Product or base lifecycle mutation. Zero
accounting/inventory effect.

**ARCHIVED → RESTORE.** Requires parent **Product = active** and an **active same-Product base
Unit** (**Rule A**), the existing measurement compatibility and factor pair unchanged, evaluated on
authoritative DB state inside the transaction after acquiring the Product row `FOR UPDATE`. No hidden
Product restore, no structural mutation. Under **P55-D2**, while no active base exists an archived
conversion restore is forbidden.

**ACTIVE → RESTORE / ARCHIVED → ARCHIVE (new operationId)** are semantic no-ops.

## Rule A and Rule B (frozen lifecycle contract)

- **Rule A** — an active conversion ProductUnit requires an active same-Product base Unit. Enforced
  transactionally on **every** path that can produce an active conversion state: Task-5.4 conversion
  create **and** Task-5.5 conversion restore. Order: lock Product row `FOR UPDATE` → verify Product
  active → verify an active base exists → lock/read the target Unit → check `expectedVersion` →
  mutate. The precondition is authoritative transaction-time DB state, never a stale pre-transaction
  check. Failure is `PRODUCT_BASE_UNIT_REQUIRED`.
- **Rule B** — an active base Unit must not be archived while active same-Product conversion Units
  exist. Order: lock Product row `FOR UPDATE` → verify the target base → query active same-Product
  conversions → reject if any → otherwise archive. Rule B coordinates with Task-5.4 conversion
  create through the **same** Product-first anchor, so create and base archive serialize with no
  lock-order inversion.

## Structural Locking Contract

The single structural lock anchor is the **Product row (`FOR UPDATE`)**. Canonical order: trusted
context / operation claim → Product row `FOR UPDATE` → Product/Unit state precondition → target Unit
lock as required → dependency query/lock as required → `expectedVersion` predicate → mutation →
audit / change / operation completion → commit. Multiple Unit rows are locked in deterministic
`id ASC` order. No broad table locks, no distributed locks, no device locks. Lock correctness does
not depend on the number of client devices.

## Exact Replay vs Semantic No-Op

**Exact replay** (unchanged from the closed Task-5.4 contract) requires the same `operationId` **and**
the same canonical request identity. Ordering is: authentication / session → trusted tenant / actor →
completed exact-operation lookup → if exact replay, return the frozen stored result → otherwise the
current new-write store gate → new mutation. A completed exact replay may return the stored result
even while the store is `read_only`, because it creates no new business effect; a **new** lifecycle
operation on a `read_only` store remains blocked. Replay never bypasses authentication, session
validity, tenant authority, or suspended/archived-store rules, and cross-tenant replay is impossible.

**BACKEND-OWNER APPROVED (P55-D4) — semantic no-op.** A **new** `operationId` requesting archive on
an already-archived resource, or restore on an already-active resource, is a **successful semantic
no-op**, distinct from exact replay. It causes no resource-row mutation, no version increment, no
`updated_at`/`archived_at` change, no resource-row update audit, no resource update change-event, no
lifecycle cascade, and zero accounting/inventory effect. The operation itself still becomes a valid
deterministic completed/replayable processed-operation through the existing infrastructure. A later
exact retry (same `operationId` + same canonical request) returns the stored no-op result; the same
`operationId` with a changed canonical request is an operation-reuse conflict.

## expectedVersion on Semantic No-Op

**Derived from closed authority (Task-5.4 optimistic concurrency).** In the closed write path the
version gate strictly precedes no-op classification, so a **new** command carrying a stale
`expectedVersion` is a version conflict regardless of whether its effect would be a no-op. Task 5.5
preserves this ordering: a **new** lifecycle command — including a P55-D4 semantic no-op — requires
`expectedVersion = current resource version`; a stale value yields
`PRODUCT_VERSION_CONFLICT` / `PRODUCT_UNIT_VERSION_CONFLICT`. Exact replay is different: a completed
exact replay returns the stored result independently of the current resource version. This keeps
stale-write detection intact and invents no new concurrency behavior.

## Idempotency and Canonical Lifecycle Identity

Lifecycle mutations reuse the Task-5.4 idempotency infrastructure (`sync.claim_operation` inside the
mutation transaction; the business effect and operation completion commit atomically; original stored
response snapshot on replay; `sync.conflicts` on reuse). Four disjoint versioned lifecycle request
domains are defined — conceptually `product.archive` / `product.restore` / `product_unit.archive` /
`product_unit.restore`, each at `v: 1` — carried through the processed-operation
`action` (`archive` / `restore`) and `aggregate_type` (`products` / `product_units`). An
`operationId` used for one domain must never replay as another, and the same `operationId` + same
action + a **different** target must not replay. The server-built canonical projection includes the
domain/action, target UUID, and `expectedVersion`. The V1 domain constants are embedded in the hashed
projection and are recoverable; a future V2 uses new constants and never reinterprets a stored V1
hash. No parallel lifecycle idempotency subsystem is built.

## Audit, Change Events, and Semantic-No-Op Persistence

A **real** lifecycle mutation produces the established effects: version increment via
`touch_mutable_row`, timestamp/provenance update, a row-update audit entry, a change-event, and
processed-operation completion. The business action (`archive` / `restore`) lives in
`processed_operations.action`; the technical row change uses the existing generic change-event
semantics — no new Sync vocabulary is invented. A **P55-D4 semantic no-op** performs no resource-row
update and therefore produces no resource-row update audit and no resource update change-event;
independent processed-operation metadata still records the completed operation.

## Concurrency Matrix

| Race class                                 | Lock                                                               | Required result                                        |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Conversion create/restore vs base archive  | Product row `FOR UPDATE`                                           | one serialized winner; final Rule A/Rule B state valid |
| Base archive/restore vs competing base     | Product row `FOR UPDATE`                                           | at most one active base; Rule B preserved              |
| Product lifecycle vs child lifecycle       | Product row `FOR UPDATE` where structural coordination is required | P55-D1 / P55-D3 preserved                              |
| Same operation, concurrent duplicate       | idempotency claim                                                  | exactly one authoritative effect, else replay          |
| Different operations, same expectedVersion | row/version predicate                                              | one real mutation winner; the stale loser conflicts    |

If a conversion restore commits before a Product archive, the Product may become `archived` while the
conversion's persisted `status` remains `active`; this is governed by the Effective Operational
Availability rule above and never mutates the Unit merely because the Product archived.

## Accounting, Inventory, and Historical Integrity

Product/ProductUnit archive and restore are **master-data lifecycle** operations, not accounting
transactions. They create **zero** revenue, expense, receivable, payable, cash/bank/wallet movement,
supplier/customer payment, journal posting, inventory movement, stock adjustment, cost/COGS
recognition, valuation, or settlement, and they never zero stock or create adjustments (no
stock-balance precondition is introduced; inventory eligibility policy is left to future Inventory
work). Lifecycle state changes affect operational eligibility only and never reinterpret past
transactions. UUIDs, `product_id`, `measurement_type`, `is_base`, `factor_num`, `factor_den`,
historical references, and stored historical snapshots/prices are preserved. There is no hard delete.

## Error Contract

Lifecycle reuses the established stable error families: `PRODUCT_NOT_FOUND` /
`PRODUCT_UNIT_NOT_FOUND` (non-disclosing for missing or foreign-store targets),
`PRODUCT_VERSION_CONFLICT` / `PRODUCT_UNIT_VERSION_CONFLICT`, `PRODUCT_BASE_UNIT_REQUIRED` (Rule A on
conversion restore), `OPERATION_ID_CONFLICT`, and `OPERATION_IN_PROGRESS`. Base archive blocked by
active conversions (Rule B) and base restore blocked by a competing active base surface as `CONFLICT`
where no more specific existing family applies; a lifecycle-specific code is added only if an existing
family cannot accurately represent the outcome. Parent-inactive conversion/base restore is a
conflict. P55-D4 already-current-state requests are **not** errors. Foreign existence is never
disclosed.

## archived_at, Migration, and PostgreSQL/SQLite Consistency

The applied schema gives `products` an `archived_at` column and its
`(status = 'archived' ⇒ archived_at IS NOT NULL)` check; `product_units` has **no** `archived_at`, so
ProductUnit lifecycle evidence uses `status`, `version`, timestamps/provenance, audit, change events,
and processed operations. **No `product_units.archived_at` is added for symmetry and no migration is
created.** (The PostgreSQL all-in-one _reference_ file carries an extra `archived_at` on
`product_units`; this is a pre-existing reference-vs-applied delta recorded since Task 5.1 and is not
changed here. The applied schema matches the SQLite reference, which also has no unit `archived_at`.)

**Migration decision: NONE.** Rule A and Rule B are enforced safely at the PostgreSQL
backend-transaction level with Product-first locking, as already proven for Rule A in Task 5.4; no
database object is required.

**PostgreSQL/SQLite consistency.** The SQLite v1.1 reference enforces the same lifecycle **semantics**
through triggers (`trg_product_unit_nonbase_requires_base` = Rule A;
`trg_product_base_unit_cannot_archive_with_active_conversions` = Rule B). The backend enforces the
same intent through authoritative transactions and additionally covers the conversion **restore**
transition that the SQLite `BEFORE INSERT` trigger does not. This is an
**enforcement-mechanism/completeness difference, not a semantic difference**; the SQLite/mobile
runtime and Sync reconciliation are deferred and must align their local enforcement at that time.

## Deferred Work

Base replacement / re-basing (selecting another Unit as base, changing `is_base`, changing or
reinterpreting factors, converting a conversion Unit into a base, replacement-base workflows);
inventory, stock, costing, accounting, sales, supplier, and money-movement workflows and their
operational-eligibility policies; the SQLite/mobile runtime, Sync, and multi-device conflict
resolution; Station-5 query-privacy/documentation closure (Task 5.6). A separately reviewed forward
PostgreSQL migration for database-level Rule-A/Rule-B enforcement may be considered later only if a
future authoritative design requires it.
