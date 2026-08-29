# Dokana Deferred Technical Notes

## Status and Use

This register records accepted, non-blocking backend technical debt and residual risks. It does
not override backend-owner decisions, root `AGENTS.md`, the approved PRD, applied migrations, or
approved domain contracts. A future Station should reassess only entries relevant to its scope.

An entry becomes blocking when its recorded blocking condition is met or new evidence shows a
current correctness, accounting, data-integrity, tenant-isolation, authorization, idempotency, or
required offline-contract failure.

## Open Notes

### S7-DT-01 - Broad Runtime DML on Store and Settings Tables

- **Discovered:** 2026-08-29, Station 7 / Task 7.2 independent review
- **Area:** PostgreSQL privileges, Store-state security
- **Issue:** `dokana_runtime_login`, through `shop_app_runtime`, has broad same-tenant
  `INSERT`/`UPDATE`/`DELETE` capability on `ledger.stores` and `ledger.app_settings`, including
  Store status and device-local URI columns.
- **Current evidence:** Live privilege checks return full DML on both tables; the application has
  no S7 Store/settings delete path and no S7 Store-status mutation path.
- **Why non-blocking now:** Clients cannot issue SQL, S7 uses backend-mediated APIs, no settings
  write workflow exists yet, and normal application paths use trusted tenant context, forced RLS,
  validated inputs, and parameterized persistence.
- **Compensating control:** Forced fail-closed RLS; trusted server-derived Store context; no generic
  CRUD or request-body passthrough; future settings writes must use an explicit field allowlist.
- **Residual risk:** A raw-SQL defect or compromised runtime credential can mutate or delete rows
  allowed by the selected tenant context. A compromised backend can also choose untrusted context.
- **Recommended future action:** Replace broad table DML with minimum table/column privileges or
  narrowly scoped database functions, while preserving privileged Store lifecycle administration.
- **Recommended owner:** Station 18 - Subscription, Offline Licensing, and SaaS Administration
- **Blocking condition:** A public/runtime Store lifecycle path is introduced without a separate
  authorization boundary; a realistic normal-path SQL defect can modify Store status; or evidence
  shows cross-tenant access under non-compromised runtime operation.
- **Status:** OPEN

### S7-DT-02 - Settings Lack Central Audit Capture

- **Discovered:** 2026-08-29, Station 7 / Task 7.2 independent review
- **Area:** Audit hardening
- **Issue:** `ledger.app_settings` has no `audit.capture_row_change` trigger, and ordinary runtime
  cannot insert into `audit.central_audit_logs`. Future application-level evidence is not
  equivalent to compromise-resistant central audit.
- **Current evidence:** The live table has only touch/version and change-event triggers. Runtime
  has no audit-schema access.
- **Why non-blocking now:** Settings are configuration rather than posted financial or inventory
  facts; no settings mutation endpoint exists; the current MVP accepts application-level evidence
  for this area.
- **Compensating control:** Immutable `sync.change_events`, idempotent `sync.processed_operations`,
  authenticated actor/device/request context, and atomic future mutation workflows.
- **Residual risk:** A settings change may lack the stronger provenance and compromise resistance
  of `audit.central_audit_logs`, and historical central audit cannot be reconstructed perfectly.
- **Recommended future action:** Add narrowly scoped, privacy-safe central settings audit capture
  with correct Store/entity/operation provenance.
- **Recommended owner:** Station 21 - Notifications, Attachments, and Audit Access
- **Blocking condition:** Compliance or administration requires compromise-resistant settings
  history; settings become a privileged security-control surface; or application evidence cannot
  identify and replay the responsible operation reliably.
- **Status:** OPEN

### S7-DT-03 - Generic Settings Change Events Are Not Sanitized

- **Discovered:** 2026-08-29, Station 7 / Task 7.2 independent review
- **Area:** Offline Sync and payload privacy
- **Issue:** `sync.capture_change_event()` serializes the complete `ledger.app_settings` row,
  including device-local URI keys and preparatory business-day fields. Current central URI values
  are NULL, but field exclusion is not physically enforced.
- **Current evidence:** The live function uses `to_jsonb(NEW)` as the payload; the live database
  currently has zero settings rows and zero non-NULL central URI values.
- **Why non-blocking now:** Generic Sync/bootstrap is not implemented, no settings write endpoint
  exists, and no device-local path is currently stored centrally.
- **Compensating control:** Public/read/write types exclude URI and cutoff fields; future S7
  repositories must never write URI fields; central initialization must keep them NULL.
- **Residual risk:** A future non-NULL value or raw-SQL defect would persist a device path in the
  immutable feed, and raw events include fields that should not become shared policy.
- **Recommended future action:** Define and implement sanitized settings change payloads and
  bootstrap representation without rewriting the immutable reference package.
- **Recommended owner:** Station 19 - Offline Sync and Consistent Data Bootstrap
- **Blocking condition:** Settings events are exposed through push/pull/bootstrap before
  sanitization; any central URI becomes non-NULL; or a future client interprets preparatory cutoff
  values as Product policy.
