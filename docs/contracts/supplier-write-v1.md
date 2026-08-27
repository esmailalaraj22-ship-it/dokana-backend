# Supplier Write and Idempotency Contract v1

## 1. Scope, Authority, and Provenance

This contract freezes Station 6 / Task 6.4 Supplier create and ordinary partial-update behavior.
It is the authoritative Supplier write contract for the current MVP. It defines request
canonicalization, optimistic concurrency, operation claims, exact replay, deterministic
rejections, transaction boundaries, public responses, and privacy behavior.

This contract follows, in order:

1. backend-owner decisions P64-D1 and P64-D2 and root `AGENTS.md`;
2. the closed Supplier contracts:
   `docs/contracts/supplier-database-contract.md`,
   `docs/contracts/supplier-validation-v1.md`, and
   `docs/contracts/supplier-read-v1.md`;
3. `docs/product/Dokana_PRD_v1.1_APPROVED.md`;
4. approved Customer and Product mutation precedents where consistent with Supplier authority;
5. applied migrations, the live PostgreSQL contract, shared mutation infrastructure, reviewed
   Drizzle mappings, and the immutable PostgreSQL/SQLite reference package for physical facts.

Normative rules use these provenance classes:

- **OWNER-DECIDED:** P64-D1 or P64-D2.
- **CLOSED SUPPLIER CONTRACT:** behavior frozen by Tasks 6.1 through 6.3.
- **SHARED ARCHITECTURE INVARIANT:** permanent tenant, security, transaction, or synchronization
  rule.
- **DERIVED FROM APPROVED CLOSED PRECEDENT:** domain-consistent Customer/Product behavior that
  does not override Supplier policy.
- **IMPLEMENTATION MECHANIC ALREADY ESTABLISHED:** verified shared PostgreSQL or NestJS mechanism.
- **DEFERRED TO TASK 6.5:** lifecycle behavior deliberately outside this task.

This contract does not implement routes, services, repositories, tests, migrations, Drizzle,
PostgreSQL, SQLite, mobile code, or synchronization workers. Task 6.4 implementation MUST undergo
separate verification and independent review.

## 2. Supplier Domain and Accounting Boundary

**Provenance: CLOSED SUPPLIER CONTRACT; SHARED ARCHITECTURE INVARIANT.**

A Supplier is shop-owned master data. It is not a user, login, membership, employee, role,
session, or portal. Supplier `id` is durable identity. Phone is a tenant-scoped contact and
uniqueness attribute; changing it MUST NOT create a new Supplier identity.

Supplier create and PATCH are master-data mutations only. They MUST NOT create or mutate a
Supplier Invoice, payable, Supplier balance, payment, expense, journal, money account or movement,
Goods Receipt, partial receipt, inventory movement, stock balance, warehouse, shelf, location,
costing, COGS, or purchase posting.

The permanent boundaries remain:

```text
Supplier master data != Supplier Invoice
Supplier Invoice != Goods Receipt
Supplier Invoice != manual inventory entry
Supplier Payment != a second expense
```

Supplier Invoice and manual inventory entry may later carry optional traceability references, but
neither operation creates the other.

## 3. Actor, Trusted Context, and RLS

**Provenance: CLOSED SUPPLIER CONTRACT; SHARED ARCHITECTURE INVARIANT.**

Only an authenticated Shop Owner with an active `owner` membership may create or PATCH Suppliers
in the current MVP. `manager`, `viewer`, `support`, employee, staff, and platform-administrator
identity do not grant ordinary Supplier write authority. A denied authenticated actor receives
`SUPPLIER_WRITE_NOT_ALLOWED`.

The server MUST derive store, user, and device from the live authenticated session and MUST derive
`requestId` from request infrastructure. The client MUST NOT authoritatively supply `storeId`,
`tenantId`, `userId`, `deviceId`, role, lifecycle state, version, timestamps, or normalized fields.
The principal's store, user, and device MUST match the trusted mutation context.

