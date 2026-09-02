# Accounting Period Station 9 Provisioning and Lifecycle v1

This record documents Station 9 / Task 9.4 only. It adds an internal transaction-aware
monthly provisioner and an explicit owner close route over the unchanged S9.2 physical
foundation. It does not implement S9.5 posting-context resolution, posting-side locking,
financial or inventory posting, reopening, deletion, or public period creation.

## Internal Monthly Ensure

`AccountingPeriodProvisioningService.ensureMonthlyAccountingPeriod` accepts the caller's
existing `DatabaseTransaction`, trusted `TenantTransactionContext`, canonical month, and
the enclosing business operation ID. It never starts or commits an autonomous outer
transaction. If the enclosing write rolls back, period creation and trigger-owned audit
and change effects roll back with it.

The primitive reuses the approved UUIDv5 identity and `Asia/Hebron` `[start, end)` month
boundaries. An absent month is inserted as `open`, with `closedAt = null` and the physical
initial version of `1`. A new row requires an `active` Store under the same transaction
and forced RLS. An existing `open`, `closed`, or internal `closing` row is returned without
mutation. Existing identity and boundaries are checked against the canonical contract;
inconsistency fails with `ACCOUNTING_PERIOD_INTEGRITY_CONFLICT` and is never repaired.

Concurrent first use relies on the deterministic UUID, Store/month uniqueness, and a
PostgreSQL savepoint around insert. A uniqueness or overlap race re-reads the committed
winner in the caller transaction. There is no process-local lock.

## Owner Close

The public mutation is:

```text
POST /v1/accounting-periods/:accountingPeriodId/close
```

The body contains exactly `operationId` and lossless decimal-string `expectedVersion`.
A genuinely new close requires an authenticated owner and an `active` Store. Foreign and
unknown IDs share `ACCOUNTING_PERIOD_NOT_FOUND`. The period is selected by trusted Store
and ID with `FOR UPDATE`, then its deterministic identity and boundaries are revalidated.

An `open` period with the current version transitions to `closed`. PostgreSQL owns the
UTC close timestamp and trigger-owned version/update/audit/change effects. A new command
against an already `closed` period validates the current version and succeeds as a semantic
no-op: no period rewrite, timestamp change, version increment, audit row, or change event.
A stale version remains stale. The internal `closing` state fails closed with
`ACCOUNTING_PERIOD_CLOSING`; reopening is not exposed.

## Idempotency and Replay

The implementation consumes the existing `sync.processed_operations`,
`sync.claim_operation`, and `sync.conflicts` infrastructure unchanged.

```text
claim key:       (store_id, operation_id)
aggregate type:  accounting_periods
aggregate ID:    canonical Accounting Period UUID
claim action:    close
device binding:  immutable and server-derived
```

The exact canonical close intent is:

```json
{
  "v": 1,
  "action": "accounting_period.close",
  "accountingPeriodId": "<canonical UUID>",
  "expectedVersion": "<positive decimal bigint>"
}
```

`operationId`, request ID/time, current state, generated `closedAt`, resulting version,
and response snapshot are excluded. An exact applied replay returns the stored original
response before the new-write Store gate or current-version validation. A different
device, aggregate, action, or fingerprint returns `OPERATION_ID_CONFLICT` and records the
existing minimized conflict evidence. A processing claim returns `OPERATION_IN_PROGRESS`.

| Outcome                                                 | Claim phase    | Stored rejection | Exact retry             |
| ------------------------------------------------------- | -------------- | ---------------- | ----------------------- |
| Authentication, actor, UUID/body, or version validation | Before claim   | No               | Revalidate              |
| New write against non-active Store                      | Before claim   | No               | Re-evaluate Store state |
| Hidden/not-found period                                 | After claim    | Yes              | Stored rejection        |
| Version conflict                                        | After claim    | Yes              | Stored rejection        |
| Canonical integrity conflict                            | After claim    | Yes              | Stored rejection        |
| Internal `closing` state                                | After claim    | Yes              | Stored rejection        |
| Pending-cost or draft blocker                           | After claim    | Yes              | Stored rejection        |
| Changed request/device binding                          | Existing claim | No new rejection | Operation conflict      |
| Existing processing claim                               | Existing claim | No               | In-progress outcome     |

## Close Blockers and Concurrency Handoff

The currently evaluable approved blockers are checked inside the close transaction:

| Blocker                | Product/physical authority   | Physical source                                                | Close effect |
| ---------------------- | ---------------------------- | -------------------------------------------------------------- | ------------ |
| Pending sale cost      | PRD and SQLite close guard   | Posted/corrected `sales.pending_cost_line_count > 0`           | Reject       |
| Pending inventory cost | PRD and SQLite close guard   | `inventory_movements.has_pending_cost_after = true`            | Reject       |
| Existing legacy drafts | PostgreSQL fail-closed guard | Draft sales, receipts, customer/supplier payments, or expenses | Reject       |

The PostgreSQL guard remains unchanged and SQLSTATE `23514` from its final transition
check is translated to the same stable blocker outcome through a savepoint. There is no
current production-capable Sales or Inventory posting writer, so blocker-creation
concurrency is not currently applicable. S9.5 and the future S11/S14 writers must acquire
the approved posting-side shared period lock in the authoritative posting transaction so
they serialize against S9.4's close-side exclusive row lock.

## Physical and Security Impact

S9.4 adds no migration, SQLite change, RLS policy, grant, role, function, trigger, or
reference-package change. It uses transaction-local trusted context, forced RLS, explicit
same-Store predicates, and the least-privileged runtime path. Trigger-owned audit and
change events occur once for a real create or close and are not duplicated on replay or
same-state close.

## Task Status

```text
S9.3: COMPLETE
S9.4: IMPLEMENTATION COMPLETE
S9.5: NOT STARTED
```

Formal S9.4 closure remains a backend-owner/project-governance decision.