- **Status:** OPEN

### S7-DT-04 - Settings Mutation Operation Envelope Is Deferred

- **Discovered:** 2026-08-29, Station 7 / Task 7.2 independent review
- **Area:** Type boundaries, idempotency handoff
- **Issue:** `AppSettingsUpdateCommand` currently models mutable patch fields only. It does not yet
  model required `operationId`, `expectedVersion`, canonical `requestHash`, or the trusted
  transaction/repository operation envelope.
- **Current evidence:** The type contains eight optional settings fields and
  `AppSettingsUpdateInput` is an alias of that type.
- **Why non-blocking now:** Task 7.2 implements no mutation workflow and Task 7.3 is read-only.
- **Compensating control:** The frozen S7 contract already requires operation identity, optimistic
  concurrency, exact replay, canonical no-op behavior, and atomic processed-operation effects.
- **Residual risk:** Reusing the current field-only type as a complete repository command in Task
  7.4 would omit mandatory idempotency and concurrency identity.
- **Recommended future action:** Keep a clearly named patch-field type and add a complete prepared
  mutation/repository input following the established Customer/Product/Supplier patterns.
- **Recommended owner:** Station 7 / Task 7.4
- **Blocking condition:** Task 7.4 mutation implementation begins without a complete operation
  envelope and runtime validation that rejects empty patches.
- **Resolution:** Task 7.2 revision added `PreparedAppSettingsUpdate` (values plus `operationId`,
  `expectedVersion`, canonical `requestHash`) following the Customer/Product/Supplier pattern, and
  fixed empty-command semantics in `AppSettingsUpdateCommand` (a PATCH must supply at least one
  mutable field; empty is structurally rejected, distinct from a canonical no-op). Runtime
  enforcement remains a standard Task 7.4 obligation.
- **Status:** RESOLVED (Task 7.2 revision)

### S7-DT-05 - Settings Schema Test Checks Constraint Names Only

- **Discovered:** 2026-08-29, Station 7 / Task 7.2 independent review
- **Area:** Database-contract testing
- **Issue:** The Task 7.2 integration test compares PostgreSQL and Drizzle CHECK constraint names,
  but does not mechanically compare their normalized SQL expressions.
- **Current evidence:** Direct review found all nine mapped expressions equivalent to the live
  catalog, and the live column/default/nullability/FK comparison passes.
- **Why non-blocking now:** Current mapping semantics were independently inspected and are correct.
- **Compensating control:** Named checks, direct code review, live catalog testing, TypeScript
  checks, and immutable reference verification.
- **Residual risk:** A future edit could retain a constraint name while changing its mapped
  expression without this test detecting the difference.
- **Recommended future action:** Compare normalized generated CHECK SQL with live catalog
  definitions when the schema-contract test is next changed or during final validation.
- **Recommended owner:** Station 23 - Final Validation and Release Readiness
- **Blocking condition:** A settings CHECK is changed or generated migration SQL depends on the
  Drizzle CHECK definitions before expression parity is added.
- **Resolution:** Task 7.2 revision added a CHECK-semantics test that compares (a) the live catalog
  `pg_get_constraintdef` output and (b) the mapped Drizzle CHECK expressions, each against
  independent hand-authored expectations (integer bounds, credit-policy domain including physical
  `allow`, version floor, business-day mode and ranges), so a name-preserving expression change is
  now detected.
- **Status:** RESOLVED (Task 7.2 revision)

### S7-DT-06 - Settings Physical Row Type Is Manually Duplicated

- **Discovered:** 2026-08-29, Station 7 / Task 7.2 independent review
- **Area:** Type maintainability
- **Issue:** `AppSettingsRow` manually duplicates the current Drizzle select shape rather than
  deriving it or proving bidirectional compile-time equivalence.
- **Current evidence:** Direct review confirms the current interface matches all 18 mapped fields.
- **Why non-blocking now:** The mapping and interface are currently exact, and field-partition
  tests force classification of added physical columns.
- **Compensating control:** Strict TypeScript, mapping tests, integration catalog comparison, and
  the exact field-classification partition.
- **Residual risk:** A future type or mapping edit could drift without a compile-time equivalence
  assertion.
- **Recommended future action:** Derive the physical row type from Drizzle or add a bidirectional
  type-equivalence assertion while retaining separate public and mutation types.
- **Recommended owner:** Next Station 7 type/schema touch, otherwise Station 23
- **Blocking condition:** The physical settings mapping changes without corresponding type-parity
  proof, or a repository consumes fields whose mapped nullability/type differs.
- **Resolution:** Task 7.2 revision added a bidirectional compile-time assertion between
  `AppSettingsRow` and `typeof appSettings.$inferSelect`, so any name/type/nullability drift fails
  the build. The explicit, readable physical interface is retained.
- **Status:** RESOLVED (Task 7.2 revision)
