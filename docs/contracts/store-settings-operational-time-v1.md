# Store Settings and Operational-Time Contract v1

## 1. Status, Scope, and Authority

This contract freezes Dokana Backend Station 7 / Task 7.1 only. It is the authoritative MVP
contract for Store operational-setting values, operational-time semantics, settings access, and
future settings mutations. It records the Store-profile boundary needed by Station 7 without
redesigning Store provisioning.

This contract follows, in order:

1. the explicit backend-owner decisions in the Station 7 / Task 7.1 execution approval;
2. root `AGENTS.md`;
3. `docs/product/Dokana_PRD_v1.1_APPROVED.md`;
4. approved and closed architecture, authentication, business-write, Customer, Product, and
   Supplier contracts where they establish shared infrastructure rather than feature-specific
   policy;
5. applied migrations, the live PostgreSQL catalog, the approved PostgreSQL and SQLite reference
   package, the reviewed Drizzle schema, and current code for physical facts.

Physical storage capability does not create Product policy. In particular, a PostgreSQL or SQLite
default is not an approved MVP default unless this contract identifies an approving owner or PRD
rule.

Task 7.1 changes documentation only. It does not implement NestJS, Drizzle, PostgreSQL, SQLite,
tests, migrations, mobile code, generic Sync, reporting, notifications, backup, or future
financial-domain behavior.

## 2. Approved Owner Decisions

The following rules are owner-decided and frozen for the current MVP:

1. **Store phone:** New Store setup or profile completion requires a nonblank valid phone through
   application/domain validation. Phone remains owner-editable and is not unique. Existing or
   legacy `NULL` values remain readable. PostgreSQL and SQLite storage remain nullable.
2. **Operational timezone:** The MVP Product scope is Palestine. Operational time uses the
   canonical IANA/TZDB identifier `Asia/Hebron`. The public settings API does not expose per-Store
   timezone selection or mutation. The server must not infer timezone from device, server,
   deployment, or request location.
3. **Business day:** The MVP business day is the normal `Asia/Hebron` local calendar day from
   `00:00` local through the next `00:00` local. No configurable non-midnight cutoff is exposed.
4. **Time concepts:** `occurredAt`, `storeLocalDatetime`, `businessDate`, `postingDate`, and
   `accountingPeriodEligibility` are distinct concepts with the ownership defined in Section 7.
5. **Store deletion boundary:** Ordinary Store profile and settings APIs expose no Store or
   settings DELETE workflow. This does not freeze a Product-wide prohibition on every future
   privileged Store-deletion concept. Station 18 owns any future request, archive or
   deletion-pending state, recovery period, restoration, retention, or controlled purge policy.
   Task 7.1 does not authorize automatic destruction of accounting history after 30 days or any
   other period.
6. **Database preservation:** Task 7.1 authorizes no PostgreSQL, SQLite, Drizzle, migration,
   baseline, or runtime-privilege change. Task 7.2 must assess physical mapping and any proposed
   hardening independently and prove either that no migration is needed or that a narrow forward
   migration is necessary.

## 3. Store Profile Boundary

Store profile data belongs to `ledger.stores`, not `ledger.app_settings`. This contract does not
merge profile and operational-settings persistence or expose a profile route.

The current profile dependency is:

| Concept                    | Physical storage                                    | Current MVP rule                                                   | Task 7.1 boundary                                             |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Store name                 | `ledger.stores.name`                                | Required Store identity/display data                               | Provisioning/profile contract owns exact validation and route |
| Store phone                | `ledger.stores.phone`, nullable `text`              | Required for new setup; editable; non-unique; legacy null readable | Provisioning/profile contract owns normalization and mutation |
| Currency                   | `ledger.stores.currency_code`                       | Fixed to `ILS` in MVP                                              | Not mutable through settings                                  |
| Store status               | `ledger.stores.status`                              | Authentication and business-write authority                        | Platform/SaaS lifecycle owns mutation                         |
| Profile version/timestamps | `ledger.stores.version`, `created_at`, `updated_at` | Server/database-managed concurrency metadata                       | A future profile mutation must use its own version boundary   |

Application-required phone does not imply PostgreSQL or SQLite `NOT NULL`, uniqueness, Customer
phone reservation, Supplier phone reservation, archive behavior, or automatic legacy repair. A
legacy null phone must not crash Store reads or be fabricated. Any future Store-profile mutation
must preserve the independent `ledger.stores.version`; it must not use the settings version.

## 4. Operational Settings Resource

