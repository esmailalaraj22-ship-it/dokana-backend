# Supplier Lifecycle Contract v1

## 1. Scope, Authority, and Provenance

This contract freezes Station 6 / Task 6.5 Supplier archive and restore behavior for the current
MVP. It extends, without reopening, the closed Supplier database, validation, read, and write
contracts:

- `docs/contracts/supplier-database-contract.md`;
- `docs/contracts/supplier-validation-v1.md`;
- `docs/contracts/supplier-read-v1.md`; and
- `docs/contracts/supplier-write-v1.md`.

The governing order is the current backend-owner decisions, root `AGENTS.md`, the approved PRD
v1.1, the closed Supplier contracts, and then approved shared architecture and physical database
evidence. The explicit owner decisions are:

- **P6-D2:** Supplier lifecycle is reversible `active <-> archived`, using the same row and UUID;
  non-null normalized phone remains reserved while archived; there is no normal hard delete and
  no accounting or inventory effect.
- **P65-D1:** a genuinely new archive of an already archived Supplier, or restore of an already
  active Supplier, is a successful semantic no-op after current-version validation.
- **P65-D2:** an archived legacy Supplier whose persisted phone is `NULL` may be restored while
  preserving that legacy `NULL` phone state.

This contract defines lifecycle API and transaction semantics only. It does not implement code,
tests, migrations, PostgreSQL, Drizzle, SQLite, mobile behavior, Sync workers, Supplier invoices,
payments, payables, Goods Receipts, inventory, costing, or future workflow eligibility.

## 2. Domain and Historical Boundary

A Supplier is shop-owned master data. Archive and restore preserve the same Supplier row, durable
UUID, name, normalized name, phone fields, notes, and historical references. Phone is a
tenant-scoped contact and uniqueness attribute, not Supplier identity.

Supplier lifecycle has:

```text
accounting effect = none
inventory effect  = none
```

It MUST NOT create or mutate invoices, payables, balances, payments, expenses, money movements,
Goods Receipts, inventory movements, stock, costing, COGS, warehouses, shelves, or locations.
Archive and restore never reinterpret historical transactions.

## 3. Actor, Trusted Context, and RLS

Only an authenticated Shop Owner with an active `owner` membership may issue Supplier lifecycle
commands. Manager, viewer, support, employee, staff, and platform-administrator identity do not
grant ordinary Store Runtime Supplier lifecycle authority. Denial uses
`SUPPLIER_WRITE_NOT_ALLOWED`. There is no SaaS-admin-as-Shop-Owner shortcut or arbitrary tenant
selection.

The server derives store, user, and device from the live authenticated session and request ID from
request infrastructure. The client cannot establish authority by supplying store, tenant, user,
device, role, lifecycle state, version, timestamps, or normalized fields.

Every operation lookup, claim, target query, lifecycle result, and completion MUST use
`DatabaseService.withTenantTransaction()` on one connection and transaction with trusted
transaction-local context. Explicit same-store predicates supplement forced RLS. Normal runtime
remains non-owner, non-superuser, non-`BYPASSRLS`, and unable to assume migration or administrative
roles. Missing context fails closed.

## 4. Routes and Inputs

The lifecycle routes are:

```text
POST /v1/suppliers/:supplierId/archive
POST /v1/suppliers/:supplierId/restore
```

Each strict request body contains exactly:

```text
operationId
expectedVersion
```

`supplierId` and `operationId` use Task 6.2 canonical UUID semantics. `expectedVersion` is a
required positive decimal string within PostgreSQL `bigint` range and MUST NOT use JavaScript
`Number` as authority. Request ID is independent from operation ID.

Lifecycle requests accept no name, phone, notes, status, archivedAt, version, store, user, device,
or repair payload. There is no DELETE route, writable status PATCH, archivedAt PATCH, implicit
restore through ordinary PATCH, or hard-delete lifecycle command.

## 5. State Transition Matrix

For a genuinely new operation, target and expected-version validation precede same-state no-op
classification. Exact replay is resolved earlier and does not re-evaluate historical state or
version.

