# Accounting Period Contract v1

## 1. Status and Authority

This document freezes Dokana Station 9 / Task 9.1 for independent review. It is a
backend-owner-approved contract record, not an implementation record. S9 application
code, APIs, Drizzle mapping, migrations, database changes, and tests remain not started.

The contract is subordinate to current backend-owner decisions, root
[`AGENTS.md`](../../AGENTS.md), the
[approved PRD v1.1](../product/Dokana_PRD_v1.1_APPROVED.md), and applied migrations. The
read-only PostgreSQL and SQLite reference package remains unchanged.

## 2. Scope and Ownership

S9 owns this mapping and eligibility decision:

```text
canonical postingDate
-> Store-local calendar month
-> canonical accountingPeriodId
-> current period status
-> posting eligibility
```

S7 remains the authority for `Asia/Hebron`, Store-local datetime resolution, and
`businessDate`. Each future transactional domain remains responsible for selecting and
persisting its own `postingDate`. S9 does not infer a transaction date or silently equate
these distinct facts:

```text
occurredAt
businessDate
postingDate
accountingPeriodId
```

The canonical S9 input is an already validated Store-local accounting date, not a UTC
instant. Each future posting domain owns its transport representation and may constrain
which dates a user may select, but it must use S9 to resolve period identity and
eligibility. S9.1 does not invent a transaction-date field for those domains.

## 3. Operational-Time Boundary

The MVP operational timezone is fixed:

```text
Asia/Hebron
```

A business day is the local calendar interval from `00:00` to the next local `00:00`.
There is no daily opening or closing workflow. An event after local midnight belongs to
the new local calendar day.

All conversions use IANA/TZDB rules for `Asia/Hebron`, including daylight-saving
transitions. Code must not use the host timezone, a fixed UTC offset, or an assumed
24-hour elapsed duration.

## 4. Monthly Period Model

Dokana MVP accounting periods are monthly. Exactly one logical period exists for each:

```text
trusted Store UUID + YYYY-MM
```

The logical boundaries are local `00:00` on the first day of the month through local
`00:00` on the first day of the next month. Physical PostgreSQL boundaries are the two
corresponding UTC `timestamptz` instants. SQLite uses its approved UTC-instant
representation.

Intervals are half-open:

```text
[startsAt, endsAt)
```

Adjacent canonical months are valid. Overlap is forbidden. `periodYear`, `periodMonth`,
`startsAt`, and `endsAt` are canonical identity facts and must not be changed after
creation.

Example logical interval:

```text
2026-09
start: 2026-09-01 00:00 Asia/Hebron
end:   2026-10-01 00:00 Asia/Hebron
```

## 5. Deterministic Period Identity

Normal synchronized entities continue to preserve accepted client-generated UUIDs.
Accounting periods are a narrow system-derived exception because PostgreSQL and offline
SQLite must converge on one identity for the same Store month without a public create
operation.

New accounting-period IDs use RFC 9562 UUIDv5 with this fixed, S9-owned namespace:

```text
2c9aa30a-c026-5003-93f8-8e2e921c76ff
```

The namespace is owned exclusively by Dokana accounting-period identity version 1 and
must not be reused for another entity type. It was derived once as UUIDv5 using the
standard URL namespace `6ba7b811-9dad-11d1-80b4-00c04fd430c8` and these exact UTF-8
name bytes:

```text
https://github.com/esmailalaraj22-ship-it/dokana-backend/contracts/accounting-period/v1
```

The resulting namespace UUID above is authoritative even if repository hosting or paths
later change.

For a period, the UUIDv5 name is the UTF-8 encoding of this exact ASCII projection:

```text
<canonical-lowercase-store-uuid>:<four-digit-year>-<two-digit-month>
```

There are no braces, quotes, spaces, line endings, byte-order marks, or locale-dependent
digits. The Store UUID uses canonical lowercase `8-4-4-4-12` text. The separator between
the Store UUID and year is one ASCII colon. The separator between year and month is one
ASCII hyphen.

Cross-platform test vector:

```text
Store:     10000000-0000-0000-0000-000000000001
Month:     2026-09
Name:      10000000-0000-0000-0000-000000000001:2026-09
Period ID: 7a85230d-bcbe-55ab-94a9-e7e8daedfacd
```

`accountingPeriodId` and `operationId` remain different concepts. Implementations must
not use one as a substitute for the other. A newly provisioned row must have the derived
period ID. Finding an existing Store/month row with a different ID or non-canonical
boundaries is an identity conflict: fail closed, do not rewrite history, and require
explicit compatibility remediation.