Every persistence or operation-state query MUST run through
`DatabaseService.withTenantTransaction` on the same connection and transaction. The transaction
MUST install transaction-local `app.store_id`, `app.user_id`, `app.device_id`, and
`app.request_id`. Explicit same-store predicates MUST supplement, not replace, forced RLS.

RLS on `ledger.suppliers` and relevant `sync` objects MUST remain enabled, forced where defined,
and fail closed. Normal runtime MUST remain non-owner, non-superuser, non-`BYPASSRLS`, and unable
to assume migration or administrative roles. No client-selected tenant and no platform-admin
shortcut may broaden Supplier access.

## 4. Routes and Create Contract

**Provenance: CLOSED SUPPLIER CONTRACT; DERIVED FROM APPROVED CLOSED PRECEDENT.**

The future HTTP mutations are:

- `POST /v1/suppliers` for create;
- `PATCH /v1/suppliers/:supplierId` for ordinary partial update.

The create body MUST contain:

| Category         | Public input  | Rule                                                                           |
| ---------------- | ------------- | ------------------------------------------------------------------------------ |
| Entity identity  | `id`          | Required canonical Supplier UUID; referred to internally as `supplierId`       |
| Mutation control | `operationId` | Required canonical operation UUID                                              |
| Business         | `name`        | Required; Task 6.2 canonicalization                                            |
| Business         | `phone`       | Required, non-null, nonblank, valid, extension-free; Task 6.2 canonicalization |
| Business         | `notes`       | Optional valid string or `null`                                                |

The accepted client Supplier UUID MUST be preserved exactly in canonical lowercase text. The
server MUST NOT replace it with another UUID. Duplicate Supplier names are allowed; neither name
nor `normalizedName` is unique Supplier identity.

Create notes semantics are:

- omitted or explicit `null` persists SQL `NULL`;
- `""` persists an empty string;
- valid whitespace-only text persists exactly;
- notes MUST NOT be trimmed, normalized, or converted between empty and null.

The server MUST derive `normalizedName` and `normalizedPhone`. It MUST persist the trusted
`storeId`, trusted `deviceId`, and accepted `operationId`. New rows MUST use `status = active`,
`archivedAt = NULL`, database-owned initial `version = 1`, and database/server-owned UTC
`createdAt` and `updatedAt`.

A new successful create returns HTTP `201` and the response in Section 16. Supplier UUID collision
is handled by Section 14; accepted IDs never overwrite rows.

## 5. PATCH Contract

**Provenance: CLOSED SUPPLIER CONTRACT; OWNER-DECIDED; DERIVED FROM APPROVED CLOSED PRECEDENT.**

PATCH is partial and MUST include `operationId`, `expectedVersion`, and at least one of `name`,
`phone`, or `notes`. No other Supplier business field is mutable in Task 6.4.

