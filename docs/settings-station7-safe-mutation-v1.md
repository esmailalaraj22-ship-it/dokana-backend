# Station 7 Task 7.4: Safe Settings Mutation and Initialization

## Scope

Task 7.4 implements the owner-authorized `PATCH /v1/settings` workflow and the
internal controlled settings initializer defined by the frozen
[`store-settings-operational-time-v1`](contracts/store-settings-operational-time-v1.md)
contract and its
[`addendum A`](contracts/store-settings-operational-time-v1-addendum-a.md).
It introduces no PostgreSQL or SQLite schema change, no migration, no generic
Sync engine, and no accounting or inventory behavior.

## Mutation Contract

The PATCH body contains a canonical UUID `operationId`, a positive PostgreSQL
bigint decimal-string `expectedVersion`, and at least one of:

- `dailyReportTimeMinutes` (`0..1439`)
- `defaultCreditPolicy` (`warn` or `block` for new writes)
- `defaultCreditLimitMinor` (non-negative bigint decimal string or explicit
  `null`)
- `allowNegativeStock` (boolean)
- `lowStockAlertEnabled` (boolean)
- `debtAgeAlertDays` (`0..2147483647`)
- `backupEnabled` (boolean)
- `backupIntervalHours` (`1..2147483647`)

Omitted fields remain unchanged. Only `defaultCreditLimitMinor` accepts null.
The global strict DTO boundary rejects unknown fields, trusted identity and
tenant fields, timestamps, version mutation, timezone/business-day fields, and
device-local URI fields. The repository constructs an explicit update object;
it never passes a request object to Drizzle.

A persisted legacy credit policy of `allow` remains readable and survives an
unrelated PATCH. It cannot be submitted as new input. Money and version values
remain `bigint` internally and decimal strings at the API boundary, including
values above JavaScript's safe-integer limit.

## Authorization and Tenant Boundary

The authenticated Store owner is the only ordinary Shop actor allowed to
mutate settings. Principal Store, user, and device must match the trusted
server-derived transaction context. An unseen operation requires an active
Store. A `read_only` Store rejects new operations but may retrieve an exact
completed applied or rejected result after current authentication and owner
authorization pass. Suspended and archived Store sessions remain rejected by
the authentication boundary.

All operation and settings access runs through one tenant transaction with
transaction-local Store, user, device, and request context. Forced RLS and
explicit Store predicates remain active. No client Store selector is accepted.

## Idempotency and Concurrency

The physical claim key is `(trusted store_id, operation_id)`. The immutable
binding is trusted device, aggregate type `app_settings`, aggregate ID equal to
the trusted Store ID, action `update`, and request fingerprint.

The SHA-256 fingerprint is computed over a fixed-order JSON projection:

```text
v = 1
action = settings.update
expectedVersion = canonical positive decimal text
only supplied mutable fields in the approved field order
```

`operationId`, `requestId`, timestamps, current state, and transport metadata
are excluded. Explicit nullable-limit clearing remains distinct from omission.

An existing matching applied operation returns its stored original settings
snapshot. A stored deterministic rejection returns its original stable status,
code, and message; the shared HTTP error envelope still supplies the current
attempt's request ID, timestamp, and path. Changed binding or fingerprint
returns `OPERATION_ID_CONFLICT`; a matching processing operation returns
`OPERATION_IN_PROGRESS`.

New mutations lock the settings singleton and compare the complete resource
version before no-op classification. A stale request returns the stored,
replayable `SETTINGS_VERSION_CONFLICT`. A missing singleton returns the stored,
replayable `SETTINGS_NOT_INITIALIZED`; PATCH never upserts it.

A same-value command is an applied canonical no-op. It stores a replayable
operation response but does not issue a settings UPDATE, increment version,
change `updatedAt`, or create a settings change event. Real concurrent writers
using the same version allow at most one state-changing winner.

## Controlled Initialization

`AppSettingsInitializationService.ensureForStore` is an internal capability;
there is no public initialization endpoint and no currently approved caller.
Future approved Store provisioning may call it with trusted tenant context and
all eight explicit application-owned policy values.

The initializer runtime-validates those values, requires the fixed
`Asia/Hebron` / `fixed_24h` contract, writes both device-local URI columns as
null, and explicitly supplies the inert preparatory `720/720` physical values.
Version and timestamps remain database-managed. `INSERT ... ON CONFLICT DO
NOTHING` preserves a singleton under concurrent identical initialization and
never resets an existing row. The active Store business-write gate applies;
GET, PATCH, and `read_only` Stores never initialize settings.

## Atomicity and Evidence

For a real update, operation claim, row lock, version check, explicit settings
update, database-owned version/timestamp trigger, generic settings change
event, response snapshot, and processed-operation completion commit or roll
back together. A test-only repository method replacement proves rollback after
the trigger effect but before completion without adding a production fault
switch.

Per addendum A, S7 evidence is `sync.processed_operations` plus the existing
`sync.change_events` effect. No central audit row is claimed or created. The
generic event may contain URI keys with null values; final shared event
sanitization remains Station 19 work. Exact replay and canonical no-op create no
duplicate or fake settings business-change event.

## Verification and Handoff

Real PostgreSQL coverage verifies strict validation, owner and Store-state
authorization, forced RLS, cross-tenant blocking, bigint preservation, legacy
credit-policy compatibility, exact replay after later state change, rejected
replay, device binding, in-progress operations, no-op behavior, true concurrent
writers, concurrent idempotency, controlled initialization, and full
transaction rollback. Fixtures require the repository-approved local database
to contain no user, Store, settings, URI, accounting, or inventory data and
assert zero fixture residue after cleanup.

There is no current initializer call site. Wiring it into an approved Store
provisioning lifecycle remains with that future lifecycle owner. Existing
deferred items S7-DT-01, S7-DT-02, and S7-DT-03 remain unchanged; Task 7.4 adds
no new deferred item.
