# Store Settings Station 7 Physical Foundation v1

This record documents Station 7 / Task 7.2 (physical foundation and Drizzle
mapping). It does not redefine settings behavior; the authoritative contract is
[store-settings-operational-time-v1](contracts/store-settings-operational-time-v1.md).
Task 7.2 adds a Drizzle mapping, a code-level type boundary, and mapping tests.
It implements no GET workflow, no PATCH workflow, no controller, and no
provisioning workflow. Those belong to Tasks 7.3 and 7.4.

## A. Physical `ledger.app_settings` Model

Verified read-only against the live applied database. One row per Store, primary
key `store_id`, foreign key to `ledger.stores(id)` `ON UPDATE CASCADE ON DELETE
CASCADE`. Eighteen physical columns in order:

| #   | Column                       | Type        | Nullable | Default         |
| --- | ---------------------------- | ----------- | -------- | --------------- |
| 1   | `store_id`                   | uuid        | no       | — (PK)          |
| 2   | `daily_report_time_minutes`  | integer     | no       | `1200`          |
| 3   | `default_credit_policy`      | text        | no       | `'warn'`        |
| 4   | `default_credit_limit_minor` | bigint      | yes      | —               |
| 5   | `allow_negative_stock`       | boolean     | no       | `false`         |
| 6   | `low_stock_alert_enabled`    | boolean     | no       | `true`          |
| 7   | `debt_age_alert_days`        | integer     | no       | `90`            |
| 8   | `backup_enabled`             | boolean     | no       | `true`          |
| 9   | `backup_interval_hours`      | integer     | no       | `24`            |
| 10  | `export_directory_uri`       | text        | yes      | —               |
| 11  | `attachments_directory_uri`  | text        | yes      | —               |
| 12  | `created_at`                 | timestamptz | no       | `now()`         |
| 13  | `updated_at`                 | timestamptz | no       | `now()`         |
| 14  | `version`                    | bigint      | no       | `1`             |
| 15  | `timezone_name`              | text        | no       | `'Asia/Hebron'` |
| 16  | `business_day_start_minutes` | integer     | no       | `720`           |
| 17  | `business_day_end_minutes`   | integer     | no       | `720`           |
| 18  | `business_day_mode`          | text        | no       | `'fixed_24h'`   |

Nine `CHECK` constraints (`app_settings_*_check`) enforce the numeric ranges and
the credit-policy / business-day enums. RLS is `ENABLE` + `FORCE` with policy
`tenant_isolation_app_settings` (`store_id = platform.current_store_id()` for
both `USING` and `WITH CHECK`). Triggers present: `trg_app_settings_touch`
(`ledger.touch_mutable_row`) and `trg_app_settings_change_event`
(`sync.capture_change_event`). There is **no** central-audit trigger and **no**
`prevent_delete` trigger on this table. At verification time the table held zero
rows and zero non-NULL directory URI values.

## B. Drizzle Mapping Status

`ledger.app_settings` is now mapped in `src/database/schema/ledger.ts` as
`appSettings`, modeling all eighteen physical columns exactly (names, types,
nullability, defaults, primary key, cascade foreign key, and all nine named
checks). `bigint` columns use `mode: 'bigint'` for lossless representation.
Mapping a column grants no API exposure, no client mutability, and no Product
policy. Parity is proven by
`test/app-settings-schema-contract.integration-spec.ts` (live catalog + SQLite)
and `src/settings/app-settings.schema.spec.ts` (mapping shape, DB-free).

## C. No PostgreSQL Migration

No PostgreSQL DDL/DCL, trigger, function, policy, CHECK, column, or baseline
change was made. Every S7 field already exists physically; the mapping is
application-only.

## D. No SQLite Change

The immutable SQLite reference package is unchanged. The shared v1.1 fields plus
the v1.2 settings patch already represent the frozen offline-shared contract. The
parity test applies the v1.2 patch to a disposable temporary copy only.

## E. Code-First Compensating-Control Model

Required layering for later Tasks:

