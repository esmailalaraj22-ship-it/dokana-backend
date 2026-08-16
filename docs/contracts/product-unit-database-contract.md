# Product and Unit Database Contract

## Scope

This record covers Station 5 / Task 5.1 persistence mapping only. PostgreSQL is the central
authority. The SQLite schema is a read-only offline/synchronization reference. This record does
not define Product or Unit API behavior, normalization, lifecycle, search, actor authorization,
inventory mutation, or accounting behavior.

Authoritative central objects:

- `ledger.products`
- `ledger.product_units`

Both objects predate the versioned migration ledger and are part of the approved PostgreSQL
baseline. Migrations `0001` through `0005` preserve them; migration `0002` verifies their
inventory and transfers their ownership to `shop_app_migrator`.

## PostgreSQL Contract

### Products

`ledger.products` uses a client-preservable `uuid` primary key and mandatory `store_id`. Its
persisted attributes are `name`, `normalized_name`, nullable `sku`, nullable `barcode`, nullable
`description`, `measurement_type`, `track_inventory`, nullable
`allow_negative_stock_override`, nullable `low_stock_threshold_milli`, `is_pinned`, `status`,
nullable `archived_at`, nullable `device_id`, mandatory `operation_id`, UTC timestamps, and
`bigint version`.

The table has tenant-scoped unique keys for identity, `(id, measurement_type)`, SKU, barcode,
and operation ID. Nullable SKU and barcode therefore retain PostgreSQL nullable-unique
semantics. The device provenance FK is `(store_id, device_id) -> ledger.devices(store_id, id)`.

### Product Units

`ledger.product_units` uses a client-preservable `uuid` primary key and mandatory `store_id` and
`product_id`. `measurement_type` must match the parent Product through the tenant-safe composite
FK `(store_id, product_id, measurement_type) -> ledger.products(store_id, id,
measurement_type)`.

Conversion persistence is `factor_num integer / factor_den integer`, both positive. A base unit
must persist `factor_num = 1` and `factor_den = 1`. Selling and purchase prices are nullable
`bigint` minor-unit master-data values. One active base unit per store/Product is enforced by the
partial unique index `uq_product_one_base_unit`.

### Security and Database Behavior

Both tables:

- are owned by `shop_app_migrator`;
- have RLS enabled and forced;
- use an `ALL` policy comparing `store_id` to `platform.current_store_id()` for both visibility
  and writes;
- are directly available to `shop_app_runtime` for `SELECT`, `INSERT`, `UPDATE`, and `DELETE`,
  with RLS and database triggers remaining authoritative;
- are read-only to `shop_app_readonly` and have no direct `shop_app_auth` table access;
- reject hard deletion through `ledger.prevent_delete()`;
- increment `version` and set `updated_at` through `ledger.touch_mutable_row()`;
- emit central change events after insert/update;
- emit central audit rows after insert/update/delete.

Runtime and readonly roles are non-owner, non-superuser, and non-`BYPASSRLS`. No privilege or
ownership change is introduced by this mapping.

## Mapping Fidelity Matrix