The authoritative central aggregate is the one `ledger.app_settings` row identified by the
trusted Store ID. Its physical primary key is `store_id`, so no second settings identity is
created.

The public MVP resource contains only approved shared operational settings and server-managed
metadata. It does not expose client-selected `storeId`, directory URIs, custom business-day
boundaries, database defaults, ownership, RLS details, or internal operation state.

### 4.1 Field Contract

| API name                  | Physical column              | API type                 | Nullability | Accepted value                                                      | Initial/default behavior                                                       | Mutable in MVP | Classification                      | Future effect owner                                |
| ------------------------- | ---------------------------- | ------------------------ | ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- | ----------------------------------- | -------------------------------------------------- |
| `dailyReportTimeMinutes`  | `daily_report_time_minutes`  | JSON integer             | Non-null    | `0..1439` minutes after local midnight                              | Configurable/onboarding-owned; physical `1200` is not frozen Product policy    | Yes            | OFFLINE-SHARED                      | S20 report generation; S21 notification scheduling |
| `defaultCreditPolicy`     | `default_credit_policy`      | String enum              | Non-null    | New API input is `warn` or `block`                                  | Configurable/onboarding-owned; physical `warn` is not frozen merely by default | Yes            | OFFLINE-SHARED                      | S14/S15 credit and receivable workflows            |
| `defaultCreditLimitMinor` | `default_credit_limit_minor` | Decimal string or `null` | Nullable    | Canonical nonnegative PostgreSQL `bigint` decimal string, or `null` | `null` means no Store-wide limit is configured; it creates no synthetic credit | Yes            | OFFLINE-SHARED                      | S14/S15 credit and receivable workflows            |
| `allowNegativeStock`      | `allow_negative_stock`       | Boolean                  | Non-null    | `true` or `false`                                                   | Configurable/onboarding-owned; physical `false` alone is not Product approval  | Yes            | OFFLINE-SHARED                      | S11 inventory enforcement                          |
| `lowStockAlertEnabled`    | `low_stock_alert_enabled`    | Boolean                  | Non-null    | `true` or `false`                                                   | Configurable/onboarding-owned; physical `true` alone is not Product approval   | Yes            | OFFLINE-SHARED                      | S21 notification behavior                          |
| `debtAgeAlertDays`        | `debt_age_alert_days`        | JSON integer             | Non-null    | `0..2147483647`                                                     | Configurable/onboarding-owned; physical `90` is not frozen Product policy      | Yes            | OFFLINE-SHARED                      | S21 notification behavior                          |
| `backupEnabled`           | `backup_enabled`             | Boolean                  | Non-null    | `true` or `false`                                                   | Configurable/onboarding-owned; physical `true` alone is not Product approval   | Yes            | OFFLINE-SHARED                      | S22 backup and recovery execution                  |
| `backupIntervalHours`     | `backup_interval_hours`      | JSON integer             | Non-null    | `1..2147483647`                                                     | Configurable/onboarding-owned; physical `24` is not frozen Product policy      | Yes            | OFFLINE-SHARED                      | S22 backup and recovery execution                  |
| `timezoneName`            | `timezone_name`              | String literal           | Non-null    | Exactly `Asia/Hebron` in MVP                                        | Owner-decided fixed MVP value                                                  | No             | OFFLINE-SHARED                      | S7 time resolution; all later time consumers       |
| `version`                 | `version`                    | Decimal string           | Non-null    | Canonical positive PostgreSQL `bigint` decimal string               | Database initial value `1`; server/database managed                            | No             | OFFLINE-SHARED concurrency metadata | S7 mutations and future Sync                       |
| `createdAt`               | `created_at`                 | RFC 3339 UTC string      | Non-null    | Valid UTC instant                                                   | Database/server managed                                                        | No             | OFFLINE-SHARED metadata             | Read/bootstrap consumers                           |
| `updatedAt`               | `updated_at`                 | RFC 3339 UTC string      | Non-null    | Valid UTC instant                                                   | Database/server managed                                                        | No             | OFFLINE-SHARED metadata             | Read/bootstrap/concurrency consumers               |

JavaScript `Number` must never represent `defaultCreditLimitMinor` or `version` authoritatively.
Their public values use lossless canonical decimal strings.

The physical PostgreSQL credit-policy check also permits `allow`. PRD v1.1 approves warning or
blocking when an optional limit is configured; therefore `allow` is not valid new S7 API input.
Task 7.2 must assess any existing unsupported physical value without silently translating,
overwriting, or treating storage capability as Product approval.