## 6. Automatic On-Demand Provisioning

Period provisioning is automatic and system-controlled. There is no public manual
create-period workflow.

Reads never create periods. Closing never creates a missing period. Provisioning occurs
only when an approved future business write needs a `postingDate` and its canonical
monthly period does not yet exist.

Provisioning must:

1. run inside the same tenant transaction as the enclosing approved business write;
2. use trusted server-derived Store, user, device, and request context;
3. run only after current authentication, owner authorization, Store-state enforcement,
   and the enclosing operation claim permit a new write;
4. derive the exact UUIDv5 ID and exact `Asia/Hebron` boundaries;
5. rely on the existing unique Store/year/month and no-overlap guarantees to serialize
   concurrent creators;
6. insert at most one row, then read and validate the canonical winner;
7. fail closed if identity, month, boundaries, or lifecycle state is unexpected; and
8. commit or roll back with the enclosing business operation.

The inserted row records the trusted device and the enclosing stable `operationId`.
Concurrent losing writers use the existing canonical row and do not create a second
period or a second period effect. There is no automatic prior-month closure.

## 7. Public and Internal Lifecycle

The public Product lifecycle is:

```text
OPEN -> CLOSED
```

Closing is an explicit Shop Owner accounting action. Calendar rollover does not close
the prior month. A prior month may remain open after a new month begins. No additional
wall-clock restriction on the close action is introduced by S9.1.

After a successful close, `CLOSED` is terminal. Reopen, hard delete, destructive
boundary edits, and silent rewriting of historical accounting facts are forbidden.
Future correction, reversal, and replacement workflows post into an eligible open
period and retain a reference to the original fact.

The physical `closing` value is an internal fail-closed compatibility state. It is not a
public action or user-facing lifecycle:

- posting into `closing` is rejected;
- controlled internal recovery may advance `closing` to `closed`;
- `closing` must never return to `open`; and
- no public workflow may expose `closing` without a future approved Product decision.

S9 application code must enforce this state machine even where the legacy physical
trigger is less restrictive. No public endpoint or arbitrary SQL interface exposes
`closing`; S9.4 must use explicit state-specific updates and must fail closed if an
unexpected transition path is discovered.

## 8. Posting Eligibility and Replay

Eligibility is fixed:

| Period state | New posting eligibility |
| ------------ | ----------------------- |
| `open`       | Eligible                |
| `closing`    | Rejected                |
| `closed`     | Rejected                |

An unseen operation with a `postingDate` in a closed or closing period is a new posting
and is rejected. Exact replay of an already completed matching operation remains replay,
not a new posting. Replay must still pass current authentication, owner authorization,
trusted-device binding, and tenant privacy checks before the stored result is returned.
Replay performs no new period creation, posting effect, audit effect, or change event.

## 9. Transaction-Scoped Posting Context

S9.5 must expose one reusable application/repository primitive with this conceptual
input:

```text
trusted Store context
+ canonical postingDate
+ current database transaction
```

Its minimum conceptual result is:

```text
postingDate
accountingPeriodId
periodYear
periodMonth
status
eligible
```

The resolver must not return an eligibility decision detached from the transaction and
lock that protect it. S10, S11, S12, S14, S16, and every later posting domain must use
this authority rather than reimplementing period selection.

## 10. Close-vs-Post Concurrency

Posting eligibility is validated inside the same transaction that writes the future
posting effect.

```text
posting: resolve and hold the period row FOR SHARE through commit
closing: lock and update the same period row FOR UPDATE through commit
```

This must serialize into exactly one safe outcome:

```text
posting commits before close
```

or:

```text
close commits before the later posting is rejected
```

The forbidden sequence is a posting committing after a concurrent close without
observing that close. A detached check followed by a later independent posting
transaction is prohibited.

## 11. Close Preconditions

The current S9 close contract requires:

- the canonical Store/month identity and exact canonical boundaries;
- the current `expectedVersion`;
- `open` status for a public close, or the approved internal `closing` recovery path;
- the Store to remain eligible for the write;
- no unresolved pending-cost closure blocker established by an authoritative inventory
  or sales contract; and
- all checks, row locks, status/version change, operation completion, and resulting
  change/audit effects to succeed in one transaction.

The approved PRD currently establishes pending-cost closure safety. S9 must preserve the
existing fail-closed checks for pending-cost sales and inventory state without inventing
new cost semantics. S11 and S14 own the authoritative cost state and must integrate their
final unresolved-cost definitions before their posting workflows can close periods.