| Current state | Command | Result         | Supplier UPDATE | Version / updatedAt   | archivedAt               | Supplier event             | Supplier UPDATE audit | Operation           |
| ------------- | ------- | -------------- | --------------- | --------------------- | ------------------------ | -------------------------- | --------------------- | ------------------- |
| `active`      | archive | Real mutation  | Yes             | Increment/change once | Set to database UTC time | One `archive` event        | One                   | Applied, replayable |
| `active`      | restore | Semantic no-op | No              | Unchanged             | Unchanged                | None                       | None                  | Applied, replayable |
| `archived`    | archive | Semantic no-op | No              | Unchanged             | Unchanged                | None                       | None                  | Applied, replayable |
| `archived`    | restore | Real mutation  | Yes             | Increment/change once | Set to `NULL`            | One generic `update` event | One                   | Applied, replayable |

All four cells require `expectedVersion = current version` for a genuinely new operation. A stale
same-state command is `SUPPLIER_VERSION_CONFLICT`, not a no-op success.

## 6. Real Archive Contract

Real archive requires a visible same-store active Supplier at the expected version. It changes
only lifecycle and trusted provenance fields:

```text
status      active -> archived
archivedAt  database/server current UTC time
deviceId    trusted current device
operationId accepted lifecycle operation
```

The Supplier UUID and every business field remain unchanged. The existing touch trigger advances
version exactly once and sets `updatedAt`. Existing database triggers create exactly one Supplier
`archive` change event and one central Supplier UPDATE audit. The operation completes as applied
with an HTTP 200 response snapshot in the same transaction.

Archive does not release or clear phone. An archived non-null normalized phone remains reserved by
the same row within the store. Cross-store reuse remains allowed.

## 7. Real Restore Contract

Real restore requires a visible same-store archived Supplier at the expected version. It changes
only lifecycle and trusted provenance fields:

```text
status      archived -> active
archivedAt  NULL
deviceId    trusted current device
operationId accepted lifecycle operation
```

The same row and UUID are restored. Name, normalized name, phone, normalized phone, and notes are
preserved exactly. Restore does not release, reacquire, reassign, or revalidate a non-null reserved
phone as though it were a new Supplier.

The touch trigger advances version exactly once and sets `updatedAt`. The current generic database
change trigger represents restore as one `update` change event, while
`sync.processed_operations.action` records the logical business action `restore`. This difference
is an accepted physical fact; Task 6.5 adds no manual duplicate event or schema change. Future Sync
interpretation is deferred. The central audit trigger creates one Supplier UPDATE audit. The
operation completes as applied with an HTTP 200 response snapshot in the same transaction.

## 8. Legacy Phone and Storage Preservation

Under P65-D2, an archived legacy Supplier with persisted `phone IS NULL` may restore to active
without remediation. If its persisted `normalized_phone` is also `NULL`, both values remain
`NULL`. Restore MUST NOT require or fabricate a phone, derive a fake normalized phone, backfill,
merge, replace the UUID, or turn lifecycle into a phone-edit workflow. Current new-Supplier
creation remains phone-required.

The separately representable state `phone IS NOT NULL AND normalized_phone IS NULL` receives no
special business meaning. Archive and restore preserve it without repair or rejection solely to
repair it. Lifecycle is not a general historical-data cleanup mechanism.

The database permits an active historical row with non-null `archived_at`, although supported
create establishes an unarchived active row and real restore sets `archived_at = NULL`. A
same-state restore no-op does not silently repair or rewrite such unrelated historical
inconsistency.

## 9. Same-State Semantic No-Op

P65-D1 freezes these genuinely new commands as successful no-ops:

```text
active   + restore -> HTTP 200 applied success
archived + archive -> HTTP 200 applied success
```

After target and current-version validation, the server completes and stores a replayable applied
operation response without issuing a Supplier UPDATE. It does not change row provenance, version,
`updatedAt`, or `archivedAt`; regenerate archive time; emit a Supplier event; or create a Supplier
UPDATE audit. The response reflects the unchanged factual Supplier state and accepted
`operationId`.

This is distinct from exact replay. A different operation ID creates a new logical operation. The
same operation ID and same canonical request exact-replays its stored result. A stale new
same-state command is rejected before no-op classification.

## 10. Optimistic Concurrency

The target row MUST be locked or protected by an equivalent atomic state/version predicate. The
actual mutation cannot use a detached version read followed by an unconditional UPDATE. No
lifecycle or ordinary PATCH operation may silently overwrite another committed state/version.

