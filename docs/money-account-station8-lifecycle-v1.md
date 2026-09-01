# Money Account Station 8 Mutation and Lifecycle Contract v1

This record documents Station 8 / Task 8.4. It extends the approved Station 8
physical and read contracts with public Electronic Account mutations and the
internal system Cash initializer. It does not introduce financial posting,
balance authority, transfers, opening balances, Store provisioning, or SaaS
administration.

## Routes and Authorization

- `POST /v1/money-accounts`
- `POST /v1/money-accounts/:moneyAccountId/archive`
- `POST /v1/money-accounts/:moneyAccountId/restore`

New writes require an authenticated active `owner` membership. The authenticated
principal and transaction context must agree on Store, user, and device. Manager,
viewer, and support memberships receive `MONEY_ACCOUNT_WRITE_NOT_ALLOWED`.
New writes for a `read_only` Store receive `BUSINESS_WRITE_NOT_ALLOWED`.

Matching completed or rejected operations are resolved before the new-write
Store-status gate. This permits exact historical replay for an authenticated
`read_only` Store without permitting a new mutation. Suspended or archived
authentication state remains blocked by the authentication boundary.

Every repository operation uses trusted transaction-local context, forced RLS,
and explicit same-Store predicates. Request bodies cannot select Store, user,
device, type, availability, default state, status, balance, timestamps, or
version authority.

## Electronic Account Create

`POST /v1/money-accounts` accepts exactly:

```json
{
  "id": "client-generated-uuid",
  "operationId": "stable-operation-uuid",
  "name": "Account name"
}
```

The accepted entity UUID is preserved. Name and normalized name use Money Account
normalization V1. The server persists exactly:

```text
account_type = transfer
availability = available
is_default = false
status = active
archived_at = null
version = 1
```

A public create never creates Cash, `external_party`, held accounts, movements,
balances, or posting records. Active and archived rows reserve their normalized
name within the Store. The same normalized name may exist in another Store.

## System Cash Initializer

`SystemCashProvisioningService.ensureForStore` is an internal capability with no
public route. It creates Cash only when no Cash row exists, using server-generated
entity and provenance UUIDs. The persisted state is the frozen Cash state:

```text
name = "الصندوق"
account_type = cash
availability = available
is_default = true
status = active
archived_at = null
device_id = null
```

The first committed Cash UUID is permanent. Repeated calls return the same row
without changing its identity, version, or timestamps. Concurrent callers
converge on the first committed row under the existing one-active-Cash unique
index. A concrete invalid Cash row fails closed; the initializer does not repair,
archive, replace, or delete it.

No current production Store-provisioning caller exists. This is an approved S18
handoff rather than an S8 defect. Future S18 Store/SaaS provisioning must invoke
this capability and must not duplicate Cash identity or lifecycle rules.

## Valid Cash Precondition

A genuinely new Electronic Account create requires exactly one valid frozen Cash
row for the Store. A missing or invalid Cash state returns the tenant-private
`409 MONEY_ACCOUNT_NOT_INITIALIZED`. The rejected operation is completed and
stored. If Cash later becomes valid, retrying the same operation replays the
original rejection; a new attempt requires a new `operationId`.

GET and public create never bootstrap or repair Cash.

## Idempotency

Mutations use `sync.claim_operation` and `sync.processed_operations` with claim key
`(store_id, operation_id)`. Device identity is an immutable binding but is not part
of the claim key. Aggregate identity, action, canonical request hash, and device
must match the original claim.

Create fingerprints this fixed projection:

```text
{ v: 1, action: "money_account.create", moneyAccountId, name, normalizedName }
```

Archive and restore fingerprint:

```text
{ v: 1, action: "money_account.archive|restore", moneyAccountId,
  expectedVersion: "lossless-decimal-string" }
```

`operationId` is excluded from the canonical request body because it identifies
the claim itself. Exact applied and rejected replay returns the stored historical
result. Changed request, action, aggregate, or device binding returns
`OPERATION_ID_CONFLICT`. An unfinished matching claim returns
`OPERATION_IN_PROGRESS` without another effect.

The claim, account mutation, trigger-generated change/audit effects, and operation
completion commit or roll back in one tenant transaction.

## Archive and Restore

Lifecycle requests accept exactly `operationId` and lossless decimal-string
`expectedVersion`. Version is validated against the locked current row before
transition or same-state handling.

Archive applies only to public `transfer / available / non-default` accounts. It
preserves identity, name, normalized name, type, availability, and default state;
sets `status=archived`; sets authoritative UTC `archived_at`; and relies on the
database trigger to increment version exactly once.

Restore updates the same row to `status=active`, clears `archived_at`, and increments
version exactly once. It never creates a replacement row.

A valid same-state archive or restore is a semantic no-op. It completes the new
operation with the current representation but does not update the account, change
version/timestamps, or emit another account change/audit event. Stale versions are
rejected even for same-state requests.

Cash returns `MONEY_ACCOUNT_CASH_IMMUTABLE`. `external_party`, held, foreign Store,
and nonexistent targets use the same `MONEY_ACCOUNT_NOT_FOUND` behavior. Hard
delete, generic PATCH, public Cash creation, and Make Default do not exist.

## Zero-Balance Archive and S10 Boundary

Real archive eligibility reads only `ledger.v_money_account_balances` while the
account row is locked. Exactly zero may archive. Positive and negative balances
return `MONEY_ACCOUNT_NON_ZERO_BALANCE` and leave account state unchanged.

S8 does not expose balances and does not write money movements. S10 owns money
movements, authoritative balance effects, transfers, opening balances, and
owner-money posting. S10 posting must coordinate with the S8 account lifecycle
lock/state so posting cannot race successfully against archive.

## Public Response and Errors

Successful mutations return the Station 8 read projection plus `operationId`:

`id`, `name`, `accountType`, `isDefault`, `status`, `archivedAt`, `createdAt`,
`updatedAt`, lossless decimal-string `version`, and `operationId`.

No response exposes normalized name, availability, Store identity, device
provenance, balance, movements, or database errors. Stable domain errors include:

- `MONEY_ACCOUNT_NOT_INITIALIZED`
- `MONEY_ACCOUNT_NOT_FOUND`
- `MONEY_ACCOUNT_NAME_CONFLICT`
- `MONEY_ACCOUNT_CASH_IMMUTABLE`
- `MONEY_ACCOUNT_VERSION_CONFLICT`
- `MONEY_ACCOUNT_NON_ZERO_BALANCE`
- `OPERATION_ID_CONFLICT`
- `OPERATION_IN_PROGRESS`

## Database and Compatibility Impact

Task 8.4 adds no migration, physical schema change, reference-package change, or
SQLite implementation. It uses the already-approved `ledger.money_accounts`,
`ledger.v_money_account_balances`, forced RLS, immutable-delete trigger,
version/change/audit triggers, and sync operation infrastructure.

S19 consumes the stabilized Money Account IDs, versions, lifecycle, idempotency,
and generic change semantics. S19 must not redefine these business rules.