### 4.2 Non-API Physical Fields

| Physical field               | Classification                 | MVP contract                                                                             |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `store_id`                   | SERVER-DERIVED TENANT IDENTITY | Never accepted as authoritative request input                                            |
| `business_day_start_minutes` | PREPARATORY STORAGE            | Not exposed or interpreted as an MVP cutoff                                              |
| `business_day_end_minutes`   | PREPARATORY STORAGE            | Not exposed or interpreted as an MVP cutoff                                              |
| `business_day_mode`          | PREPARATORY STORAGE            | Not mutable; `fixed_24h` is interpreted by the MVP rule in Section 7                     |
| `export_directory_uri`       | DEVICE-LOCAL                   | Excluded from central settings reads, mutations, audit values, and change-event payloads |
| `attachments_directory_uri`  | DEVICE-LOCAL                   | Excluded from central settings reads, mutations, audit values, and change-event payloads |

Folder selection in PRD FR-SET-02 belongs to the mobile/device environment. No central path value
may be treated as a portable server path or synchronized to another device.

## 5. Default and Initialization Discipline

Task 7.1 freezes field shape and semantics without inventing unapproved configurable defaults.
Exact initial values for report time, credit warning/block choice, negative-stock policy, alerts,
and backup preferences remain configuration or onboarding inputs. This does not block the
structural contract.

Consequently:

- the public API has no implicit request defaults;
- omitted PATCH fields remain unchanged;
- GET returns persisted state, not reconstructed physical defaults;
- a missing settings row must not be silently synthesized by GET;
- application code must not claim that PostgreSQL or SQLite defaults are backend-owner policy;
- Task 7.2 owns assessment of controlled singleton initialization and compatibility with any
  existing Store that lacks a settings row;
- no public POST or upsert-on-read behavior is authorized.

## 6. Authorization, Store State, and Tenant Isolation

Only an authenticated Shop Owner with an active owner membership may use the MVP settings
resource. Manager, viewer, support, employee, staff, and platform/SaaS administrator identity do
not grant access through the ordinary Shop runtime.

Authorization and Store-state behavior are:

| Actor or Store state                             | GET `/v1/settings`                        | New PATCH | Exact completed replay                           |
| ------------------------------------------------ | ----------------------------------------- | --------- | ------------------------------------------------ |
| Active Store Owner                               | Allowed                                   | Allowed   | Allowed                                          |
| `read_only` Store Owner                          | Allowed                                   | Rejected  | May return the stored result without new effects |
| Non-owner membership                             | Rejected                                  | Rejected  | Rejected before settings access                  |
| Suspended Store                                  | Existing authentication/session rejection | Rejected  | Existing authentication/session rejection        |
| Archived Store                                   | Existing authentication/session rejection | Rejected  | Existing authentication/session rejection        |
| SaaS/platform administrator through Shop runtime | No bypass                                 | No bypass | No bypass                                        |

The server derives Store, user, device, membership, and request context from authenticated and
trusted infrastructure. Request bodies and query parameters must not select `storeId`, role,
Store status, user, device, or request authority.

Every settings persistence and operation-state query must use the approved same-connection,
same-transaction tenant wrapper. The transaction installs transaction-local `app.store_id`,
`app.user_id`, `app.device_id`, and `app.request_id`. PostgreSQL RLS remains enabled, forced, and
fail-closed. Explicit same-store predicates supplement rather than replace RLS. Missing context
must expose no settings row and permit no write. Cross-tenant existence must not be disclosed.

## 7. Operational-Time Model

### 7.1 Distinct Concepts

| Concept                       | Definition                                                                                                                | Owner                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `occurredAt`                  | Immutable actual event instant stored centrally as UTC `timestamptz`; SQLite uses its approved UTC instant representation | The domain creating the event; UTC representation is a shared invariant |
| `storeLocalDatetime`          | Presentation of an `occurredAt` instant in IANA zone `Asia/Hebron`                                                        | S7 supplies deterministic resolution context                            |
| `businessDate`                | Calendar date containing the instant after conversion to `Asia/Hebron` under the MVP midnight rule                        | S7 defines derivation; future operation records consume it              |
| `postingDate`                 | Accounting date selected or resolved for a posted financial or inventory effect                                           | The future domain creating the posting                                  |
| `accountingPeriodEligibility` | Whether a `postingDate` belongs to an allowed/open accounting period                                                      | S9 only                                                                 |

