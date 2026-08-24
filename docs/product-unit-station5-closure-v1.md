# Product and Unit Station 5 Closure Contract v1

## Scope

This document freezes Station 5 / Task 5.6 as **Profile A: verification and documentation only**.
Task 5.6 synchronizes the README with the implemented Product and ProductUnit surface, reruns the
existing privacy and Station 5 closure evidence, and introduces no new Product behavior.

Production code changes, new tests, migrations, Drizzle changes, database reference changes, and
owner decisions are not expected. During execution, `README.md` is the only expected repository
content change. Any contradictory evidence must stop execution instead of expanding this contract.

The closed contracts remain authoritative:

- [database mapping](contracts/product-unit-database-contract.md)
- [validation](product-unit-validation-v1.md)
- [read and search](product-unit-read-v1.md)
- [create and update](product-unit-write-v1.md)
- [archive and restore](product-unit-lifecycle-v1.md)

## Task 5.3 Boundary

Task 5.3 remains closed. Task 5.6 may rerun its Product list, detail, search, status, ordering,
pagination, cursor, bigint-response, archived-visibility, ProductUnit-visibility, and tenant
non-disclosure evidence, but does not redesign or reopen those policies. A newly discovered
contradiction is a blocker and must be reported.

## Privacy Regression Boundary

Existing tests must continue to prove:

- trusted server-derived tenant context, forced RLS, and no cross-tenant Product or ProductUnit
  disclosure;
- strict query grammar, including malformed, empty, duplicate, and literal-wildcard handling;
- tenant- and query-scope-bound cursors, tamper rejection, and non-disclosing invalid or foreign
  anchors;
- non-disclosing errors without SQL, constraints, stack traces, tenant identifiers, or internal
  cursor state;
- tenant-scoped exact SKU and barcode lookup without cross-tenant enumeration; and
- no material Product-query disclosure through current request, error, or database logging.

Task 5.6 creates no new privacy or logging policy and adds no tests unless execution first proves an
existing required property lacks evidence.

## README Delta

The README is stale and must be updated during Task 5.6 execution, not during this contract-freeze
phase. The update must concisely summarize or link:

- Product list, detail, search, status filtering, cursor pagination, archived visibility, and
  ProductUnit representation through Product detail;
- Product create/update and standalone ProductUnit create/update;
- dedicated Product and ProductUnit archive/restore endpoints, with no generic writable status
  PATCH;
- server-derived tenant authority, active-owner authorization, tenant safety, and foreign-data
  non-disclosure; and
- lossless decimal-string API representation for applicable PostgreSQL `bigint` values.

The README must link the authoritative contracts above, correct any claim that implemented business
functionality stops at Customers, and keep Sales, Inventory, Costing, supplier financial workflows,
Sync, and other future domains clearly unimplemented. It must remain a concise navigation and
system-summary surface, not duplicate the contracts or present cursor internals as client authority.

## Verification Obligations

Task 5.6 execution must use existing repository-defined checks to verify:

1. README formatting and factual consistency across database, validation, read, write, and
   lifecycle contracts.
2. Product read, search, cursor, write, lifecycle, idempotency, replay, concurrency, Rule A, and
   Rule B regressions.
3. Real PostgreSQL tenant isolation, forced RLS, trusted context, owner authorization, store-state
   behavior, and foreign-data non-disclosure.
4. Repository formatting, lint, typecheck, build, full unit, full integration, and relevant security
   suites, with no skipped or focused-only tests.
5. Migration status and checksums, runtime database/security checks, reference integrity, clean
   diffs, and no test residue or idle transactions where repository-standard checks exist.

No unexecuted check may be reported as passing. Existing evidence is expected to be sufficient; a
real evidence gap or implementation defect must be classified before any scope change.

## Station 5 Closure Gate

Station 5 may close only after Task 5.6 execution and independent post-execution review confirm:

- Tasks 5.1 through 5.5 remain closed and their contracts are mutually consistent;
- the README accurately describes the implemented Product and ProductUnit APIs;
- all privacy, read, write, lifecycle, security/RLS, idempotency, and concurrency evidence passes;
- five migrations remain applied with zero pending, migration verification passes, and no schema,
  Drizzle, or reference drift exists;
- the repository is clean after the separate execution commit and push; and
- no unresolved Station 5 blocker or Station 6 implementation exists.

Backend-owner closure follows the independent closure review. This contract-freeze commit does not
execute Task 5.6 or close Station 5.

## Schema and Future-Domain Boundaries

Task 5.6 requires no migration, schema object, Drizzle mapping, PostgreSQL reference, or SQLite
reference change. A discovered schema requirement is an architecture blocker, not permission to
create migration `0006`.

Task 5.6 creates no accounting, inventory posting, costing, Sales, supplier, money movement, Sync,
or Station 6 behavior. P55-D5 remains authoritative: future business-domain eligibility for
Products and ProductUnits is deferred and must not be inferred globally from Station 5 lifecycle
status.
