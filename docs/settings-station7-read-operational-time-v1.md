# Station 7 Task 7.3: Settings Reads and Operational Time

## Scope

Task 7.3 implements the read-only Store settings capability and the internal
operational-time resolver defined by the frozen
[`store-settings-operational-time-v1`](contracts/store-settings-operational-time-v1.md)
contract. It introduces no PostgreSQL or SQLite change, no migration, no
settings initialization, and no settings mutation workflow.

## Settings Read API

`GET /v1/settings` returns settings for the Store selected by the authenticated
session. The endpoint accepts no client-controlled Store authority.

- An authenticated owner may read settings while the Store is `active` or
  `read_only`.
- Manager, viewer, and support memberships are rejected with
  `SETTINGS_READ_NOT_ALLOWED`.
- Existing authentication and session validation reject suspended and archived
  Stores before settings persistence is accessed.
- Shop-runtime access provides no platform-administrator bypass.

The repository executes one explicitly projected, Store-scoped query through
the trusted tenant transaction wrapper. Transaction-local Store, user, device,
and request context is installed on the same PostgreSQL connection, and forced
RLS remains authoritative. An explicit `store_id` predicate supplements RLS.

## Response Boundary

The response contains only:

- `dailyReportTimeMinutes`
- `defaultCreditPolicy`
- `defaultCreditLimitMinor`
- `allowNegativeStock`
- `lowStockAlertEnabled`
- `debtAgeAlertDays`
- `backupEnabled`
- `backupIntervalHours`
- `timezoneName`
- `version`
- `createdAt`
- `updatedAt`

Money-related `defaultCreditLimitMinor` and record `version` are serialized as
lossless decimal strings; a null credit limit remains null. A persisted legacy
credit policy of `allow` is returned faithfully and is not rewritten or treated
as valid future mutation input.

The public projection excludes the tenant key, device-local directory URIs,
preparatory business-day fields, database internals, operation state, audit
state, and Sync state. A persisted timezone other than the fixed MVP
`Asia/Hebron` contract fails closed with `SETTINGS_TIMEZONE_UNSUPPORTED`; GET
does not repair the row.

## Missing Settings and Read-Only Guarantees

A missing singleton returns HTTP 404 with `SETTINGS_NOT_INITIALIZED`. GET never
inserts, upserts, initializes, or synthesizes settings from physical defaults.
This is equally true for a `read_only` Store.

Integration coverage compares settings and Store rows before and after reads
and verifies that GET does not change values, versions, timestamps, operation
claims, change events, audit rows, or Store state.

## Operational-Time Context

`OperationalTimeService` accepts a caller-supplied UTC `Date` instant and
returns four distinct values:

- `occurredAt`: a preserved copy of the actual instant;
- `storeLocalDatetime`: the local datetime including the resolved UTC offset
  and IANA zone;
- `businessDate`: the `Asia/Hebron` local calendar date;
- `timezoneName`: the fixed literal `Asia/Hebron`.

The resolver uses the runtime ICU/IANA TZDB through `Intl.DateTimeFormat`; it
does not use the host timezone or a fixed UTC offset. The MVP business day is
local 00:00 through the next local 00:00. Tests cover normal conversion, the
instant immediately before/at/after local midnight, and historical spring and
autumn DST transitions.

Operational time is not posting time. Task 7.3 does not select `postingDate`,
evaluate accounting periods, enforce inventory policy, or reinterpret stored
historical facts. Future posting domains must persist the business and posting
facts required by their own approved contracts.

## Handoff

Task 7.4 remains responsible for settings PATCH validation, initialization,
operation claim and replay, optimistic concurrency, canonical no-op behavior,
audit/change-event effects, and mutation tests. None of that workflow is
implemented here.

The existing deferred items S7-DT-01, S7-DT-02, and S7-DT-03 remain open under
their recorded future owners. Task 7.3 found no new deferred issue and does not
change the technical-debt register.