These concepts must not be silently equated. In particular, UTC date, Store-local calendar date,
posting date, and accounting-period status may differ.

### 7.2 MVP Derivation

Given an unambiguous UTC instant:

1. resolve it using IANA/TZDB rules for `Asia/Hebron` at that instant;
2. obtain the resulting local calendar year, month, and day;
3. use that local calendar date as `businessDate`.

The calculation must use timezone rules for the instant, including daylight-saving transitions.
It must not use a fixed UTC offset. A local calendar day may contain 23, 24, or 25 elapsed hours.
The physical label `fixed_24h` must not be implemented as adding exactly 24 UTC hours across a DST
transition; for MVP it means the approved normal local-calendar-day behavior.

No public setting exposes `businessDayStartMinutes`, `businessDayEndMinutes`, or
`businessDayMode`. Existing physical 720/720 values are not an approved noon cutoff and must not
affect MVP `businessDate`.

### 7.3 Historical Safety

Future changes to geographic scope, timezone configurability, or custom business-day boundaries
must be prospective. They must not silently recompute or reinterpret already-posted financial,
inventory, settlement, correction, or period facts.

Future posting domains must persist sufficient approved posting/business-date context when their
contracts are introduced. S7 does not design those schemas. S9 owns period lifecycle and
eligibility; S7 must not open, close, lock, reopen, or select accounting periods.

## 8. HTTP Resource Contract

Repository URI versioning produces these conceptual routes:

- `GET /v1/settings`
- `PATCH /v1/settings`

There is no public settings POST, PUT, DELETE, Store DELETE, profile PATCH, or tenant-selected
route in Task 7.1. Store-phone setup remains the provisioning/profile dependency in Section 3.

### 8.1 GET

GET returns the approved fields in Section 4.1. It returns no `storeId`, physical cutoff field,
directory URI, database ownership, privilege, policy, audit, operation-claim, or internal Sync
field.

If controlled provisioning has not produced the singleton row, the server must return a stable
non-success result such as `SETTINGS_NOT_INITIALIZED`; it must not fabricate persisted state or
write during a read. Task 7.2 must confirm the exact lifecycle and whether this condition can occur
in supported deployments before implementation freezes the HTTP status mapping.

### 8.2 PATCH

PATCH is partial and must contain:

- canonical UUID `operationId`;
- canonical positive bigint decimal string `expectedVersion`;
- at least one mutable field from Section 4.1.

Unknown fields and server-controlled fields are rejected. In particular, PATCH must reject
`storeId`, `timezoneName`, `businessDayStartMinutes`, `businessDayEndMinutes`, `businessDayMode`,
directory URIs, `version`, timestamps, role, Store status, user/device/request identity, and
operation-state fields.

Omission leaves a mutable value unchanged. `defaultCreditLimitMinor: null` explicitly clears the
configured Store-wide limit. No other mutable settings field accepts null. A successful new
mutation returns HTTP `200` with the current approved settings representation, canonical
`operationId`, lossless `version`, and timestamps. Exact replay returns the stored status and body.

## 9. Mutation, Replay, Version, and No-Op Contract

### 9.1 Operation Identity and Canonical Request

The operation claim key is exactly:

```text
(trusted store_id, operation_id)
```

The claim binds the trusted device, aggregate type `app_settings`, aggregate ID equal to the
trusted Store ID, action `update`, and canonical request hash. `operationId` is claim identity and
is not included in the hashed business payload. `requestId` is transport/observability identity
and is never part of the logical operation fingerprint.

The versioned canonical request contains:

```text
contract version
action = settings.update
expectedVersion as canonical decimal text
each supplied mutable field after canonical validation
```

Only supplied patch fields participate. Omission and explicit nullable-limit clearing remain
distinct. Object-key order, JSON whitespace, UUID letter case, and transport retry details must
not change the fingerprint.

### 9.2 Ordering and Transaction

After authentication and owner authorization, the future repository must use one tenant
transaction for operation lookup/claim, Store-state enforcement, row locking, version checking,
the optional row update, processed-operation completion, audit, and change-event effects.

The required order is:

1. read an existing claim for `(trusted store_id, operation_id)`;
2. resolve exact applied/rejected replay, changed-identity conflict, or in-progress state;
3. only for an unseen operation, require an active Store before claiming or mutating;
4. claim the operation;
5. lock the settings row and validate `expectedVersion`;
6. classify canonical no-op or perform exactly one update;
7. write applicable audit/change effects and complete the operation atomically.

