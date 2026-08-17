# Product and Unit Validation Contract v1

## Scope and Authority

This document records Station 5 / Task 5.2 application-level Product and Product Unit value
validation. The pure, framework-independent implementation is
`src/products/product-validation.ts`. Language-neutral golden vectors are in
`docs/contracts/product-unit-validation-v1.json`.

This contract conforms to the existing `ledger.products` and `ledger.product_units` PostgreSQL
contract. It adds no API, persistence workflow, inventory behavior, accounting behavior, Sync
behavior, or migration. PostgreSQL constraints, forced RLS, and transaction-time checks remain
authoritative.

## Rule Ownership

| Concept                     | Pure value or cross-field validation in Task 5.2                 | Database-state precondition                   | Transaction-time invariant                                     |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Product and operation UUIDs | Established UUID domain; canonical lowercase text                | Referenced identity existence                 | Store identity and operation uniqueness                        |
| Product name                | Display canonicalization and Product Normalization v1 derivation | None                                          | None                                                           |
| SKU and barcode             | Nullable text canonicalization                                   | Current store-scoped availability             | Unique constraint and race handling                            |
| Measurement type            | Closed enum; same-payload Product/Unit equality                  | Parent Product state                          | Composite Product/Unit FK                                      |
| Product Unit label/code     | Approved text canonicalization                                   | Current Product-scoped Unit-name availability | Unique constraint and race handling                            |
| Conversion factors          | Positive PostgreSQL `int4`; base `1/1` cross-field rule          | None                                          | Persisted factor and base-ratio constraints                    |
| Rule A: active conversion   | None                                                             | Required active base-unit structure           | Task 5.4 create/update and Task 5.5 restore/reactivation paths |
| Rule B: active base removal | None                                                             | Active dependent conversion Units             | Task 5.5 archive/deactivate/removal/replacement paths          |
| Price and threshold         | Nullable nonnegative PostgreSQL `bigint`                         | None                                          | None                                                           |
| Negative-stock override     | Exact `null/false/true` domain                                   | Store default is consulted by inventory       | Future inventory transaction                                   |
| Lifecycle and version       | Structural persisted value domains only                          | Current related units and records             | Version check, archive/restore, final constraints              |

Pure validation never claims SKU/barcode/Unit-name availability, Product existence, active base-unit
existence, archive eligibility, operation replay state, or optimistic-version success.

## Product Normalization v1

`PRODUCT_NORMALIZATION_VERSION` is `1`. The recognized whitespace set is exactly:

```text
U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680,
U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000
```

The display `name` trims outer approved whitespace and collapses internal approved whitespace to
one ASCII space. It otherwise preserves Unicode spelling, case, punctuation, Arabic letter
distinctions, Arabic vocalization, and tatweel. The result must not be empty.

The server derives `normalized_name` from the canonical display name in this order:

1. Unicode NFKC using ECMAScript `String.prototype.normalize`;
2. trim/collapse the approved whitespace set;
3. locale-independent ECMAScript `toLowerCase()`;
4. remove U+0640 Arabic tatweel;
5. remove U+064B..U+065F and U+0670 only;
6. fold `أ`, `إ`, `آ`, and `ٱ` to `ا`.

The letters `ة`, `ى`, `ؤ`, and `ئ` are not folded. Punctuation, symbols, and combining marks
outside the closed removal set remain. There is no transliteration or fuzzy correction.

Both canonicalizers are deterministic and idempotent. A future mobile implementation must execute
the same ordered operations and pass every static vector. A client may calculate the value for
offline use, but it is not authoritative input to the backend; the backend derives it from the
canonical display name before future request hashing or persistence.

## Optional Product Identifiers

SKU and barcode accept explicit `null` or PostgreSQL-representable text. Approved outer whitespace
is trimmed. Empty-after-trim becomes `null`; internal text, case, Unicode, and punctuation remain
unchanged. No Arabic or case folding is applied.

SKU remains case-sensitive. Barcode is an opaque text identifier: leading zeroes are preserved,
numeric coercion is prohibited, and no EAN/UPC/GTIN/checksum rule is applied. PostgreSQL enforces
exact store-scoped uniqueness. Archived Products continue reserving persisted SKU and barcode
values.

