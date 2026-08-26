# Supplier Read, Search, and Privacy Contract v1

## 1. Scope

This contract freezes Station 6 / Task 6.3 Supplier list, detail, search, authorization,
pagination, serialization, and read-privacy behavior. A Supplier is shop-owned master data. It is
not a Dokana user, login account, membership, authenticated actor, session, role, or separate
Supplier portal.

This contract defines read behavior only. It MUST NOT create or define Supplier mutations,
operation claims, idempotency, replay, lifecycle writes, accounting, payables, inventory, Goods
Receipts, or synchronization workflows.

## 2. Authority

This contract follows, in order:

1. current backend-owner decisions P63-D1 and P63-D2 and root `AGENTS.md`;
2. `docs/product/Dokana_PRD_v1.1_APPROVED.md`;
3. `docs/contracts/supplier-database-contract.md`;
4. `docs/contracts/supplier-validation-v1.md`;
5. approved Customer and Product read precedents where consistent with the sources above;
6. applied PostgreSQL migrations, the reviewed Drizzle mapping, and approved PostgreSQL and
   SQLite references for physical facts.

P63-D1 authorizes normal Store Runtime Supplier reads only for an active `owner` membership.
P63-D2 exposes Supplier phone in list, search results, and detail, while Supplier notes appear only
in detail. No Supplier read decision remains open for the current MVP.

## 3. Runtime Actor and Platform Boundary

The authorized actor for Supplier list, search, and detail is an authenticated Shop Owner whose
store membership is active and whose role is `owner`. `manager`, `viewer`, `support`, employee,
and staff roles MUST NOT use these routes in the current MVP. This contract MUST NOT introduce an
employee permission matrix or field-level employee permissions.

The Shop Owner is distinct from the Dokana SaaS Owner or platform administrator. Platform identity
MUST NOT grant automatic access to ordinary Store Runtime Supplier routes, arbitrary store
selection, RLS bypass, or cross-tenant Supplier data. A future administrative support workflow
requires a separate approved contract.

The authenticated principal's store, user, and device identities MUST match the trusted request
context used for the read. A client-supplied `storeId` MUST NOT establish or expand authority.

## 4. Tenant Isolation and RLS

Every Supplier repository read MUST execute through the established tenant transaction wrapper on
the same connection and transaction that executes the query. The server MUST install trusted,
transaction-local store, user, device, and request context. Context MUST NOT leak through pooled
connections after commit, rollback, or failure.

PostgreSQL RLS on `ledger.suppliers` MUST remain enabled and forced. Normal runtime MUST remain a
non-owner, non-superuser, non-`BYPASSRLS` role and MUST NOT assume migration, authentication,
administrative, or table-owner privileges. Missing tenant context MUST fail closed.

Repository queries MUST include an explicit same-store predicate in addition to forced RLS. The
predicate does not replace RLS, and RLS does not authorize trusting a client-selected store.

## 5. Cross-Tenant Non-Disclosure

For a well-formed Supplier UUID, a Supplier that exists only in another store MUST be
indistinguishable from an absent Supplier. Both conditions MUST produce the same stable,
non-disclosing Supplier-not-found result. Normal runtime MUST NOT reveal foreign Supplier names,
phones, notes, status, timestamps, versions, search presence, counts, or cursor-anchor existence.

A malformed Supplier UUID is a validation condition. A well-formed absent UUID and a well-formed
foreign UUID are the same observable not-found condition. A response MUST NOT report that a
Supplier exists elsewhere or return a special forbidden result based on foreign existence.

## 6. Public Field Classification

