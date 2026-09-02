# Accounting Period Station 9 Read Contract v1

This record documents Station 9 / Task 9.3 only. It implements authenticated,
owner-facing Accounting Period reads over the closed S9.2 physical foundation. It
introduces no provisioning, lifecycle mutation, closing, posting eligibility,
idempotency write, or later-domain behavior.

## Routes and Authorization

- `GET /v1/accounting-periods`
- `GET /v1/accounting-periods/:accountingPeriodId`

Both routes require an authenticated `owner` membership. The authenticated principal
and transaction context must agree on Store, user, and device. Owners of `active` and
`read_only` Stores may read. Existing session validation rejects suspended or archived
Stores. Manager, viewer, and support memberships receive the stable
`ACCOUNTING_PERIOD_READ_NOT_ALLOWED` response.

Store identity is never accepted as request authority. Every repository query uses
`DatabaseService.withTenantTransaction`, transaction-local trusted context, forced RLS,
and an explicit same-Store predicate.

## List and Detail

The list has no search, status filter, or pagination. It returns the current Store's
public periods in deterministic reverse chronological order:

1. `period_year` descending;
2. `period_month` descending;
3. UUID descending as an explicit stable tie-breaker.

Detail uses trusted Store UUID plus the canonicalized Accounting Period UUID. Foreign
Store, absent, and internal-only period IDs share `ACCOUNTING_PERIOD_NOT_FOUND`
behavior. Malformed UUIDs use the repository-wide validation response.

The public projection contains only `id`, `periodYear`, `periodMonth`, `startsAt`,
`endsAt`, `status`, `closedAt`, `createdAt`, `updatedAt`, and lossless decimal-string
`version`. Timestamps are UTC ISO strings. Store identity and device/operation
provenance are not exposed.

The public Product lifecycle remains `open | closed`. The physical `closing` value is
retained by the Drizzle/domain mapping as the approved internal fail-closed
compatibility state, but S9.1 forbids exposing it as a public lifecycle. A `closing`
row is therefore outside list/detail visibility and receives the same non-disclosing
detail result as any unavailable period. This read rule creates no transition or
lifecycle behavior.

## Read-Only and Security Boundary

Reads never insert or repair a missing month, change status/version/timestamps, claim
an operation, call a posting resolver, or create change/audit effects. An empty Store
returns `{ "items": [] }` and remains empty. S9.4 owns future on-demand provisioning
and lifecycle behavior; S9.5 owns posting context and close-vs-post serialization.

Real PostgreSQL coverage verifies the least-privileged runtime role, forced RLS,
fail-closed missing context, Store A/Store B isolation, active and `read_only` access,
stable non-disclosure, deterministic ordering, and unchanged period/idempotency/change/
audit state after reads.

## Task Status

```text
S9.2: CLOSED
S9.3: IMPLEMENTATION COMPLETE
S9.4: NOT STARTED
S9.5: NOT STARTED
```

S9.3 requires no separate independent review under the approved S9 hybrid review
model. Backend-owner approval remains required before S9.4 begins.