| PostgreSQL object                           | PostgreSQL contract                                                               | Drizzle representation                                                                | Fidelity               | Difference / limitation                                             | Test evidence                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| `ledger.products` identity and tenancy      | `uuid` PK; mandatory `store_id`; no server ID default                             | `uuid().primaryKey()` and mandatory `storeId`                                         | FAITHFUL               | None                                                                | Live column/default comparison                 |
| Product text/state columns                  | Exact text, boolean, nullable, status, and timestamp columns                      | Exact physical names, nullability, booleans, typed text values, UTC `Date` timestamps | FAITHFUL               | Typed text unions are compile-time aids; DB checks remain authority | Live column and check comparison               |
| Product quantity/version bigints            | Nullable `low_stock_threshold_milli`; mandatory `version`                         | `bigint(..., { mode: 'bigint' })`                                                     | FAITHFUL               | API representation remains later scope                              | Static mapping and live precision test         |
| Product unique constraints                  | Tenant-scoped identity, measurement, SKU, barcode, operation                      | Named Drizzle `unique` constraints                                                    | FAITHFUL               | PostgreSQL nullable-unique behavior remains authoritative           | Live unique-key comparison                     |
| Product FKs                                 | Store FK and tenant-safe nullable device FK                                       | Named Drizzle FKs with matching update/delete actions                                 | FAITHFUL               | None                                                                | Live FK comparison                             |
| `idx_products_search`                       | Six-column non-unique B-tree index                                                | Named Drizzle index with exact order                                                  | FAITHFUL               | Search policy is not inferred from index presence                   | Live index comparison                          |
| `ledger.product_units` identity and tenancy | `uuid` PK; mandatory store/Product ownership                                      | Exact UUID columns and mandatory ownership fields                                     | FAITHFUL               | None                                                                | Live column/default comparison                 |
| Unit conversion fields                      | Positive `integer` numerator/denominator; denominator default 1; base ratio check | Drizzle `integer`, defaults, and named checks                                         | FAITHFUL               | Conversion business semantics remain later scope                    | Live checks plus invalid denominator test      |
| Unit price/version bigints                  | Nullable sale/purchase minor units and mandatory version                          | `bigint(..., { mode: 'bigint' })`                                                     | FAITHFUL               | Values are master data, not postings                                | Above-safe-integer Drizzle round trip          |
| Unit-to-Product relationship                | Composite `(store_id, product_id, measurement_type)` FK                           | Named composite Drizzle FK                                                            | FAITHFUL               | None                                                                | Live FK comparison and cross-store rejection   |
| Unit unique constraints                     | Tenant identity, Product identity, unit name, operation ID                        | Named Drizzle `unique` constraints                                                    | FAITHFUL               | Unit-name policy is not inferred                                    | Live unique-key comparison                     |
| `uq_product_one_base_unit`                  | Partial unique active-base index                                                  | Named Drizzle `uniqueIndex().where(...)`                                              | FAITHFUL               | PostgreSQL is authority for predicate execution                     | Catalog comparison and duplicate rejection     |
| Product/Unit RLS policies                   | ENABLE + FORCE; tenant `USING` and `WITH CHECK`                                   | Not represented as Drizzle table metadata                                             | DATABASE-ONLY BEHAVIOR | Preserved outside ORM                                               | Catalog and runtime isolation tests            |
| Product/Unit grants and ownership           | Migrator ownership; least-privilege runtime/readonly grants                       | Not represented by Drizzle schema                                                     | DATABASE-ONLY BEHAVIOR | Preserved outside ORM                                               | Catalog privilege test and role checks         |
| No-delete/touch triggers                    | BEFORE DELETE and BEFORE UPDATE                                                   | Not represented by Drizzle schema                                                     | DATABASE-ONLY BEHAVIOR | PostgreSQL functions remain authority                               | Trigger catalog and runtime semantic tests     |
| Change/audit triggers                       | AFTER INSERT/UPDATE and AFTER INSERT/UPDATE/DELETE                                | Not represented by Drizzle schema                                                     | DATABASE-ONLY BEHAVIOR | Security-definer functions retain pinned paths                      | Trigger/function catalog and emitted-row tests |

## Bigint and TypeScript Precision

| Field                                | PostgreSQL         | Drizzle mode | TypeScript/runtime | Precision                           |
| ------------------------------------ | ------------------ | ------------ | ------------------ | ----------------------------------- |
| `products.low_stock_threshold_milli` | `bigint`, nullable | `bigint`     | `bigint            | null`                               | Preserved |
| `products.version`                   | `bigint`           | `bigint`     | `bigint`           | Preserved                           |
| `product_units.sale_price_minor`     | `bigint`, nullable | `bigint`     | `bigint            | null`                               | Preserved |
| `product_units.purchase_price_minor` | `bigint`, nullable | `bigint`     | `bigint            | null`                               | Preserved |
| `product_units.version`              | `bigint`           | `bigint`     | `bigint`           | Preserved                           |
| `product_units.factor_num`           | `integer`          | number       | `number`           | Safe across PostgreSQL `int4` range |
| `product_units.factor_den`           | `integer`          | number       | `number`           | Safe across PostgreSQL `int4` range |

Authoritative bigint values preserve integer precision. API serialization is intentionally out of
scope for Task 5.1.

## PostgreSQL to SQLite Compatibility Matrix