- Two new archive commands from the same active version permit at most one real archive. The
  stale loser returns `SUPPLIER_VERSION_CONFLICT`; a later archive using the current archived
  version is a P65-D1 no-op.
- Two new restore commands follow the same rule.
- Archive versus Task 6.4 PATCH permits at most one state-changing winner. The loser follows the
  observed stale-version or archived-target contract without overwriting the winner.
- Ordinary PATCH against archived state remains invalid. Restore never makes an already-issued
  archived-target PATCH implicitly valid.
- Opposing archive and restore commands serialize under row/state/version protection. Two stale
  assumptions cannot both perform real transitions.

A same-state no-op may precede a real opposing command using the same current version because the
no-op changes no row state. This is not last-write-wins; only one command performs a real
transition.

## 11. Operation Identity and Device Binding

Lifecycle reuses the Task 6.4 operation infrastructure. The physical claim identity is exactly:

```text
(trusted store_id, operation_id)
```

Device and fingerprint are not claim-key components. The immutable claim binding is:

```text
device_id       trusted authenticated device
aggregate_type  suppliers
aggregate_id    canonical Supplier UUID
action          archive | restore
request_hash    canonical lifecycle fingerprint
```

Any binding or fingerprint mismatch on an existing claim is `OPERATION_ID_CONFLICT`; the operation
is not rebound or duplicated. Another store may use the same operation ID without collision or
disclosure.

## 12. Canonical Request and Fingerprint

The server constructs a V1 fixed-order lifecycle projection after validation. Archive is exactly:

```text
v = 1
action = "supplier.archive"
supplierId
expectedVersion
```

Restore is exactly:

```text
v = 1
action = "supplier.restore"
supplierId
expectedVersion
```

`expectedVersion` is its canonical decimal string. The projection contains no lifecycle business
field. `storeId` and `operationId` belong to claim identity; device, aggregate, target, and action
are binding metadata. Request ID, user context, current state, generated `archivedAt`, generated
timestamps, response values, and connection/session data are not fingerprint input.

The request hash is SHA-256 over the UTF-8 bytes of deterministic fixed-order JSON, serialized as
lowercase hexadecimal. Caller property order cannot affect it. The hash and canonical request are
private and MUST NOT be returned or logged with Supplier-sensitive data.

## 13. Exact Replay and Changed Requests

After live authentication, trusted context, and Owner authorization, an existing completed claim
with the same immutable binding and fingerprint is exact replay. Applied replay returns the stored
original response status/body; rejected replay returns the stored original stable rejection.
Replay does not re-read target eligibility, revalidate the historical version, mutate the row,
regenerate archive time, or emit another event or audit. Later Supplier changes do not replace the
stored historical response snapshot.

Changed fingerprint, target, aggregate, action, or trusted device binding is
`OPERATION_ID_CONFLICT`. Minimized internal conflict evidence MUST NOT expose raw payloads, phone,
notes, device details, SQL, or foreign state. A matching claim still in `processing` returns
`OPERATION_IN_PROGRESS` and creates no second effect.

## 14. Authentication, Replay, and Store Status

Every attempt follows this order:

```text
live authentication/session
trusted tenant/user/device resolution
active Owner authorization
tenant transaction and current-store operation lookup
completed replay / changed-binding / processing resolution
new-write store gate
new operation claim
target lock and state/version validation
real lifecycle mutation or same-state no-op
stored operation completion
```

An active store permits eligible new operations and completed replay. A `read_only` store denies a
new lifecycle operation with `BUSINESS_WRITE_NOT_ALLOWED` but permits an eligible matching
completed applied or rejected replay because it creates no business effect. Changed request reuse
remains `OPERATION_ID_CONFLICT`, and processing remains explicit, before the new-write gate.

Suspended or archived Store state cannot use replay as an authentication bypass. Supplier archived
state is distinct from Store archived state.

## 15. Failure, Rejection, and Retry Matrix