```
HTTP -> validated DTO -> normalized command -> service -> narrow repository
     -> explicit Drizzle .set({...}) -> existing forced RLS
```

Foundations added now:

- `AppSettingsRow` (physical) is separate from `AppSettingsReadModel` (public
  projection) and `AppSettingsUpdateCommand` / `AppSettingsUpdateInput`
  (allowlisted mutation surface). The public and mutation types do not inherit
  the physical shape.
- `APP_SETTINGS_MUTABLE_FIELDS` is the explicit eight-field write allowlist.
  `APP_SETTINGS_SERVER_ONLY_FIELDS` and `APP_SETTINGS_DEVICE_LOCAL_FIELDS`
  classify the rest. A unit test proves these three sets partition the physical
  columns exactly and are pairwise disjoint, so any future physical column forces
  an explicit classification decision.
- No settings/Store delete method, generic CRUD abstraction, or raw DELETE SQL is
  introduced. No settings controller, service, or repository is introduced yet.

Future write code must build its Drizzle `.set()` from
`APP_SETTINGS_MUTABLE_FIELDS`; it must never spread a request body or perform a
generic update.

## F. Device-Local URI Rule

`export_directory_uri` and `attachments_directory_uri` are device-local (PRD
FR-SET-02). They are excluded from the public read model and the mutation
command. Controlled central initialization must insert them as NULL, and the
settings update path must never write them. Because the central row keeps these
columns NULL, the existing full-row `sync.capture_change_event` payload contains
only null directory values and leaks no device path. Residual assumption: if a
central row ever held a non-NULL URI it would appear in that row's raw
change-event payload; at verification time no such row exists (zero rows, zero
non-NULL URIs). This Task modifies no trigger and wipes no data.

## G. Singleton Lifecycle Handoff (J1)

`app_settings` is at most one row per Store (`store_id` PK). GET must never
create; a `read_only` Store must never create; PATCH must not silently upsert.
The future initialization primitive is `EnsureSettingsForStore` (typed contract
only): `INSERT INTO ledger.app_settings (store_id) VALUES (:storeId) ON CONFLICT
(store_id) DO NOTHING` inside a trusted tenant transaction — idempotent, never
triggered by reads. Implementation and its provisioning wiring are deferred to a
later Task; no migration and no backfill are used.

## H. Legacy Credit Policy `allow` (J2)

Persisted read type is `PersistedCreditPolicy` (`allow | warn | block`); new
write type is `WritableCreditPolicy` (`warn | block`). A persisted `allow` is
never rewritten or silently translated; omission preserves it; an explicit
`warn`/`block` PATCH may repair it. No database change. S14/S15 financial effects
remain out of Station 7.

## I. Residual Security Risk

Application-level controls (DTO allowlist, narrow repository, explicit `.set()`,
architecture/mapping tests, forced RLS) address hostile API input, controller and
service mistakes, most repository mistakes, and accidental generic update/delete
use. They do **not** protect against a fully compromised backend process holding
valid database credentials, or compromised PostgreSQL credentials: the runtime
role retains `DELETE` and broad `UPDATE` on `ledger.stores` and
`ledger.app_settings` (RLS-confined to the caller's own Store). Settings changes
are recorded in the immutable `sync.change_events` feed and `processed_operations`
rather than the compromise-proof `audit.central_audit_logs`; these are not
equivalent. This residual is accepted for the MVP threat model (no direct client
SQL access; single Shop Owner). Privilege/trigger hardening and any store-deletion
lifecycle are deferred to S18.

## J. Task Boundaries

- **7.3:** GET `/v1/settings`, read model assembly, `SETTINGS_NOT_INITIALIZED`.
- **7.4:** PATCH `/v1/settings`, operation claim/replay, `expectedVersion`,
  canonical no-op, `ensureSettingsForStore` implementation, audit/change-event
  behavior, mutation tests.
- **S18:** privileged Store lifecycle/deletion, retention, privilege hardening,
  Store-profile phone provisioning.
- **S19:** generic Sync, bootstrap, and final shared change-event sanitization.

Task 7.2 implements none of the above.