| Concept                    | PostgreSQL                                 | SQLite                                                                                                      | Semantic equivalence                  | Conversion required               | Sync-stable        | Risk / note                                                                                     |
| -------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| Product ID                 | `uuid`                                     | UUID text                                                                                                   | ALIGNED                               | Text/UUID validation              | Yes                | Preserve accepted UUID                                                                          |
| Unit ID                    | `uuid`                                     | UUID text                                                                                                   | ALIGNED                               | Text/UUID validation              | Yes                | Preserve accepted UUID                                                                          |
| Store ownership            | `uuid store_id` plus forced RLS            | UUID text plus FKs; no local RLS                                                                            | INTENTIONAL REPRESENTATION DIFFERENCE | Text/UUID conversion              | Yes                | Server RLS is central-only                                                                      |
| Product-to-Unit relation   | Tenant-safe three-column FK                | Same logical three-column FK                                                                                | ALIGNED                               | UUID text conversion              | Yes                | Measurement type is part of relation                                                            |
| Measurement type           | Checked text enum set                      | Same checked text set                                                                                       | ALIGNED                               | None                              | Yes                | Product policy remains undefined                                                                |
| Conversion ratio           | Positive PostgreSQL `integer` pair         | Positive SQLite `INTEGER` pair                                                                              | ALIGNED                               | Range validation at sync boundary | Yes                | SQLite integer range is wider than PostgreSQL int4                                              |
| Monetary master data       | Nullable nonnegative `bigint` minor units  | Nullable nonnegative `INTEGER` minor units                                                                  | ALIGNED                               | Lossless integer transport        | Yes                | Never route through JS `number`                                                                 |
| Low-stock quantity         | Nullable nonnegative `bigint` milli-units  | Nullable nonnegative `INTEGER` milli-units                                                                  | ALIGNED                               | Lossless integer transport        | Yes                | This is configuration, not a stock mutation                                                     |
| Booleans                   | PostgreSQL `boolean`                       | checked `INTEGER` 0/1                                                                                       | INTENTIONAL REPRESENTATION DIFFERENCE | Boolean/0-or-1 conversion         | Yes                | Explicit conversion required                                                                    |
| Status                     | checked text `active/archived`             | same checked text values                                                                                    | ALIGNED                               | None                              | Yes                | Lifecycle policy remains later scope                                                            |
| Version                    | PostgreSQL `bigint`                        | SQLite `INTEGER`                                                                                            | ALIGNED                               | Lossless integer transport        | Yes                | Preserve monotonic integer value                                                                |
| Timestamps                 | UTC `timestamptz`; server `now()` defaults | UTC epoch milliseconds; client supplies timestamps                                                          | INTENTIONAL REPRESENTATION DIFFERENCE | UTC instant/epoch conversion      | Yes                | Timestamp source rules belong to mutation contract                                              |
| No hard delete             | Generic PostgreSQL no-delete trigger       | Table-specific SQLite no-delete trigger                                                                     | ALIGNED                               | Error mapping only                | Yes                | Trigger messages differ                                                                         |
| Unit lifecycle guards      | No equivalent PostgreSQL trigger           | SQLite requires an active base before active conversion and blocks archiving a base with active conversions | MATERIAL DRIFT                        | Not yet defined                   | No, until resolved | Must be reconciled before Product/Unit mutation APIs; Task 5.1 does not choose lifecycle policy |
| Server audit/change events | Central triggers and server schemas        | Local sync architecture uses separate local mechanisms                                                      | INTENTIONAL REPRESENTATION DIFFERENCE | Sync protocol                     | Future work        | No mobile runtime is implemented here                                                           |

## Conflict Classification

- `MISSING DRIZZLE MAPPING`: Product and Product Unit baseline objects were not mapped before
  Task 5.1. This task adds the mapping without changing PostgreSQL.
- `EXPECTED REPRESENTATION DIFFERENCE`: UUID/text, boolean/integer, UTC timestamp/epoch, and
  server-only RLS/audit/change behavior differ by database engine but remain semantically
  reconcilable.
- `CONTRACT AMBIGUITY`: SQLite has two additional Product Unit lifecycle triggers with no
  PostgreSQL equivalent. This does not block persistence mapping because Task 5.1 adds no
  lifecycle mutation behavior. It must be resolved from approved Product policy before a later
  Task implements Product Unit lifecycle writes.

No forward migration is required for this mapping.

## Migration Drift Verification

The repository migration ledger, not Drizzle Kit generation, owns forward migration state.
Task 5.1 verifies drift non-destructively by:

1. comparing every mapped Product/Unit column, default, constraint, FK, and explicit index to the
   live applied PostgreSQL catalog;
2. running the repository migration checksum/inventory verification;
3. confirming five applied migrations and zero pending migrations;
4. confirming no generated migration or Drizzle metadata was added.

`drizzle-kit generate` and `drizzle-kit push` are intentionally not used: generation of an
unjustified `0006` is prohibited, and push is a mutating database operation.

## Deferred Product-Policy Questions

The persistence contract does not answer these questions:

- Product-name, SKU, and barcode normalization and canonicalization;
- SKU/barcode requiredness, format, reuse, and archived-value reservation;
- Product and Unit archive/reactivation rules;
- reconciliation of the SQLite-only Product Unit lifecycle guards;
- Product/Unit search and pagination behavior;
- feature-level Product/Unit actor authorization;
- base-unit creation workflow and conversion-domain validation beyond persisted constraints;
- pricing edit/default behavior and when prices are snapshotted by later documents.

These require later approved Product behavior and must not be inferred from nullable columns,
indexes, or current test fixtures.
