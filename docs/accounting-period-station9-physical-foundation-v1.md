# Accounting Period Station 9 Physical Foundation v1

This record documents Station 9 / Task 9.2 only. It adds the application mapping and
deterministic domain primitives over the existing `ledger.accounting_periods` table. It does not
add period APIs, reads, provisioning, lifecycle mutations, close behavior, posting-context
resolution, or any financial or inventory posting workflow.

## Physical Mapping

`src/database/schema/ledger.ts` maps all thirteen existing columns exactly: UUID period and Store
identity, integer year/month, UTC `timestamptz` boundaries, the complete physical lifecycle
vocabulary, nullable close/device provenance, operation identity, timestamps, and lossless
`bigint` version.

The mapping preserves the primary key, three Store-scoped unique constraints, both tenant-safe
foreign keys, and all six ordinary checks. Drizzle does not represent the existing
`accounting_periods_no_overlap` GiST exclusion constraint in table metadata. PostgreSQL remains
authoritative for this constraint:

```text
store_id WITH =
tstzrange(starts_at, ends_at, '[)') WITH &&
```

The real-PostgreSQL contract test verifies that the exclusion constraint exists, accepts adjacent
canonical months, and rejects overlap. No application overlap authority is introduced.

Forced RLS, the tenant policy, no-delete/touch/change/audit/lifecycle triggers, and
`ledger.assert_period_open` / `ledger.enforce_period_open` remain unchanged and are verified as
physical safeguards only.

## Stable Domain Primitives

`src/accounting-periods` defines:

- the faithful `open`, `closing`, and `closed` status representation;
- a lossless physical row type aligned with the Drizzle inferred row;
- a pure monthly-boundary resolver fixed to `Asia/Hebron`;
- the frozen accounting-period UUIDv5 namespace and identity derivation.

Monthly boundaries use the runtime IANA/TZDB rules to resolve local midnight on the first day of
the selected month and the first day of the next month. The returned values are UTC `Date`
instants representing the half-open `[start, end)` interval. The helper does not use the host
timezone, locale formatting, fixed offsets, or fixed 24-hour arithmetic.

Identity uses the frozen namespace `2c9aa30a-c026-5003-93f8-8e2e921c76ff` and exact UTF-8 name:

```text
<canonical-lowercase-store-uuid>:<YYYY-MM>
```

Input validation accepts PostgreSQL-compatible canonical UUID text and canonicalizes letter case
before hashing. This is required by the approved cross-platform Store test vector; it does not
substitute `operationId` for `accountingPeriodId`.

## PostgreSQL / SQLite Compatibility

The approved PostgreSQL and SQLite references expose the same synchronized period facts: period
and Store identity, year/month, boundaries, status, nullable close/device provenance, operation
identity, timestamps, and version. Engine-specific representation and enforcement remain
deliberately different:

- PostgreSQL uses native UUID, `timestamptz`, forced RLS, GiST exclusion, and server triggers.
- SQLite uses canonical UUID text, UTC integer instants, local overlap/lifecycle triggers, and no
  PostgreSQL-style RLS.

The read-only SQLite contract test verifies the shared columns, types, nullability, defaults,
foreign-key integrity, and period trigger set. No SQLite reference file changed.

## Database and Task Boundary

```text
PostgreSQL migration:    0
SQLite change:           0
RLS or policy change:    0
role or grant change:    0
function or trigger:     0
reference-package change: 0
```

S9.2 is closed after its independent foundation review approved the mapping and runtime evidence.
S9.3 consumes this foundation for tenant-safe reads. S9.4 provisioning/lifecycle, S9.5
posting-context and close-vs-post control, and every S10+ workflow remain not started.