This ordering allows an exact completed replay to remain retrievable after a Store becomes
`read_only`, while rejecting every unseen mutation before it creates a claim or business effect.

### 9.3 Version and Canonical No-Op

Settings use whole-resource optimistic concurrency. Concurrent patches to different fields still
compete on the same settings version; no field-level last-write-wins merge is authorized.

A new request with a stale `expectedVersion` is rejected even when its requested values happen to
equal current persisted values. Only after the current version is validated may the resulting
canonical mutable state be compared.

When every resulting mutable value already equals persisted state, the new operation succeeds as
a canonical no-op. It must:

- complete `sync.processed_operations` as applied with a replayable response;
- preserve settings `version`, `updatedAt`, and every persisted value;
- issue no `UPDATE` against `ledger.app_settings`;
- emit no fake settings change event;
- create no fake business-mutation audit effect.

### 9.4 Replay and Conflict

- Same trusted Store, same `operationId`, same bound device/aggregate/action, and same canonical
  request hash returns the stored applied or rejected result exactly.
- Reusing the operation ID with a changed device, aggregate, action, target, or request hash is an
  operation-ID conflict and creates no settings effect.
- A still-processing matching operation returns the established operation-in-progress response.
- Operation conflict/audit handling must not disclose another tenant or secret request content.
- Rollback must remove or roll back the claim together with every uncommitted settings, audit, and
  change effect.

## 10. Audit and Change-Event Contract

A real settings update is a sensitive configuration change and must produce meaningful central
audit and change-feed effects inside the successful transaction. Task 7.1 freezes the required
semantics, not the physical trigger/function implementation.

The audit effect must identify trusted Store, user, device, request, operation, action, and changed
approved setting values as supported by the shared infrastructure. It must not log credentials,
tokens, connection data, client-selected authority, or device-local directory URI values.

The settings change event uses generic update semantics unless Task 7.2 proves specialization is
required for safety. Its payload must be sufficient for future offline-shared settings
convergence and must exclude `export_directory_uri`, `attachments_directory_uri`, and unapproved
custom-cutoff behavior. A canonical no-op or rejected mutation emits no settings business-change
event.

Generic Sync push/pull, cursors, conflict resolution, dead letters, and bootstrap protocol remain
Station 19 work. Task 7.1 does not assume that a generic change-event action always captures every
business-level semantic stored by `processed_operations`.

## 11. PostgreSQL, Drizzle, and SQLite Compatibility

### 11.1 PostgreSQL Physical Truth

`ledger.app_settings` already exists in the approved baseline and live applied database. It
contains all S7 fields, including `timezone_name`, `business_day_start_minutes`,
`business_day_end_minutes`, and `business_day_mode`. The timezone/business-day fields predate the
versioned migration ledger; migrations `0001` through `0005` preserve them.

PostgreSQL RLS is enabled and forced. The current table has touch/version and generic change-event
triggers. Physical ownership, grants, audit coverage, event sanitization, hard-delete protection,
and singleton initialization are facts for Task 7.2 assessment; Task 7.1 neither approves their
current state permanently nor predetermines remediation.

### 11.2 Drizzle Gap

The current Drizzle schema maps `ledger.stores` but does not map `ledger.app_settings`. This is a
mapping gap, not a missing PostgreSQL table or field. Task 7.2 may map the exact live PostgreSQL
shape while keeping public validation stricter than physical storage and keeping unapproved fields
out of API DTOs.

Drizzle cannot replace or weaken database-authoritative RLS, ownership, grants, policies,
triggers, function security, or audit behavior.

### 11.3 SQLite Semantic Compatibility

The SQLite v1.1 schema contains the shared settings fields and nullable Store phone. The approved
SQLite v1.2 settings patch adds `timezone_name` and the three physical business-day fields.
PostgreSQL and SQLite therefore can represent the frozen shared contract without a Task 7.1
schema change.

SQLite and PostgreSQL need semantic compatibility, not identical implementation internals:

| Concept              | PostgreSQL                          | SQLite                              | Contract                                                |
| -------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| IDs                  | Native UUID                         | Canonical UUID text                 | Preserve Store identity                                 |
| Credit limit/version | `bigint`                            | `INTEGER`                           | Use lossless decimal API representation                 |
| Booleans             | `boolean`                           | Checked integer                     | Preserve logical true/false                             |
| Timestamps           | UTC `timestamptz`                   | Approved UTC integer representation | Preserve the same instant                               |
| Tenant isolation     | Forced RLS and trusted context      | One local Store boundary            | No mobile RLS parity required                           |
| Timezone             | `timezone_name`                     | v1.2 `timezone_name`                | MVP value is `Asia/Hebron`                              |
| Business day         | Preparatory physical fields         | Same extension fields               | MVP behavior is local calendar date, not 720/720 cutoff |
| Audit/change         | Central infrastructure              | Local audit/outbox mechanisms       | Semantic effects must converge later through S19        |
| Directory URIs       | Inherited nullable physical columns | Local fields                        | Device-local values never become shared central policy  |

