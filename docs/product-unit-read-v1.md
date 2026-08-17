# Product and Unit Read Contract v1

## Scope and Authority

This document records Station 5 / Task 5.3 server-side Product and ProductUnit reads. It consumes
the closed Product persistence and validation contracts and the explicit backend-owner decisions
P53-D1, P53-D2, and P53-D3. It adds no mutation, lifecycle enforcement, inventory effect,
accounting effect, Sync behavior, or migration.

The MVP operational actor is an authenticated active `owner` membership. Product reads derive the
store from the validated server session. Future membership roles and SaaS administrators receive no
ordinary Product-route access through this contract. An `active` or `read_only` store can retain a
valid session and read; suspended or archived stores remain ineligible under the authentication
contract.

## Routes and Status

- `GET /v1/products` lists Products. It defaults to `status=active` and accepts exactly
  `status=active` or `status=archived`.
- `GET /v1/products/:productId` returns a same-store active or archived Product.
- Product detail embeds all Product-scoped ProductUnits, including active and archived Units, and
  exposes each Unit status.
- There is no global ProductUnit list, search, or direct ProductUnit endpoint.

Same-store absence and a foreign-store Product produce the same non-disclosing not-found response.
Unit queries require both the trusted store and requested Product relationship. Product list never
loads Units; Product detail uses one Product query and one scoped Unit query.

## Search

An omitted `search` means no search filter. A supplied search is valid only when non-empty,
PostgreSQL-text-representable, Product-v1-normalizable, and at most 512 UTF-16 code units. This is an
HTTP abuse/transport bound, not a Product database-field length. Input is never truncated.

One valid search matches:

```text
normalized Product-name literal prefix
OR exact canonical SKU
OR exact canonical opaque barcode
```

Name input uses Product Normalization V1. PostgreSQL `LIKE` pattern characters `%`, `_`, and `\`
are escaped so user input remains literal. SKU uses Task-5.2 outer trimming and remains exact and
case-sensitive. Barcode uses Task-5.2 outer trimming, remains exact opaque text, and preserves
leading zeroes. Description, Unit name, and Unit code are not searched.

Supplied empty, Product-v1 whitespace-only, normalized-empty, malformed, oversized, or duplicate
search input is a validation error and never becomes an unfiltered list.

## Ordering and Pagination

The authoritative Product total order is:

```text
is_pinned DESC
normalized_name ASC
id ASC
```

PostgreSQL is the text-ordering authority. `ORDER BY` and the keyset continuation predicate use the
same `products.normalized_name` column and its database collation; JavaScript lexical comparison is
not used. UUID is the final tie-breaker. ProductUnits use deterministic
`is_base DESC, unit_name ASC, id ASC` ordering inside Product detail.

Pagination is keyset-based. `limit` defaults to 50, accepts strict decimal syntax in `1..100`, and
rejects coercive forms, out-of-range values, and duplicates. The contract guarantees no duplicate
or skipped rows for a stable dataset. It does not promise a multi-page snapshot across concurrent
catalog writes.

## Cursor

Product cursor version 1 is an opaque, strict base64url encoding of this fixed-order JSON tuple:

```text
[cursorVersion, queryScopeSha256Base64url, lastProductId, lastProductVersion]
```

The query scope digest is deterministic over the ordering-contract version, Product status, and
canonical name/SKU/barcode search state. It binds a cursor to its semantic query but is not an
authorization token or a signature. Tenant and actor identity always come from the authenticated
server request.

The last UUID is resolved through a tenant-, status-, search-, and version-scoped anchor query. A
missing, foreign, modified, archived-after-issuance, or otherwise out-of-scope anchor yields the
same deterministic cursor validation error. The anchor is held with `FOR SHARE` until the list
transaction completes so its ordering values cannot change between validation and continuation.

Maximum state uses a 43-character SHA-256 base64url digest, a 36-character canonical UUID, and the
19-digit PostgreSQL bigint maximum:

```text
JSON decoded maximum: 110 UTF-8 bytes
base64url encoded maximum: 147 characters
```

The decoder enforces both bounds, canonical base64url, fatal UTF-8, exact tuple shape, supported
version, canonical lowercase UUID, and canonical positive PostgreSQL bigint version. Product names
and ordering values are neither carried, truncated, nor hashed as an ordering substitute. Cursor
anchor lookup preserves readability of historical unbounded Product names.

## Response and Precision

Product list responses expose business fields, status, version, and relevant timestamps. Detail
adds description, creation time, and scoped Units. ProductUnit responses expose measurement type,
label/code, base flag, exact numerator/denominator, nullable sale/purchase prices, status, version,
and timestamps.

The API does not expose `store_id`, `device_id`, `operation_id`, `normalized_name`, or internal
provenance. PostgreSQL bigint values are decimal strings. `null` remains distinct from zero, and a
ratio such as `2/4` remains `2/4`; floating-point conversion and ratio reduction are prohibited.

## Tenant Security and Privacy

Every repository read executes through `DatabaseService.withTenantTransaction`, installing trusted
transaction-local store, user, device, and request context on the same connection. Explicit store
predicates complement forced RLS. Runtime remains a non-owner, non-superuser, non-`BYPASSRLS` role,
and missing context fails closed.

Product routes do not log raw search, SKU/barcode input, cursor content, decoded cursor state, or
query strings. Existing request/error logging records a query-free path, and Drizzle value logging
remains disabled. Full Station-5 Product query-privacy and documentation closure remains Task 5.6.

## Query and Index Review

The current `idx_products_search(store_id, status, normalized_name, barcode, sku, is_pinned)` and
tenant-scoped unique SKU/barcode indexes support the required predicates but do not perfectly cover
the approved pinned-first order. PostgreSQL may sort the small-shop result set. A future index such
as `(store_id, status, is_pinned DESC, normalized_name, id)` is an optional scale optimization, not
a correctness requirement; Task 5.3 introduces no migration.

Product normalization, exact SKU/barcode identity, statuses, bigint strings, and rational factors
remain representable by a future SQLite/mobile implementation. The REST pagination cursor is
server-specific. This task does not implement mobile reads, Sync, bootstrap, or end-to-end offline
operation.