| Stored field       | Purpose                                  | Public read rule                |
| ------------------ | ---------------------------------------- | ------------------------------- |
| `id`               | durable Supplier identity                | list, search result, and detail |
| `store_id`         | tenant ownership                         | internal; MUST NOT be returned  |
| `name`             | display name                             | list, search result, and detail |
| `normalized_name`  | internal name search and ordering        | internal; MUST NOT be returned  |
| `phone`            | nullable business contact                | list, search result, and detail |
| `normalized_phone` | internal canonical search and uniqueness | internal; MUST NOT be returned  |
| `notes`            | nullable free-form operational detail    | detail only                     |
| `status`           | `active` or `archived` lifecycle         | list, search result, and detail |
| `archived_at`      | nullable lifecycle timestamp             | list, search result, and detail |
| `device_id`        | mutation provenance                      | internal; MUST NOT be returned  |
| `operation_id`     | mutation/idempotency provenance          | internal; MUST NOT be returned  |
| `created_at`       | creation timestamp                       | detail only                     |
| `updated_at`       | latest database update timestamp         | list, search result, and detail |
| `version`          | concurrency version                      | list, search result, and detail |

Public responses MUST use explicit projections. Internal normalization, tenant, and provenance
fields MUST NOT appear in response objects, cursors, pagination metadata, or logs.

## 7. List and Search-Result Projection

Supplier list and search results MUST contain exactly these business fields:

```text
id
name
phone
status
archivedAt
updatedAt
version
```

`phone` MUST preserve the stored nullable state. `notes` and `createdAt` MUST NOT be returned in
list or search-result items. No internal field from Section 6 may be returned.

## 8. Detail Projection

Supplier detail identifies the record by Supplier UUID and MUST contain exactly these business
fields:

```text
id
name
phone
notes
status
archivedAt
createdAt
updatedAt
version
```

The detail lookup MUST return an existing same-store `active` or `archived` Supplier to the
authorized Shop Owner. An archived Supplier MUST NOT be hidden from an authorized direct lookup.
No internal field from Section 6 may be returned.

## 9. Legacy Nullable Phone

PostgreSQL and SQLite may contain legacy Supplier rows whose `phone` and/or `normalized_phone` is
`NULL`. Reads MUST preserve factual storage state. When public `phone` is `NULL`, the API MUST
return `phone: null`.

A read MUST NOT fabricate, repair, backfill, substitute, hide, or require mutation of a legacy
null phone. It MUST NOT reject or omit a Supplier solely because its phone is null. Application
requiredness for new creation remains a Task 6.2 and Task 6.4 concern.

## 10. Lifecycle Visibility

An omitted lifecycle filter MUST list or search only `active` Suppliers. An explicit
`status=archived` filter MUST list or search only archived Suppliers. Task 6.3 does not support an
`all` mode.

Archived phone reservation does not make archived Suppliers visible in the default list or
search. Direct same-store detail remains readable for both statuses as defined in Section 8.

## 11. Search Contract

An omitted `search` parameter means an unfiltered list within the active or explicitly archived
lifecycle scope. An explicitly supplied empty or normalization-v1-whitespace-only search MUST be
rejected as validation failure and MUST NOT become an unfiltered query.

A valid search MUST match:

```text
normalized Supplier-name literal prefix
OR exact canonical Supplier phone when the input is a valid complete phone
```