The SQLite/PostgreSQL mapping CSV does not list the four v1.2 time fields. This is a documentation
gap in the immutable reference package, not evidence that either physical schema lacks the fields.
Task 7.1 does not modify that package.

### 11.4 Task 7.1 Database Decision

```text
POSTGRESQL SCHEMA CHANGE: NONE
SQLITE SCHEMA CHANGE: NONE
HISTORICAL BASELINE CHANGE: NONE
DRIZZLE CHANGE: NONE IN TASK 7.1
MIGRATION CREATED OR AUTHORIZED: NONE
```

## 12. Future-Domain Boundaries

S7 owns settings values and trusted operational-time context. It does not own the future effects:

| S7 value or context                         | Deferred effect owner                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Store-local time and `businessDate` context | S9 consumes context; S9 alone owns period lifecycle and eligibility                    |
| `allowNegativeStock`                        | S11 inventory operations, stock authority, concurrency, and costing                    |
| Default credit policy and limit             | S14 sales/receivables and S15 collections/settlement                                   |
| Store archive/deletion boundary             | S18 subscriptions, licensing, SaaS administration, retention, and privileged lifecycle |
| Settings change representation              | S19 generic Sync, cursors, conflicts, and consistent bootstrap                         |
| Daily report time                           | S20 report generation and S21 notification delivery                                    |
| Low-stock and debt-age alert values         | S21 notification causes, deduplication, and state                                      |
| Backup preference and interval              | S22 backup execution, encryption, restore, and recovery                                |

S7 does not create Money Accounts, periods, inventory movements, stock balances, credit entries,
receivables, reports, notifications, backups, or deletion workflows as side effects of a settings
mutation.

## 13. Task 7.2 Handoff

Task 7.2 may assess only the Forward Migration Need Assessment, Drizzle Mapping, and Physical
Foundation required to support this frozen contract. It must independently prove one of:

```text
NO MIGRATION
```

or:

```text
A NARROW REVIEWED FORWARD MIGRATION IS REQUIRED
```

The assessment must inspect at least:

- exact live PostgreSQL columns, checks, defaults, PK/FK, ownership, and row lifecycle;
- exact Drizzle mapping parity;
- forced RLS and missing-context behavior;
- minimum runtime table and column privileges needed by the frozen public API;
- the absence of public create/delete behavior versus physical INSERT/DELETE capability;
- central audit coverage and Store identity/provenance;
- change-event payload sanitization and device-local URI exclusion;
- safe singleton initialization for existing and future Stores;
- unsupported physical credit-policy values and existing data;
- migration ownership, rollback, prior-version upgrade, and deployment safety if a migration is
  proposed.

Task 7.2 must not rewrite the baseline, edit an applied migration, weaken forced RLS, broaden
runtime administration, expose local directory values, modify SQLite, or design Station 18/19
work. SQLite remains unchanged unless a later explicit backend-owner decision proves a real
semantic incompatibility.

## 14. Task 7.1 Closure Criteria

Task 7.1 is closed when:

1. this single contract records all explicit owner decisions without treating physical defaults
   as Product policy;
2. Store profile phone remains separate from `app_settings` and legacy null remains readable;
3. every S7-owned field has public type, nullability, range, mutability, classification, and
   future effect ownership;
4. `Asia/Hebron`, DST-safe local conversion, midnight business date, and historical safety are
   unambiguous;
5. owner-only access, Store-state behavior, trusted context, forced RLS, and privacy are frozen;
6. GET/PATCH, singleton, no public create/delete, replay, expected version, no-op, audit, and event
   semantics are frozen;
7. PostgreSQL and SQLite semantic compatibility and the Drizzle mapping gap are recorded without
   changing them;
8. Task 7.2 receives an assessment boundary without a predetermined migration result;
9. the repository diff contains only this Task 7.1 documentation artifact and passes repository
   documentation checks;
10. independent review and backend-owner acceptance are still required before Task 7.2 begins.