| Condition                                         | New claim    | Completion            | Result state       | Replayable                     | Same-operation retry             | Public result                |
| ------------------------------------------------- | ------------ | --------------------- | ------------------ | ------------------------------ | -------------------------------- | ---------------------------- |
| Syntax/domain validation failure                  | No           | No                    | None               | No                             | Corrected request may reuse ID   | `VALIDATION_ERROR`           |
| Authentication/session failure                    | No           | No                    | None               | No                             | Retry after valid authentication | Shared authentication error  |
| Owner authorization failure                       | No           | No                    | None               | No                             | Retry only with valid authority  | `SUPPLIER_WRITE_NOT_ALLOWED` |
| New-write store gate rejection                    | No           | No                    | None               | No                             | Retry after store is eligible    | `BUSINESS_WRITE_NOT_ALLOWED` |
| Existing claim with changed binding/fingerprint   | No new claim | Original unchanged    | Original unchanged | Original matching request only | Conflict remains                 | `OPERATION_ID_CONFLICT`      |
| Matching existing processing claim                | No new claim | No new completion     | Processing         | Not yet                        | Retry later                      | `OPERATION_IN_PROGRESS`      |
| Supplier absent or foreign-equivalent after claim | Yes          | Yes                   | Rejected           | Yes                            | Exact rejection replay           | `SUPPLIER_NOT_FOUND`         |
| Stale expectedVersion after claim                 | Yes          | Yes                   | Rejected           | Yes                            | Exact rejection replay           | `SUPPLIER_VERSION_CONFLICT`  |
| Successful real archive                           | Yes          | Yes                   | Applied            | Yes                            | Exact success replay             | HTTP 200                     |
| Successful real restore                           | Yes          | Yes                   | Applied            | Yes                            | Exact success replay             | HTTP 200                     |
| Successful active + restore no-op                 | Yes          | Yes                   | Applied            | Yes                            | Exact success replay             | HTTP 200                     |
| Successful archived + archive no-op               | Yes          | Yes                   | Applied            | Yes                            | Exact success replay             | HTTP 200                     |
| Unexpected transaction/internal failure           | Rolled back  | No durable completion | None               | No                             | Same request may retry           | Generic internal error       |

Deterministic post-claim rejections are completed in the same transaction as the claim and exact-
replay even if state later changes. Pre-claim failures do not poison the operation ID. Unexpected
failure rolls back the claim and every business/database effect together.

## 16. Transaction, Change Events, and Audit

A genuinely new lifecycle command uses one trusted tenant transaction for operation lookup,
new-write gate, claim, target lock, state/version validation, real UPDATE or no-op, database
triggers, response snapshot, and operation completion. The system MUST NOT commit a Supplier
transition without completion or completion without its Supplier transition.

Real archive emits one trigger-owned `archive` change event and one central UPDATE audit. Real
restore emits one trigger-owned generic `update` change event and one central UPDATE audit, while
the processed logical action remains `restore`. Exact replay and P65-D1 no-op emit no Supplier
business event or UPDATE audit. Rejected operation metadata is distinct from a Supplier row audit.
No manual duplicate event is authorized.

Unexpected failure rolls back claim, row mutation, version/timestamp, event, audit, and completion.
No half-completed or permanently stuck operation may remain solely from transaction rollback.

## 17. Response, Errors, and Privacy

Real archive, real restore, and successful same-state no-op return HTTP 200 with the Supplier
detail projection plus the accepted operation ID:

```text
id
name
phone
notes
status
archivedAt
createdAt
updatedAt
version
operationId
```

Version is a decimal string. Timestamps are UTC ISO-8601 strings. Legacy phone may be `null`.
Same-state no-op returns unchanged state, version, and timestamps; archived no-op preserves its
existing archive timestamp. Exact replay returns the original stored snapshot.

Stable lifecycle conditions are:

| Condition                                    | Public code/category         |
| -------------------------------------------- | ---------------------------- |
| Malformed input, UUID, or expectedVersion    | `VALIDATION_ERROR`           |
| Invalid authentication/session               | Shared authentication error  |
| Non-owner or trusted-context mismatch        | `SUPPLIER_WRITE_NOT_ALLOWED` |
| New write while Store is not active          | `BUSINESS_WRITE_NOT_ALLOWED` |
| Same-store absent or foreign Supplier target | `SUPPLIER_NOT_FOUND`         |
| Stale lifecycle command                      | `SUPPLIER_VERSION_CONFLICT`  |
| Changed operation binding/content            | `OPERATION_ID_CONFLICT`      |
| Matching operation still processing          | `OPERATION_IN_PROGRESS`      |

