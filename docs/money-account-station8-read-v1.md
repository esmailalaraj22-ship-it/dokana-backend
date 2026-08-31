# Money Account Station 8 Read Contract v1

This record documents Station 8 / Task 8.3 only. It implements the authenticated
owner-facing Money Account catalog reads over the Task 8.2 physical/domain
foundation. It introduces no mutation, provisioning, balance, movement,
transfer, opening-balance, or posting behavior.

## Routes and Authorization

- `GET /v1/money-accounts`
- `GET /v1/money-accounts/:moneyAccountId`

Both routes require an authenticated active `owner` membership. The authenticated
principal and transaction context must agree on Store, user, and device. A
`read_only` Store may read because authentication already limits eligible Store
sessions to `active | read_only`; no read route bypasses suspended or archived
session eligibility. Manager, viewer, and support memberships receive the stable
`MONEY_ACCOUNT_READ_NOT_ALLOWED` response.

Store identity is never accepted as request authority. Every repository query
uses `DatabaseService.withTenantTransaction`, transaction-local trusted context,
the existing forced RLS policy, and an explicit same-Store predicate.

## List

The list defaults to `status=active` and accepts exactly `active | archived`.
There is no `all`, search, pagination, or `includeArchived` mode. Results include
only physical `cash | transfer` rows whose availability is `available`.
`external_party` and `held_by_external_party` remain physically compatible but
are excluded from this public API.

Ordering is deterministic:

1. Cash first;
2. `normalized_name` ascending;
3. UUID ascending.

## Detail and Non-Disclosure

Detail can return a supported same-Store active or archived account. A foreign
Store UUID, nonexistent UUID, `external_party` UUID, or held account UUID returns
the same `MONEY_ACCOUNT_NOT_FOUND` behavior. UUID path input uses the established
validation pipeline and canonical lowercase representation.

## Public Projection

The list and detail projection contains only:

`id`, `name`, `accountType`, `isDefault`, `status`, `archivedAt`, `createdAt`,
`updatedAt`, and lossless decimal-string `version`.

It excludes Store identity, normalized name, availability, device/operation
provenance, balance, and movements. Timestamps are UTC ISO strings.

## Side Effects and S8/S10 Boundary

GET is read-only. It does not create the system Cash account, repair defaults,
change versions or timestamps, write operation/audit/change events, or create
money movements. Cash provisioning and lifecycle mutations remain S8.4.
Authoritative balances, movements, internal transfers, opening balances, and
owner funding remain S10; S8.3 does not query `ledger.v_money_account_balances`
or `ledger.money_movements` for Money Account behavior.