| Field   | Omitted                          | Explicit `null` | Supplied value                                                                                               |
| ------- | -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`  | Unchanged                        | Reject          | Apply Task 6.2 display and normalized-name canonicalization; blank rejects                                   |
| `phone` | Unchanged, including legacy null | Reject          | Apply Task 6.2 display and normalized-phone canonicalization; blank, malformed, or extension-bearing rejects |
| `notes` | Unchanged                        | Set SQL `NULL`  | Preserve valid string exactly, including empty or whitespace-only text                                       |

The client MUST NOT PATCH `id`, `storeId`, `normalizedName`, `normalizedPhone`, `status`,
`archivedAt`, `version`, `createdAt`, `updatedAt`, `deviceId`, persisted `operationId`, or operation
infrastructure fields. Unknown fields MUST be rejected by the strict request boundary; request
objects MUST NOT be spread into persistence operations.

A phone that canonicalizes to the target Supplier's current display and normalized values MUST
not self-conflict. A display-phone formatting change that preserves the same normalized phone is
a real business-state change because Task 6.2 deliberately preserves the canonical display phone.

## 6. Legacy NULL-Phone Policy

**Provenance: OWNER-DECIDED (P64-D1).**

An active legacy Supplier with persisted `phone IS NULL` and/or `normalized_phone IS NULL` MAY
PATCH unrelated mutable fields while preserving that exact legacy state. Omitting `phone` MUST
preserve the stored phone fields and MUST NOT cause repair, backfill, fabrication, merge, archive,
delete, or rejection solely because the stored phone is null.

If a valid phone is explicitly supplied, Task 6.2 canonicalization applies and the canonical
display and normalized values become the proposed state. Explicit `phone: null`, blank,
whitespace-only, malformed, or extension-bearing phone is invalid. Task 6.4 introduces no phone
removal command.

## 7. Archived Eligibility and Task 6.5 Boundary

**Provenance: DERIVED FROM APPROVED CLOSED PRECEDENT; DEFERRED TO TASK 6.5.**

Ordinary Task 6.4 PATCH is active-only. An archived same-store Supplier MUST be rejected with
`SUPPLIER_ARCHIVED`. A missing Supplier and a Supplier visible only in another store MUST both
produce `SUPPLIER_NOT_FOUND`.

Task 6.4 MUST NOT archive, restore, reactivate, hard delete, PATCH `status`, PATCH `archivedAt`, or
implicitly restore an archived row. Task 6.5 owns `active <-> archived`, lifecycle idempotency,
and legacy null-phone restore policy. Normal Supplier lifecycle has no hard-delete operation.

## 8. Optimistic Concurrency and Canonical No-Op

**Provenance: SHARED ARCHITECTURE INVARIANT; OWNER-DECIDED (P64-D2).**

Every genuinely new PATCH MUST provide `expectedVersion` as a canonical positive decimal string
within PostgreSQL `bigint` range. JavaScript `Number` MUST NOT be authoritative. `expectedVersion`
participates in the canonical update request fingerprint.

For a new operation, the repository MUST establish, under a race-safe row lock or equivalent
atomic predicate, that the target is same-tenant, active, and at `expectedVersion`. A concurrent
archive or update MUST NOT be overwritten. A stale value returns `SUPPLIER_VERSION_CONFLICT`; no
silent last-write-wins is allowed.

Only after active-state and version validation may the server compare the resulting canonical
mutable state:

```text
name, normalized_name, phone, normalized_phone, notes
```

If every resulting value equals the persisted value, the mutation is a successful canonical
no-op. It MUST return HTTP `200`, complete the operation as `applied`, and store its replayable
response. It MUST NOT issue an UPDATE to `ledger.suppliers`, change `device_id` or
`operation_id` on that row, increment `version`, change `updated_at`, emit a Supplier change event,
or create a Supplier business-update audit effect.

A stale request does not become a no-op merely because its requested values equal current values.
Exact replay of an already completed operation is resolved earlier and does not revalidate
`expectedVersion` as a new write.

## 9. Operation Claim Identity and Binding

**Provenance: SHARED ARCHITECTURE INVARIANT; IMPLEMENTATION MECHANIC ALREADY ESTABLISHED.**

`operationId` is a client-supplied logical mutation UUID, stable across retries. It is distinct
from `requestId`, which may differ on every HTTP attempt.

The physical and logical operation claim key is exactly:

```text
(trusted store_id, operation_id)
```

This is the primary key and lookup key of `sync.processed_operations`. Device is **not** part of
the claim key. The claim record MUST nevertheless bind these immutable values:

```text
device_id       = trusted authenticated device
aggregate_type  = suppliers
aggregate_id    = canonical Supplier id
action          = create | update
request_hash    = canonical request fingerprint
```

The binding fields are not alternate lookup keys. Once `(store_id, operation_id)` exists, any
mismatch in device, aggregate type, aggregate ID, action, or request fingerprint is
`OPERATION_ID_CONFLICT`. Therefore a retry from another trusted device conflicts rather than
creating or replaying a different logical operation.

Another store may use the same `operationId` without collision or disclosure. Request identity
and fingerprint comparison MUST use only trusted current-store access under RLS; no global lookup
is authorized.

## 10. Canonical Request and Fingerprint

**Provenance: IMPLEMENTATION MECHANIC ALREADY ESTABLISHED; SHARED ARCHITECTURE INVARIANT.**

The server MUST build the canonical request after pure validation and Task 6.2 canonicalization.
Raw JSON bytes, client property order, insignificant outer whitespace, UUID letter case, and
other raw representations removed by approved canonicalization MUST NOT determine request
identity.

Supplier write request version 1 uses a fixed ordered JSON projection and SHA-256 over its UTF-8
JSON bytes, producing a lowercase 64-character hexadecimal `request_hash`. Implementations MUST
construct keys in the order below; relying on caller-controlled or incidental object insertion
order is forbidden. Changing projection semantics or key order requires a new version/domain and
MUST NOT reinterpret stored V1 hashes.

The create projection is exactly, in order:

```text
v = 1
action = "supplier.create"
supplierId
name
normalizedName
phone
normalizedPhone
notes
```

For create, omitted and explicit-null notes both project as `notes: null` because they have the
same create semantics.

The update projection starts exactly, in order, with:

```text
v = 1
action = "supplier.update"
supplierId
expectedVersion
```

It then includes only explicitly supplied mutable fields in this fixed order:

```text
name, normalizedName, phone, normalizedPhone, notes
```

When name or phone is supplied, its display and normalized pair MUST both be present. Omitted
fields are absent. Explicit-null notes is present as `null`. `expectedVersion` is its canonical
decimal string. The same `operationId` and business fields with a different `expectedVersion`
therefore produce a different fingerprint and MUST return `OPERATION_ID_CONFLICT` once the claim
already exists.

`storeId` and `operationId` belong to the claim identity, while device, aggregate, and action are
checked as binding metadata. `requestId`, trusted user context, timestamps, current database
state, and response data are not fingerprint input. Excluding them keeps the content fingerprint
semantically distinct from the claim key and permits retries with a new request ID.

Two inputs are fingerprint-equivalent only when Task 6.2 produces the same persisted canonical
display and normalized state. Phone forms that produce the same `normalizedPhone` but different
preserved display `phone` are not equivalent. Omitted PATCH fields and explicit null remain
different whenever their business semantics differ.

The fingerprint is internal. It MUST NOT be returned, logged with raw phone/notes, or used as a
public identifier.

## 11. Exact Replay and Changed-Payload Reuse

**Provenance: SHARED ARCHITECTURE INVARIANT; IMPLEMENTATION MECHANIC ALREADY ESTABLISHED.**

After live authentication, trusted context resolution, and Owner authorization, an existing
completed operation with the same claim key, binding metadata, and fingerprint is exact replay.

An `applied` replay MUST return the stored original response status and body. A `rejected` replay
MUST return the stored original rejection status and stable error. Replay MUST NOT rerun Supplier
lookup, version checks, uniqueness checks, mutation, row triggers, change events, or Supplier
business audit. If the Supplier changed later, replay still returns the original stored snapshot,
not current row state.

The same claim key with any binding or fingerprint mismatch returns
`OPERATION_ID_CONFLICT`. It MUST NOT mutate the Supplier or replace the original operation. The
system MUST record only minimized internal `sync.conflicts` evidence sufficient for diagnosis,
such as aggregate/action/fingerprint metadata; raw requests, phone, notes, SQL, and foreign entity
details MUST NOT be stored as conflict evidence merely for this classification or exposed
publicly.

An existing matching operation still in `processing` returns `OPERATION_IN_PROGRESS`. A later
retry may resolve to the stored applied or rejected result. No second business effect is allowed.

## 12. Failure, Rejection, and Retry Matrix

**Provenance: IMPLEMENTATION MECHANIC ALREADY ESTABLISHED; SHARED ARCHITECTURE INVARIANT.**

| Condition                                              | New claim created?             | Completed operation stored? | Replayable?                                | Same `operationId` retry               | Public result                |
| ------------------------------------------------------ | ------------------------------ | --------------------------- | ------------------------------------------ | -------------------------------------- | ---------------------------- |
| Pure syntax/domain validation failure                  | No                             | No                          | No                                         | Corrected request may reuse the ID     | `VALIDATION_ERROR`           |
| Authentication/session failure                         | No                             | No                          | No                                         | May retry after valid authentication   | Shared authentication error  |
| Owner authorization failure                            | No                             | No                          | No                                         | May retry only with valid authority    | `SUPPLIER_WRITE_NOT_ALLOWED` |
| New-write store gate rejection                         | No                             | No                          | No                                         | May retry after store becomes eligible | `BUSINESS_WRITE_NOT_ALLOWED` |
| Existing claim with changed binding/fingerprint        | No new claim; original remains | Original unchanged          | Only the original matching request replays | Changed request remains conflict       | `OPERATION_ID_CONFLICT`      |
| Matching existing `processing` claim                   | No new claim                   | No new completion           | Not yet                                    | Retry later                            | `OPERATION_IN_PROGRESS`      |
| Same-store target absent or foreign target after claim | Yes                            | Yes, `rejected`             | Yes, same binding/fingerprint              | Replays rejection                      | `SUPPLIER_NOT_FOUND`         |
| Stale `expectedVersion` after claim                    | Yes                            | Yes, `rejected`             | Yes                                        | Replays rejection                      | `SUPPLIER_VERSION_CONFLICT`  |
| Duplicate same-store phone after claim                 | Yes                            | Yes, `rejected`             | Yes                                        | Replays rejection                      | `SUPPLIER_PHONE_CONFLICT`    |
| Archived Supplier PATCH after claim                    | Yes                            | Yes, `rejected`             | Yes                                        | Replays rejection                      | `SUPPLIER_ARCHIVED`          |
| Supplier UUID collision after claim                    | Yes                            | Yes, `rejected`             | Yes                                        | Replays rejection                      | `CONFLICT`                   |
| Unexpected internal/transaction failure                | Rolled back                    | No durable completion       | No                                         | May retry the same request             | Generic internal error       |
| Successful real create/update                          | Yes                            | Yes, `applied`              | Yes                                        | Exact replay returns original success  | `201` create / `200` PATCH   |
| Successful canonical no-op                             | Yes                            | Yes, `applied`              | Yes                                        | Exact replay returns original success  | `200`                        |

Deterministic post-claim rejections MUST be completed in the same transaction as the claim. An
unexpected transaction failure MUST roll back the claim, Supplier effects, events, audit effects,
and completion together. A rolled-back transaction MUST NOT leave a permanently stuck operation.

## 13. Authentication, Replay, and Store-Status Ordering

**Provenance: SHARED ARCHITECTURE INVARIANT; DERIVED FROM APPROVED CLOSED PRECEDENT.**

Every attempt MUST follow this security order:

```text
live authentication/session
-> trusted tenant/user/device context
-> active Owner authorization
-> tenant-scoped transaction and operation lookup
-> exact completed replay / changed-payload / processing resolution
-> new-write store gate
-> new operation claim
-> new Supplier mutation
```

For an `active` store, eligible new mutations and completed exact replays are allowed. For a
`read_only` store, a genuinely new mutation is denied with `BUSINESS_WRITE_NOT_ALLOWED`, while an
eligible matching completed `applied` or `rejected` operation may return its stored result because
that replay creates no business effect. Changed-payload reuse remains a conflict. A matching
`processing` operation remains `OPERATION_IN_PROGRESS` and performs no new write.

Suspended or archived store state MUST NOT use replay as an authentication bypass. When the shared
authentication/session contract invalidates the session, operation lookup and replay are not
available through that session.

The new-write status check MUST occur transactionally and race-safely. The generic
`withBusinessWriteTransaction` cannot wrap operation lookup when doing so would reject eligible
read-only replay; the implementation MUST preserve the ordering above within the trusted tenant
transaction.

## 14. Phone and UUID Conflict Authority

**Provenance: CLOSED SUPPLIER CONTRACT; IMPLEMENTATION MECHANIC ALREADY ESTABLISHED.**

One non-null `normalized_phone` may belong to at most one Supplier in the same store. Archived
Suppliers continue reserving their non-null phone. The same normalized phone in another store is
allowed and MUST NOT produce a conflict.

An application same-store pre-check MAY improve classification, but PostgreSQL uniqueness is the
final race-safe authority. The implementation MUST map SQLSTATE `23505` only with the known
`suppliers_store_id_normalized_phone_key` identity to `SUPPLIER_PHONE_CONFLICT`; it MUST NOT parse
English error text. Constraint names, SQL, normalized phone, and conflicting Supplier identity
MUST NOT be exposed.

A client Supplier UUID collision, whether same-store or foreign-store, returns the same generic
`CONFLICT` without a privileged global lookup or disclosure of row ownership. Exact replay is
resolved before collision handling. Accepted IDs never overwrite existing rows.

## 15. Transaction, Change Events, and Audit

**Provenance: SHARED ARCHITECTURE INVARIANT; IMPLEMENTATION MECHANIC ALREADY ESTABLISHED.**

A genuinely new mutation MUST use one tenant transaction for all applicable work:

```text
trusted transaction-local context
operation lookup and new-write gate
operation claim
Supplier same-tenant/state/version checks
phone/UUID constraint handling
Supplier INSERT or real UPDATE
database-authoritative version/timestamp triggers
Supplier change event and central audit trigger
stored operation response or rejection
```

A real create MUST emit one Supplier create change event and one established central business
audit effect. A real PATCH MUST atomically update the active row at the expected version, persist
trusted device/operation provenance, advance version once through the database trigger, update
`updatedAt`, emit one Supplier update change event, and preserve the established central audit
effect.

Exact replay emits no duplicate Supplier event or business audit. Canonical no-op performs no
Supplier row write and therefore emits no Supplier event or Supplier business-update audit.
Operation-state and minimized conflict evidence are separate from Supplier business mutation
audit. Application logs MUST NOT add raw phone, notes, canonical request, or database values.

The transaction MUST never commit `Supplier changed + operation incomplete` or
`operation completed + Supplier rolled back`.

## 16. Response, Errors, and Privacy

**Provenance: CLOSED SUPPLIER CONTRACT; DERIVED FROM APPROVED CLOSED PRECEDENT.**

Successful create (`201`) and PATCH (`200`) responses MUST contain the Supplier detail projection
plus the accepted `operationId`:

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

`version` MUST be a lossless decimal string. Timestamps MUST be UTC ISO-8601 strings. Legacy null
phone is returned as `phone: null`. Canonical no-op returns unchanged version and timestamps.
Exact replay returns the original stored response version and timestamps.

Responses MUST NOT expose `storeId`, normalized values, `deviceId`, request fingerprint,
processed-operation state, conflict evidence, SQL, constraint names, or internal sync metadata.

The stable conditions are:

| Condition                                                      | Stable public code/category  |
| -------------------------------------------------------------- | ---------------------------- |
| Malformed Supplier/operation UUID, input, or `expectedVersion` | `VALIDATION_ERROR`           |
| Unauthenticated or invalid session                             | Shared authentication error  |
| Authenticated non-owner or context mismatch                    | `SUPPLIER_WRITE_NOT_ALLOWED` |
| New write while store is not active                            | `BUSINESS_WRITE_NOT_ALLOWED` |
| Same-store absent or foreign Supplier target                   | `SUPPLIER_NOT_FOUND`         |
| Archived ordinary PATCH                                        | `SUPPLIER_ARCHIVED`          |
| Stale update                                                   | `SUPPLIER_VERSION_CONFLICT`  |
| Same-store duplicate phone                                     | `SUPPLIER_PHONE_CONFLICT`    |
| Reused operation with changed binding/content                  | `OPERATION_ID_CONFLICT`      |
| Matching operation still processing                            | `OPERATION_IN_PROGRESS`      |
| Supplier UUID collision                                        | `CONFLICT`                   |

Validation uses HTTP `400`, authentication uses the established shared status, write
authorization and store gate use HTTP `403`, not-found uses HTTP `404`, and mutation conflicts use
HTTP `409`. Raw PostgreSQL errors and stack traces MUST NOT cross the API boundary.

A well-formed Supplier UUID absent in the current store and one existing only in another store are
observationally identical. A phone used only in another store does not conflict. An operation ID
used only in another store does not conflict or reveal foreign operation existence.

## 17. Database and Offline Boundary

**Provenance: CLOSED SUPPLIER CONTRACT; SHARED ARCHITECTURE INVARIANT; IMPLEMENTATION MECHANIC
ALREADY ESTABLISHED.**

The current infrastructure is sufficient for this contract:

- `ledger.suppliers` provides preservable UUID, nullable legacy phone, tenant uniqueness,
  lifecycle, version, provenance, RLS, triggers, and audit/change integration;
- `sync.processed_operations` provides `(store_id, operation_id)` claims, binding metadata,
  SHA-256 request-hash storage, `processing/applied/rejected` status, response code/body, stable
  error, and completion time;
- `sync.conflicts` provides minimized changed-request evidence;
- the established tenant transaction makes claim, Supplier effect, events, audit, and completion
  atomic.

Task 6.4 requires no PostgreSQL schema or index change, Drizzle change, SQLite change, migration,
baseline rewrite, or reference-package change.

The frozen offline-compatible backend semantics are stable Supplier UUID, stable `operationId`,
deterministic canonical request identity, exact replay, `expectedVersion`, no silent LWW,
tenant-safe conflicts, and lossless versions. This contract does not design Flutter, Drift,
SQLite repositories, mobile queues, Sync push/pull, bootstrap, conflict UI, or multi-device
resolution.

## 18. Future Implementation Verification Gates

**Provenance: SHARED ARCHITECTURE INVARIANT; OWNER-DECIDED.**

Future Task 6.4 implementation and tests MUST prove:

1. only a live active Shop Owner with matching trusted store/user/device context may write;
2. forced/fail-closed RLS, explicit same-store predicates, least-privilege runtime, and pooled
   transaction-context isolation remain intact;
3. create preserves approved Supplier UUID, requires canonical name/phone, preserves notes
   semantics, permits duplicate names, applies verified defaults, and returns the exact projection;
4. same-store duplicate phone rejects under concurrent races, archived phone remains reserved,
   cross-store reuse succeeds, and current Supplier phone does not self-conflict;
5. PATCH accepts only name/phone/notes, distinguishes omission/null/empty, requires at least one
   supplied mutable field, and cannot mutate lifecycle or server-owned state;
6. P64-D1 permits unrelated updates to active legacy null-phone rows, preserves omitted null phone,
   accepts a valid supplied repair, and rejects explicit null/blank/malformed phone;
7. every new PATCH requires lossless `expectedVersion`; stale and concurrent archive/update paths
   are atomic and cannot silently overwrite;
8. P64-D2 no-op succeeds only after version/state validation, completes and replays, and performs
   no Supplier UPDATE, provenance change, version/timestamp change, Supplier event, or fake
   business audit;
9. claim identity and fingerprint remain distinct; `(store_id, operation_id)` is the only claim
   key; device/aggregate/target/action/hash binding is enforced exactly;
10. the fixed V1 projection produces deterministic SHA-256 hashes independent of raw JSON order,
    UUID case, and removed outer whitespace while preserving omitted/null/display distinctions;
11. exact applied and rejected replay returns the original stored result; changed binding/payload
    conflicts; concurrent identical attempts create one business effect; processing is explicit;
12. every row of Section 12 follows its exact claim/completion/replay/retry contract, including
    rollback of unexpected transaction failures;
13. active new writes work, read-only new writes fail, eligible read-only completed replay works,
    and suspended/archived sessions receive no replay bypass;
14. foreign target, phone, UUID collision, and operation behavior disclose no foreign existence;
15. real create/update, database triggers, change event, audit, and operation completion are one
    atomic transaction with no duplicate effects on replay;
16. responses serialize bigint/timestamps losslessly and expose no tenant, normalized, device,
    fingerprint, SQL, constraint, conflict, or internal operation data;
17. no Supplier create/PATCH causes accounting, payable, payment, expense, money, receipt,
    inventory, stock, costing, or COGS effects;
18. Task 6.5 remains unimplemented and PostgreSQL, SQLite, Drizzle, migrations, tests, and the
    immutable reference package change only in their separately approved implementation phase.