Validation uses HTTP 400, authentication uses the shared status, authorization/store gate uses
403, not-found uses 404, lifecycle/operation conflicts use 409, and success uses 200. Same-state
commands are not errors.

Responses and logs MUST NOT expose `storeId`, normalized values, `deviceId`, request hash,
processed-operation state, constraint names, SQL, stack traces, conflict internals, foreign target
state, or foreign operation existence. Absent and foreign Supplier UUIDs are observationally
identical. Operation lookup is always current-store scoped.

## 18. Database, Offline, and Future-Workflow Boundary

The existing PostgreSQL table, Drizzle mapping, SQLite reference, forced RLS, touch/no-delete/
change/audit triggers, `(store_id, normalized_phone)` uniqueness, and
`sync.processed_operations` infrastructure are sufficient. Task 6.5 requires:

```text
PostgreSQL schema change  none
new index                 none
Drizzle change            none
SQLite change             none
migration                 none
reference change          none
```

Offline-compatible backend semantics are stable Supplier UUID, stable operation ID, required
expectedVersion, deterministic lifecycle fingerprint, exact replay, same-state no-op, explicit
stale conflict, tenant-scoped claims, lossless version, and no silent LWW.

The following remain deferred and MUST NOT be inferred from Supplier lifecycle state in this task:

- Supplier Invoice eligibility;
- Supplier Payment eligibility;
- Goods Receipt or manual inventory eligibility;
- purchase and costing workflow eligibility;
- Flutter/mobile lifecycle UI and local queue behavior;
- offline conflict UI; and
- future Sync interpretation of processed `restore` versus generic database `update` event.

## 19. Future Implementation Verification Gates

Future implementation and independent review MUST prove:

1. only a live active Shop Owner with matching trusted store/user/device context can issue
   lifecycle commands, with forced RLS and no platform-admin bypass;
2. strict routes accept only canonical Supplier ID, operation ID, and lossless expectedVersion;
3. active-to-archived and archived-to-active preserve the same row, UUID, business fields, and
   historical references while changing lifecycle exactly once;
4. archive uses server/database UTC archive time, restore clears it, and real mutations advance
   version and `updatedAt` exactly once through database triggers;
5. archived non-null phone remains reserved, restore does not reacquire it, P65-D2 restores
   legacy `NULL` phone without repair, and normalized-phone-only inconsistency gains no repair
   policy;
6. P65-D1 same-state commands validate current version, complete as replayable applied results,
   and perform no Supplier UPDATE, provenance/version/timestamp change, event, or UPDATE audit;
7. claim identity remains `(store_id, operation_id)` and device/aggregate/target/action/hash
   binding is exact without making device or hash a claim key;
8. V1 archive/restore projections are fixed-order and deterministic, and exclude request ID,
   operation ID, generated archive time, current state, response state, and connection metadata;
9. applied and rejected exact replay returns the stored result, changed binding/hash conflicts,
   processing remains explicit, and concurrent identical attempts create one authoritative effect;
10. active stores permit new lifecycle commands, read-only stores deny new commands but permit
    eligible completed replay, and suspended/archived Store sessions gain no replay bypass;
11. the complete failure/rejection matrix preserves pre-claim, post-claim, completion, retry, and
    replay semantics;
12. archive/archive, restore/restore, archive/PATCH, restore/PATCH, and archive/restore races use
    atomic state/version protection with no stale LWW;
13. claim, lifecycle result, triggers, response snapshot, and completion commit or roll back
    together, with no duplicate event/audit on replay or same-state no-op;
14. archive emits one `archive` event, restore emits one generic `update` event, processed restore
    action remains `restore`, and no manual duplicate event is added;
15. responses serialize version/timestamps losslessly, preserve nullable legacy phone, and expose
    no tenant, normalization, device, hash, SQL, constraint, or foreign-existence detail;
16. no hard delete, Task 6.6 behavior, accounting, payable, payment, receipt, inventory, stock,
    costing, COGS, migration, PostgreSQL, Drizzle, SQLite, or reference change is introduced.