The name scope MUST use Supplier/Customer normalization-v1 from Task 6.2. SQL wildcard characters
such as `%`, `_`, and `\` MUST remain literal input and MUST be escaped for the parameterized
prefix predicate. The implementation MUST NOT add substring-anywhere, fuzzy, trigram,
Levenshtein, full-text, or phonetic name matching.

The phone scope MUST reuse Task 6.2 Supplier phone canonicalization and compare only the complete
canonical value to `normalized_phone`. It MUST NOT support phone prefix, substring, digit-fragment,
or fuzzy enumeration. If general search input is not a valid complete phone but is a valid Supplier
name search, it remains name-only search and MUST NOT be repaired into a partial phone query.

`notes`, Supplier UUID, `store_id`, `device_id`, and `operation_id` MUST NOT be searched. Internal
normalized values MUST NOT be returned. Every search predicate MUST remain tenant- and
lifecycle-scoped.

## 12. Deterministic Ordering

Supplier list and search ordering MUST be:

```text
normalized_name ASC
id ASC
```

PostgreSQL ordering of the stored `normalized_name` is authoritative for server reads. Application
code MUST NOT substitute locale-dependent sorting. Supplier UUID is the deterministic tie-breaker.
The internal ordering value MUST NOT be exposed merely because it participates in ordering.

## 13. Pagination and Cursor

Supplier list and search MUST use keyset pagination. The default limit is `50`; valid limits are
strict integers from `1` through `100`. Zero, negative, fractional, malformed, duplicate, or
out-of-range limit input MUST be rejected according to established query-validation behavior.

The cursor MUST be opaque, versioned, and bound to:

- the ordering-contract version;
- lifecycle status;
- canonical normalized-name search scope, when present;
- canonical phone search scope, when present;
- the anchor Supplier identity and anchor version.

The cursor MUST follow the established fixed scope-digest and ID/version anchor pattern so raw
names, phones, notes, and internal normalized values are not carried in clear cursor state. Exact
codec and helper layout are implementation mechanics. A cursor is not an authorization token and
MUST NOT provide tenant authority.

The anchor MUST be resolved inside the trusted tenant transaction and under the cursor's status,
search, and version scope before continuation. A missing, changed, foreign, or otherwise
out-of-scope anchor MUST produce the same stable cursor-validation condition without existence
disclosure. A cursor for one status or search scope MUST NOT continue a different scope.

The ordering and continuation predicates MUST agree. The contract guarantees deterministic
continuation for a stable dataset; it does not promise a multi-page snapshot across concurrent
Supplier writes.

## 14. Version and Timestamp Serialization

Supplier `version` MUST be returned in list, search-result, and detail projections as a canonical
decimal string. The PostgreSQL `bigint` MUST NOT be converted to JavaScript `Number`.

`createdAt`, `updatedAt`, and non-null `archivedAt` MUST be UTC ISO-8601 strings. `createdAt` is
detail-only; `updatedAt` and `archivedAt` appear in list, search-result, and detail projections.
`archivedAt` remains nullable and MUST reflect stored state without fabrication or backend
store-timezone conversion.

## 15. Phone, Notes, and Query Privacy

The authorized Shop Owner MUST receive the nullable display phone in list, search-result, and
detail projections. `normalizedPhone` MUST remain internal.

Supplier notes MUST appear only in detail. Notes MUST NOT appear in lists, search results,
cursors, pagination metadata, or logs, and MUST NOT be searchable. A returned note MUST preserve
the exact stored Task 6.2 domain value, including `null`, empty, or whitespace-only text.

Normal request and database logging MUST NOT record raw Supplier search values, phone input,
cursor contents, decoded cursor state, notes, or parameterized SQL values. Task 6.3 MUST NOT enable
verbose SQL value logging.

## 16. Authentication and Store Status

Supplier routes MUST reuse the established authentication, membership, device, session, and store
status validation. An `active` or `read_only` store MAY read when its Shop Owner has an otherwise
valid session. A suspended or archived store MUST NOT gain Supplier access when the established
authentication contract rejects or invalidates that store state.

Task 6.3 MUST NOT introduce a Supplier-specific authentication, store-status, license, or platform
administrator bypass.

## 17. Reads Are Not Mutations

Supplier list, search, and detail MUST NOT require or create an `operationId`, processed-operation
claim, request hash, idempotency record, replay response, `expectedVersion`, change event, mutation
audit event, or business-write transaction. Reading `version` does not define Task 6.4 optimistic
concurrency behavior.

Task 6.4 owns create, update, PATCH omission, mutation idempotency, replay, duplicate-phone write
conflicts, and legacy null-phone update policy. Task 6.5 owns archive, restore, lifecycle-write
idempotency, and legacy null-phone restore policy. Those behaviors remain DEFERRED.

## 18. Accounting and Inventory Boundary

Supplier master-data reads MUST NOT calculate or expose Supplier balance, payable balance, total
purchases, unpaid invoices, paid amount, expense totals, Goods Receipt totals, inventory receipt
totals, stock, or costing values. Supplier master data is not the Supplier accounting ledger.

Task 6.3 has no accounting, payable, payment, expense, inventory, receipt, stock, movement,
costing, or COGS effect. A Supplier Invoice remains separate from manual inventory and MUST NOT
automatically create inventory, stock movements, Goods Receipts, warehouses, shelves, locations,
or partial-receipt workflows.

## 19. Database and Offline Boundary

This contract requires no PostgreSQL schema change, index, migration, Drizzle change, SQLite
change, reference-package change, or baseline rewrite. The existing Supplier table, lifecycle
fields, normalized values, uniqueness keys, search index, RLS policy, and Drizzle mapping are
sufficient for correctness.

Future offline/mobile reads MUST reproduce the active/archived visibility, public projections,
name normalization and search, exact phone matching, deterministic ordering, nullable legacy
phone, and internal-field privacy. REST cursor encoding MAY remain server-specific. This contract
does not implement Flutter, Drift, SQLite queries, Sync, bootstrap, or mobile UI.

## 20. Error Conditions

Task 6.3 implementation MUST map these conditions through established shared transport behavior:

- malformed Supplier UUID;
- Supplier not found, including a foreign Supplier UUID;
- unauthorized runtime actor;
- invalid lifecycle filter;
- invalid or non-representable search input;
- invalid complete-phone search input when a phone-specific input mode exists;
- invalid limit;
- malformed, unsupported, scope-mismatched, or invalid-anchor cursor.

Task 6.3 MUST NOT introduce a separate Supplier-only error architecture or expose raw PostgreSQL
errors. Foreign Supplier existence MUST remain indistinguishable from ordinary absence.

## 21. Future Implementation Direction

Future implementation MUST follow the established controller to read-service to read-repository
layering. Controllers remain thin. Authorization and response mapping belong outside persistence;
SQL or Drizzle queries belong in the repository. Reads use `AuthenticationGuard`, the trusted
principal and tenant context, `DatabaseService.withTenantTransaction`, explicit same-store
predicates, explicit projections, and forced RLS.

This direction does not authorize implementation in the contract-freeze phase and does not freeze
class names, filenames, helper names, or query-builder mechanics as business policy.

## 22. Future Implementation Verification Gates

Future Task 6.3 implementation and tests MUST prove:

1. only an active `owner` membership with matching trusted principal/context can use Supplier
   list, search, and detail;
2. `manager`, `viewer`, `support`, platform administrator, and mismatched principal/context access
   is rejected before Supplier repository access;
3. same-store reads succeed while foreign detail is indistinguishable from absence and foreign
   rows, counts, and anchors never appear in list or search;
4. every repository read uses transaction-local trusted context, explicit store predicates, and
   the normal non-bypass runtime while Supplier RLS remains enabled and forced;
5. transaction-local context cannot leak across commit, rollback, failure, timeout, or pool reuse;
6. list/search defaults to active, supports explicit archived, exposes no `all` mode, and returns
   exactly the Section 7 projection;
7. detail returns same-store active and archived rows using exactly the Section 8 projection;
8. legacy null phone is returned as `null` without fabrication, repair, omission, or failure;
9. phone is visible in list, search results, and detail, while notes are detail-only and never
   searchable;
10. normalized, tenant, device, and operation fields never become public or enter cursor/logging
    metadata;
11. name search reproduces Supplier normalization-v1, literal-prefix semantics, wildcard escaping,
    and the approved Arabic, Latin, whitespace, tatweel, and diacritic behavior;
12. phone search uses exact Task 6.2 canonical output, preserves approved `+970`/`+972` behavior,
    and provides no prefix, substring, or digit-fragment enumeration;
13. omitted search is unfiltered within lifecycle scope, while explicit empty or v1-whitespace-only
    search is rejected;
14. ordering is `normalized_name ASC, id ASC` and keyset continuation uses the same total order;
15. cursors are versioned and scope-bound, anchors are validated without existence disclosure,
    default limit is 50, and strict valid limits are 1 through 100;
16. `version` is a lossless decimal string and timestamps are factual UTC ISO-8601 strings;
17. `read_only` stores may read through established valid sessions while suspended/archived stores
    receive no Supplier-specific bypass;
18. reads create no operation claim, idempotency, replay, mutation audit/change event, accounting,
    payable, payment, inventory, receipt, stock, or costing effect;
19. PostgreSQL, SQLite, Drizzle, applied migrations, and immutable reference files remain
    unchanged;
20. query/error logging does not expose raw search input, phone, cursor state, notes, SQL values,
    foreign existence, or internal provenance.