An omitted future create/PATCH field is not a value supplied to these canonicalizers. Task 5.4 must
define omission as create default, unchanged patch state, or an explicit clear operation without
conflating omission with this value-level empty-to-null rule.

## Description and Unit Labels

Product `description` preserves explicit `null`, empty text, whitespace, and valid user-authored
text exactly. It is not Product-name-normalized and is never silently truncated.

Product Unit `unit_name` is required. It trims and collapses the approved whitespace set, then
preserves case, punctuation, and Unicode/Arabic spelling. Product Unit `unit_code` is nullable,
trims only outer approved whitespace, maps empty-after-trim to `null`, and otherwise preserves
internal text and case. Neither value uses Product-name Arabic or case folding. Unit-name
availability remains a database-state concern.

## Measurement and Conversion Ratios

Canonical measurement types are exactly `count`, `weight`, `volume`, and `length`. Aliases and
localized persisted forms are not accepted. Same-payload Product and Unit types may be compared
purely; compatibility with an existing Product remains enforced by the tenant-safe PostgreSQL FK.

`factor_num` and `factor_den` are exact JavaScript integers in the PostgreSQL positive `int4`
domain `1..2147483647`. Their supplied pair is preserved. `1/2` and `2/4` are distinct
representations; no GCD reduction, floating-point equality, or decimal approximation is used.

A base Unit must be `1/1`. A non-base Unit may be `1/1`. The ratio means the number of base units
represented by the Product Unit, but Task 5.2 performs no inventory calculation.

## Bigint, Null, Zero, and Tri-State Values

`sale_price_minor`, `purchase_price_minor`, and `low_stock_threshold_milli` accept only internal
TypeScript `bigint` values in `0..9223372036854775807`, or `null`. JavaScript numbers and implicit
string coercion are rejected. Future HTTP DTOs may parse validated decimal integer strings into
`bigint` before calling this layer.

For prices, `null` is unknown/not set and `0n` is explicit zero. For the low-stock threshold,
`null` is no Product-specific threshold and `0n` is an explicit zero threshold.
`allow_negative_stock_override` preserves `null` as store-policy inheritance, `false` as an
explicit false override, and `true` as an explicit true override. Required booleans such as
`track_inventory` and `is_pinned` accept booleans only.

## PostgreSQL and Offline Representability

Accepted UUIDs, measurement values, factor ranges, bigint values, nullability, and required-name
outputs fit the existing PostgreSQL schema. Text validation rejects U+0000 and malformed UTF-16
that cannot be transported as the same PostgreSQL Unicode value. No text is truncated.

SQLite can represent conversion integers wider than PostgreSQL `int4`. A future Sync boundary must
reject or explicitly resolve out-of-range SQLite values before PostgreSQL persistence; SQLite's
wider storage does not enlarge the backend domain. Bigint/minor-unit values must use lossless
integer transport. Null, zero, false, and omitted fields remain distinct.

## Approved Future Base-Unit Lifecycle Policy

The backend owner approved both future lifecycle rules. Each is a database-state precondition and
transaction-time invariant that must be enforced by every authoritative mutation transaction
capable of creating or reintroducing a violating state.

### Rule A: Required Active Base Structure

An active non-base/conversion Unit requires an active base-unit structure for its Product. This is
not exclusively a Task 5.5 concern. Future enforcement belongs to:

- Task 5.4 create/update transactions that create an active conversion Unit or change a Unit in a
  way that produces an active conversion relationship;
- Task 5.5 restore/reactivation and other lifecycle transactions that reintroduce an active
  conversion state.

### Rule B: Base Removal or Archive

An active base Unit cannot be archived, deactivated, removed, or replaced in a way that removes the
required active base structure while dependent active conversion Units remain. Future enforcement
belongs to Task 5.5 archive/deactivate/removal/replacement lifecycle transactions.

Task 5.2 does not query Unit state or implement either rule. It adds no create/update, lifecycle,
archive/restore, or database behavior. A separately reviewed forward PostgreSQL migration may be
considered only if later architecture establishes that database-level enforcement is required.

## Validation Errors and Non-Scope

`ProductValidationError` exposes a stable code and field without including the rejected value.
HTTP error mapping belongs to a later API task. The implementation performs no logging, database
query, mutation, uniqueness check, lifecycle workflow, idempotency claim, inventory operation,
accounting operation, or synchronization operation.