Existing PostgreSQL draft-row checks and legacy SQLite checks are fail-closed physical
behavior, not newly approved S9 Product workflows. Future sales, customer payment,
supplier payment, expense, and inventory domains own their integration obligations.
The legacy Goods Receipt check is not authority to create a Goods Receipt workflow: it
remains a compatibility item for S11/S12 forward remediation under the approved rule
that Supplier Invoices and manual inventory are independent.

S9 must not create fake draft, payment, expense, inventory, Supplier Invoice, or Goods
Receipt workflows to satisfy a legacy trigger.

## 12. Authorization, Tenant Isolation, and Store State

Accounting-period reads and close actions are Shop Owner operations in the current MVP.
Tenant identity is server-derived; no caller-supplied Store value grants authority.

| Actor or Store state        | Reads | New provisioning/posting   | Close |
| --------------------------- | ----- | -------------------------- | ----- |
| Active authenticated owner  | Yes   | Yes, through future domain | Yes   |
| `read_only` Store owner     | Yes   | No                         | No    |
| Suspended/archived session  | No    | No                         | No    |
| Non-owner or foreign tenant | No    | No                         | No    |

After current authorization succeeds, a `read_only` Store may receive an exact stored
result for a previously completed matching operation because replay is not a new write.

All period access uses the shared transaction-local Store, user, device, and request
context on the same pooled connection and transaction. Forced RLS remains enabled and
fail closed. Explicit same-Store predicates supplement RLS. Errors must not disclose
whether another tenant's period exists. No ordinary platform role bypasses Store runtime
authority.

## 13. Idempotency and Versioning

S9 reuses Dokana's shared business-write infrastructure; it does not create a separate
idempotency ledger.

Applicable mutation contracts retain:

- stable client `operationId`;
- canonical request fingerprint;
- trusted device binding;
- exact applied and rejected replay;
- changed-payload `operationId` conflict;
- in-progress operation handling;
- positive bigint `expectedVersion` represented losslessly at API boundaries;
- stale-write rejection before state change; and
- canonical same-state no-op behavior after the current version is validated.

For an already closed period, a newly authorized close request with the current version
may complete as a no-op without changing version, `closedAt`, or emitting a false period
change event. Exact replay returns the original stored response. Closed state can never
be used to authorize a reopen or boundary edit.

## 14. Physical Compatibility Decision

Task S9.1 freezes this impact assessment:

```text
PostgreSQL migration:    NOT REQUIRED
SQLite change:           NOT REQUIRED
RLS change:              NOT REQUIRED
function/trigger change: NOT REQUIRED
Drizzle mapping:         REQUIRED in S9.2
```

The existing PostgreSQL and SQLite schemas already provide the period row shape,
Store/year/month uniqueness, half-open-compatible boundaries, no overlap, no hard
delete, status/version fields, tenant ownership, and period-open safeguards. Explicit
UUID values permit the deterministic ID contract.

`ledger.assert_period_open(...)` remains a legacy physical safeguard. It validates an
`occurredAt`-style instant and must not be treated as the final S9 `postingDate`
resolver. S9.5 owns the application posting-context authority. Each later posting
Station must assess its legacy timestamp triggers before introducing an operation where
`postingDate` and `occurredAt` can differ.

No applied migration, baseline, SQLite reference, RLS policy, function, or trigger is
changed by S9.1.

## 15. Station 9 Task and Review Plan

The frozen execution plan is:

```text
S9.1 - Period Contract Freeze
S9.2 - Physical / Drizzle Foundation
S9.3 - Tenant-Safe Period Reads
S9.4 - Monthly Period Provisioning & Lifecycle
S9.5 - Posting Context Resolution & Close-vs-Post Control
```

Review gates:

- S9.1 receives immediate independent review.
- S9.2 receives immediate review when required for foundational mapping and mandatory
  review if any migration, schema, RLS, function, trigger, or reference change appears.
- S9.3 has no separate independent review by default.
- S9.4 has no separate independent review by default unless shared infrastructure
  changes.
- S9.5 receives immediate independent review because it owns shared posting and
  concurrency authority.
- One full independent Station 9 review is mandatory before formal closure.

## 16. Explicit Non-Scope

S9 does not implement or own:

- money posting, balances, transfers, or opening balances;
- owner ledger;
- inventory posting or costing;
- Supplier Invoice, payable, payment, or settlement posting;
- sale, receivable, collection, or Customer payment posting;
- expenses;
- returns, reversals, replacement, or correction workflows;
- generic synchronization; or
- mobile/SQLite application implementation.

Those domains consume the frozen period authority in their owning Stations. S9.1 does
not authorize S9.2 implementation.
