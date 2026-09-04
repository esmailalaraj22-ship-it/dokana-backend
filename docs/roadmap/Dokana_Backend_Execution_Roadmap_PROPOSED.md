# Dokana Backend Execution Roadmap

## 1. Document Status and Governance

| Field                    | Value                                      |
| ------------------------ | ------------------------------------------ |
| Status                   | **APPROVED - ACTIVE EXECUTION ROADMAP**    |
| Repository               | `C:\Users\esmail\Desktop\Dokana`           |
| Review branch            | `main`                                     |
| Review checkpoint        | `85ab494ac9383e6e31cba266a5b0d3749dee7740` |
| Closed execution history | Stations S0 through S9                     |
| Next candidate           | S10.5 - Reversal / Replacement              |

This document is the approved execution-tracking roadmap. It is not a product contract,
does not by itself authorize implementation, and does not start or freeze any future
Station. Every future Station still requires orientation, contract review, verification,
independent review where applicable, and backend-owner approval.

The roadmap is subordinate to the authorities listed below. If it conflicts with a
higher authority, the higher authority wins and the roadmap must be corrected through
review rather than silently reinterpreted.

## 2. Dokana Backend Purpose and Architecture Boundary

Dokana is the backend for an offline-first SaaS application for small-shop accounting
and daily operations. It is intentionally simpler than a full ERP while remaining
secure, auditable, tenant-isolated, and correct for real financial and inventory data.

The approved backend stack is NestJS, TypeScript, Drizzle ORM, PostgreSQL, and REST
APIs. PostgreSQL is the central backend, synchronization, recovery, subscription, and
administration authority. The mobile application uses SQLite for local offline
operation and reaches PostgreSQL only through authenticated HTTPS APIs.

This repository owns backend services, database contracts, migrations, security,
accounting workflows, synchronization, backup/recovery, reporting, observability, and
tests. Flutter, Drift, mobile UI, and client-side implementation are outside this
repository. The SQLite reference remains relevant to shared data and synchronization
compatibility, but it is not implemented here as a mobile application.

## 3. Authority and Precedence

The roadmap follows this precedence:

1. Current explicit backend-owner decisions.
2. [Root AGENTS.md](../../AGENTS.md).
3. [Approved PRD v1.1](../product/Dokana_PRD_v1.1_APPROVED.md).
4. Approved architecture, security, domain, and database contracts.
5. Applied migrations in chronological order.
6. Current reviewed Drizzle mappings.
7. Approved PostgreSQL baseline and SQLite/PostgreSQL references.
8. Tests and implementation when consistent with higher authorities.

The roadmap does not duplicate those sources. It records execution ownership,
dependencies, and current project position. Material conflicts must be reported to the
backend owner before implementation.

## 4. Current Project Checkpoint

The roadmap was reconstructed against this verified state:

| Check                           | Verified state                                 |
| ------------------------------- | ---------------------------------------------- |
| Branch                          | `main`                                         |
| HEAD                            | `85ab494ac9383e6e31cba266a5b0d3749dee7740`     |
| `origin/main`                   | `85ab494ac9383e6e31cba266a5b0d3749dee7740`     |
| Ahead/behind                    | `0/0`                                          |
| Working tree                    | Clean                                          |
| Migrations                      | 5 applied, 0 pending                           |
| Migration checksum verification | Pass                                           |
| Reference SHA-256 verification  | 11 files checked, 0 mismatches                 |
| Last fully closed Station       | S9                                             |
| Later Station started           | No; S10 remains not started                    |

The approved reference package under
[`database/reference/backend_database_reference`](../../database/reference/backend_database_reference/)
remains read-only. Its all-in-one PostgreSQL schema is an initialization baseline, not
the future migration mechanism.

## 5. Completed Stations S0-S9

Completed Stations are immutable execution history. Remaining work may build on their
foundations but must not reopen or repeat them without new concrete blocking evidence.

| Station                                              | Status | Delivered capability                                                                                                                | Historical coverage                                                | Evidence                                                                                                                                                                              |
| ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0 - Repository and Reference Assessment             | CLOSED | Repository, baseline, SQLite, mapping, and test-reference assessment                                                                | Historical repository/reference assessment                         | Project history and reference package                                                                                                                                                 |
| S1 - PostgreSQL Runtime Validation                   | CLOSED | Real PostgreSQL baseline/runtime assessment and documented limitations                                                              | Historical PostgreSQL validation                                   | Reference runtime evidence and project history                                                                                                                                        |
| S2 - NestJS Backend Infrastructure                   | CLOSED | Configuration, logging, health, database transaction context, and test infrastructure                                               | Historical NestJS infrastructure                                   | Git history and [README](../../README.md)                                                                                                                                             |
| S3 - Authentication and Database Security Foundation | CLOSED | Controlled migration ledger/runner, role boundaries, auth API, sessions/tokens, membership and device bootstrap, RLS/security tests | Historical migration foundation and much of identity/platform core | [Station 3 architecture](../station-3-architecture.md) and migrations `0001`-`0005`                                                                                                   |
| S4 - Business Foundation and Customers               | CLOSED | Store business-write gate plus Customer database, validation, read, write, lifecycle, privacy, and idempotency contracts            | Customer portion of historical master data                         | Commits through `a6f567f` and Customer contracts                                                                                                                                      |
| S5 - Product and Product Unit Catalog                | CLOSED | Product/unit mapping, validation, reads, writes, lifecycle, privacy, replay, and rollback behavior                                  | Product/unit portion of historical master data                     | [Station 5 closure](../product-unit-station5-closure-v1.md)                                                                                                                           |
| S6 - Supplier Master Data Foundation                 | CLOSED | Supplier mapping, validation, reads, writes, lifecycle, privacy, replay, and rollback behavior                                      | Supplier-master portion of historical master data                  | [Station 6 closure](../supplier-station6-closure-v1.md)                                                                                                                               |
| S7 - Store Operational Settings Foundation           | CLOSED | Settings mapping, operational-time context, tenant-safe reads, initialization, and idempotent owner-authorized mutations            | Operational settings portion of historical master data             | [S7 contract](../contracts/store-settings-operational-time-v1.md) and [S7.4 record](../settings-station7-safe-mutation-v1.md)                                                         |
| S8 - Money Account Catalog Foundation                | CLOSED | Money Account mapping, validation, tenant-safe reads/writes, lifecycle, idempotency, and one-active-Cash invariants                 | Money Account portion of historical master data                    | [S8.2 record](../money-account-station8-physical-foundation-v1.md), [S8.3 record](../money-account-station8-read-v1.md), and [S8.4 record](../money-account-station8-lifecycle-v1.md) |
| S9 - Accounting Periods and Posting Controls         | CLOSED | Monthly period mapping/identity, boundaries, non-overlap, tenant-safe reads, on-demand provisioning, terminal owner close, idempotency, and posting-context/close-vs-post control | Accounting-period portion historically deferred with corrections   | [S9.1 contract](../contracts/accounting-period-v1.md), [S9.2 record](../accounting-period-station9-physical-foundation-v1.md), [S9.3 record](../accounting-period-station9-read-v1.md), and [S9.4 record](../accounting-period-station9-provisioning-lifecycle-v1.md) |

The safe completed boundary does not include subscription lifecycle, money posting or
balances, inventory, supplier financial workflows, sales, generic synchronization,
reporting, or recovery.

## 6. Historical Roadmap Reconciliation

| Historical area                         | Current classification  | Already satisfied by                                                    | Remaining work                                         | Proposed future owner |
| --------------------------------------- | ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | --------------------- |
| Repository/reference assessment         | DONE                    | S0                                                                      | None                                                   | None                  |
| PostgreSQL runtime validation           | DONE                    | S1                                                                      | Final release revalidation                             | S23                   |
| NestJS infrastructure                   | DONE                    | S2                                                                      | Domain-specific extensions                             | Respective Stations   |
| Drizzle schema and migration foundation | PARTIAL, ABSORBED       | S3-S8                                                                   | Incremental domain mappings and versioned migrations   | Respective Stations   |
| Identity/platform core                  | PARTIAL, SPLIT          | S3-S4                                                                   | Subscription, licensing, store/device administration   | S18                   |
| Subscriptions/licenses                  | PARTIAL, STILL REQUIRED | Auth and store-status enforcement                                       | Full subscription and offline-license lifecycle        | S18                   |
| Master data                             | SPLIT, COMPLETE         | Customers S4, Products S5, Suppliers S6, Settings S7, Money Accounts S8 | None                                                   | None                  |
| Sales/receivables                       | SPLIT, STILL REQUIRED   | Prerequisites only                                                      | Sale posting, receivables, collections                 | S14-S15               |
| Supplier invoices/payables              | PARTIAL, SPLIT          | Supplier master prerequisite                                            | Invoice/payable posting and settlement                 | S12-S13               |
| Manual inventory/costing                | STILL REQUIRED          | Product prerequisite and physical baseline                              | Inventory authority, projection, and costing           | S11                   |
| Expenses/owner ledger                   | SPLIT, MOVED            | Physical baseline only                                                  | Owner/money foundation early, expenses later           | S10, S16              |
| Returns/corrections/periods             | SPLIT, PARTIAL          | Period controls S9 (closed)                                             | Corrections later                                      | S17                   |
| Sync engine                             | PARTIAL, STILL REQUIRED | UUID, operation, replay, and change-event foundations                   | Generic push/pull/conflicts/bootstrap                  | S19                   |
| Backup/bootstrap/restore                | SPLIT, STILL REQUIRED   | Auth/device bootstrap only                                              | Business-data bootstrap with sync, recovery separately | S19, S22              |
| Reports/audit/admin                     | PARTIAL, SPLIT          | Central audit infrastructure                                            | SaaS admin, reports, audit access, notifications       | S18, S20-S21          |
| Final validation                        | STILL REQUIRED          | Per-Station verification                                                | Cross-domain release gate                              | S23                   |

Historical numbering is discovery evidence, not a dependency constraint. The current
sequence preserves full scope while moving foundations ahead of their consumers.

## 7. Current Capability State

### Implemented

- NestJS infrastructure, configuration, observability, health, and PostgreSQL access.
- Controlled, checksum-verified migrations and least-privilege database roles.
- Authentication, sessions, refresh rotation, memberships, device bootstrap, and
  trusted tenant context.
- Forced/fail-closed RLS and the shared store business-write transaction boundary.
- Customer, Product/Product Unit, and Supplier master-data APIs and contracts.
- Store settings, fixed `Asia/Hebron` operational-time context, and owner-authorized
  settings reads and writes.
- Money Account catalog reads, writes, lifecycle, deterministic Cash provisioning, and
  one-active-Cash enforcement.
- Domain mutation foundations using stable UUIDs, `operationId`, canonical request
  hashes, exact/rejected replay, versions, processed operations, audit effects, and
  change events.

### Partially implemented

- Store status is enforced, but subscription and offline-license lifecycle is not.
- Audit infrastructure exists, but product-facing and administrative audit access does
  not.
- Processed operations and change events exist, but generic synchronization,
  conflicts, cursors, and data bootstrap do not.
- Drizzle maps current implemented domains, not every future baseline table.

### Still required

Accounting periods, money posting, owner ledger, inventory/costing, supplier financial
workflows, sales/receivables, collections, expenses, returns/corrections, platform
lifecycle, generic synchronization, reports, notifications, attachments, backup/restore,
and final release validation.

## 8. Remaining PRD Coverage and Completeness Map

| PRD capability                                     | Current state                        | Execution owner                 |
| -------------------------------------------------- | ------------------------------------ | ------------------------------- |
| Authentication/session/device foundation           | Implemented                          | S3; platform extensions S18     |
| Tenant isolation/business-write authorization      | Implemented                          | Reused by every domain          |
| Customer master data                               | Implemented                          | S4; attachment support S21      |
| Product and Product Unit catalog                   | Implemented                          | S5; attachment support S21      |
| Supplier master data                               | Implemented                          | S6; financial workflows S12-S13 |
| Store operational settings                         | Implemented                          | S7 (closed)                     |
| Money Account catalog                              | Implemented                          | S8 (closed)                     |
| Accounting periods/posting controls                | Implemented                          | S9 (closed)                     |
| Money movements/transfers/balances/owner ledger    | Still required                       | S10                             |
| Manual inventory/stock projection/costing          | Still required                       | S11                             |
| Supplier invoices/payables                         | Still required; legacy conflict      | S12                             |
| Supplier payments/allocations/credits              | Still required                       | S13                             |
| Sales and customer receivables                     | Still required                       | S14                             |
| Customer collections/credit/settlement             | Still required                       | S15                             |
| Expenses and expense payments                      | Still required                       | S16                             |
| Returns/reversals/corrections                      | Still required                       | S17 and each source Station     |
| Subscription/offline licensing/SaaS administration | Partially implemented                | S18                             |
| Generic sync and consistent data bootstrap         | Partially implemented foundation     | S19                             |
| Dashboard/reports/search/documents/export          | Still required                       | S20                             |
| Notifications/attachments/audit access             | Partially implemented infrastructure | S21                             |
| Backup/restore/recovery                            | Still required                       | S22                             |
| Final security/recovery/release validation         | Still required                       | S23                             |
| Automatic or partial invoice goods receipt         | Superseded by approved design        | No future owner                 |
| Flutter/Drift/SQLite mobile implementation         | Outside backend scope                | Mobile project                  |

If S9-S23 are completed against their approved future contracts, every material backend
PRD capability has an execution owner. No material capability is intentionally orphaned.

## 9. Opening and Initial-State Ownership

Opening state is assigned to the Station that owns its authoritative ledger or movement:

| Opening capability                    | Proposed owner | Authority created there                            |
| ------------------------------------- | -------------- | -------------------------------------------------- |
| Money account and owner opening state | S10            | Money movements, balance projections, owner ledger |
| Inventory opening state               | S11            | Inventory movements, stock projections, costing    |
| Supplier payable opening state        | S12            | Supplier payable ledger                            |
| Customer receivable opening state     | S14            | Customer receivable ledger                         |

Future contracts must determine approved accounting details. This assignment does not
invent opening-balance behavior or authorize implementation before orientation.

## 10. Execution Roadmap S7-S23

| Station | Name                                                     | Primary dependency result                   |
| ------- | -------------------------------------------------------- | ------------------------------------------- |
| S7      | Store Operational Settings Foundation                    | Trusted operational time and policy context |
| S8      | Money Account Catalog Foundation                         | Valid money sources and destinations        |
| S9      | Accounting Periods and Posting Controls                  | Open-period and posting-date authority      |
| S10     | Money Posting, Opening Balances, and Owner Ledger        | Authoritative money/owner movements         |
| S11     | Manual Inventory, Stock Projection, and Costing          | Independent inventory and cost authority    |
| S12     | Supplier Invoices and Payables                           | Payable-only supplier invoice posting       |
| S13     | Supplier Payments and Allocations                        | Atomic supplier settlement                  |
| S14     | Sales Posting and Customer Receivables                   | Atomic sales and receivable posting         |
| S15     | Customer Collections, Credits, and Settlement            | Independent receivable settlement           |
| S16     | Expenses and Expense Payments                            | Single-recognition expense workflow         |
| S17     | Returns and Cross-Domain Corrections                     | Linked return/correction orchestration      |
| S18     | Subscription, Offline Licensing, and SaaS Administration | Complete platform lifecycle                 |
| S19     | Offline Sync and Consistent Data Bootstrap               | Deterministic offline convergence           |
| S20     | Dashboard, Reports, Search, Documents, and Export        | Authoritative read-side outputs             |
| S21     | Notifications, Attachments, and Audit Access             | Cross-domain support capabilities           |
| S22     | Backup, Restore, and Recovery                            | Operational recovery                        |
| S23     | Final Validation and Release Readiness                   | Cross-domain release gate                   |

## 11. Future Station Records

### S7 - Store Operational Settings Foundation

- **Status:** CLOSED.
- **Purpose:** Establish trusted store-level operational time and policy context.
- **Distinct boundary:** Settings are shared inputs to periods, inventory, credit,
  reports, notifications, and recovery rather than side effects of those domains.
- **Hard dependencies:** S3 authentication/security and S4 business-write foundation.
- **Soft dependencies:** S8 Money Account naming/default policy may consume settings.
- **Primary deliverables:** Exact PostgreSQL/SQLite/Drizzle mapping; tenant-safe read and
  update APIs; timezone, operational-day, report-time, and approved policy contracts;
  idempotency, versioning, RLS, and owner-authorized behavior as separately approved.
- **Explicit non-scope:** Financial posting, Money Accounts, inventory movements,
  subscription lifecycle, backup execution, and mobile directory handling.
- **Coverage:** Remaining master-data/settings portion and PRD FR-SET policy controls.
- **Known risks/migrations:** Reconcile PostgreSQL `ledger.app_settings` with the SQLite
  v1.2 settings patch without rewriting the reference package.
- **Closure evidence:** Tasks S7.1-S7.4 completed through `6486fae`; independent review,
  remediation, and backend-owner closure completed.
- **Closure intent:** A trusted, tested settings contract that dependent Stations can
  consume without inventing time or policy semantics.

### S8 - Money Account Catalog Foundation

- **Status:** CLOSED.
- **Purpose:** Establish valid money sources and destinations before money movement.
- **Distinct boundary:** Account identity/lifecycle is separable from posting, balances,
  internal transfers, and owner funding.
- **Hard dependencies:** S3 authentication/security and S4 business-write foundation.
- **Soft dependencies:** S7 settings.
- **Primary deliverables:** Money Account mapping, validation, tenant-safe reads/writes,
  lifecycle, account types, and the one-active-cash invariant.
- **Explicit non-scope:** Money movements, balance authority, transfers, opening
  balances, supplier/customer settlement, and expenses.
- **Coverage:** PRD money-account catalog requirements and historical master data.
- **Known risks/migrations:** Account type and default-cash policy must be frozen during
  orientation; no balance may be treated as authoritative from a mutable column.
- **Start condition:** S3-S4 remain valid and S8 contract decisions are approved.
- **Closure intent:** Stable account identifiers and lifecycle ready for S10 posting.
- **Station 8 implementation:** COMPLETE at `43109e3`.
- **Formal Station 8 closure:** COMPLETE; the independent closure review approved S8
  with no blocking findings, and the backend owner authorized formal closure.
- **S9 handoff:** S9 owns Accounting Periods and Posting Controls. No Money
  Account behavior moves into S9.
- **S10 handoff:** S10 consumes stable Money Account IDs/lifecycle and owns movements,
  balances, transfers, opening balances, and owner-money posting. Posting must coordinate
  with S8 lifecycle locking so it cannot race successfully against archive.
- **S18 handoff:** Store/SaaS provisioning must invoke S8
  `SystemCashProvisioningService.ensureForStore` during initial Store provisioning and
  must not reimplement Cash identity, UUID ownership, type/default rules, or lifecycle.
  The current production Store-provisioning caller is `NONE`; this is an approved future
  S18 integration handoff, not an S8 blocker.
- **S19 handoff:** S19 consumes stabilized Money Account IDs, versions, lifecycle,
  idempotency, and change semantics without redefining Money Account business rules.

### S9 - Accounting Periods and Posting Controls

- **Status:** CLOSED.
- **Purpose:** Establish posting-date resolution and open/closed period authority.
- **Distinct boundary:** Period eligibility is a cross-domain accounting control that
  must exist before any posted financial or inventory workflow.
- **Hard dependencies:** S7 operational time and business-day contract.
- **Soft dependencies:** S8 account catalog.
- **Primary deliverables:** Period mapping and lifecycle; non-overlap and no-reopen
  enforcement; posting-context resolution; closed-period rejection; tested RLS and
  concurrency behavior.
- **Explicit non-scope:** Supplier, sale, inventory, expense, owner, or payment posting.
- **Coverage:** Accounting-period portion historically deferred with corrections.
- **Known risks/migrations:** Existing baseline triggers and date semantics must be
  preserved or changed only through reviewed forward migrations.
- **S9.1 contract:** [Accounting Period Contract v1](../contracts/accounting-period-v1.md).
- **S9.2 foundation:**
  [Accounting Period Station 9 Physical Foundation v1](../accounting-period-station9-physical-foundation-v1.md).
- **S9.3 reads:**
  [Accounting Period Station 9 Read Contract v1](../accounting-period-station9-read-v1.md).
- **S9.4 provisioning/lifecycle:**
  [Accounting Period Station 9 Provisioning and Lifecycle v1](../accounting-period-station9-provisioning-lifecycle-v1.md).
- **Task plan:** S9.1 contract; S9.2 physical/Drizzle mapping; S9.3 tenant-safe reads;
  S9.4 on-demand provisioning/lifecycle; S9.5 posting context and close-vs-post control.
- **Progression:** S9.1-S9.4 closed during execution; S9.5 completed the posting-context
  and close-vs-post control. The full independent Station 9 review approved closure with no
  blocking findings.
- **Station 9 implementation:** COMPLETE at `85ab494`.
- **Formal Station 9 closure:** COMPLETE; the independent Station review approved S9 with no
  blocking findings, and the backend owner authorized formal closure.
- **S10 handoff:** S10 and every later posting Station consume the S9 posting-context
  authority and must not reimplement period identity, provisioning, lifecycle, or eligibility.
- **Closure intent:** Reusable posting controls that every later posting Station invokes.

### S10 - Money Posting, Opening Balances, and Owner Ledger

- **Status:** IN PROGRESS. S10.1 CLOSED; S10.2 CLOSED (Money Movement Authority);
  S10.3 CLOSED (Opening Balance and Owner Ledger); S10.4 CLOSED (Internal Transfers);
  S10.5 NEXT / NOT STARTED.
- **S10.2 note:** The legacy accounting-period guard runtime EXECUTE permission was
  reconciled across live DB, the existing PostgreSQL reference, and forward migration `0006`
  (`GRANT EXECUTE ON FUNCTION ledger.assert_period_open(uuid, uuid, timestamptz) TO
  shop_app_runtime`); migrations are now 6 applied / 0 pending.
- **Purpose:** Establish authoritative money movements, projections, transfers, and
  owner funding semantics.
- **S10.1 contract:** [Money Posting Contract v1](../contracts/money-posting-v1.md)
  (zero-database-change; freezes money source of truth, bigint safety, `postingDate =
  businessDate(occurredAt)` compatibility with the existing `occurred_at` period trigger,
  S9 reuse, opening-balance and owner classifications, deferred profit withdrawal, negative
  balance, deterministic fact identity, application immutability, transfer invariant,
  canonical account/transaction order, and the reversal/replacement boundary).
- **Distinct boundary:** Supplier/customer settlements and expenses consume this
  authority; they must not invent their own balance mechanics.
- **Hard dependencies:** S8 Money Accounts and S9 posting controls.
- **Soft dependencies:** S7 reporting and operational settings.
- **Primary deliverables:** Money movement authority; protected balance projections;
  internal transfers; approved money openings; owner capital, loan, reimbursement, and
  personal/capital withdrawal flows; atomic reversal/replacement. Authoritative
  profit-withdrawal classification is deferred until server-authoritative profit
  information exists (later accounting domains); the physical enum value stays dormant.
- **Explicit non-scope:** Supplier payments, customer collections, sale posting, and
  expense recognition.
- **Coverage:** PRD money movement, transfer, owner ledger, and money-opening needs.
- **Known risks/migrations:** Owner money is not shop cash until transferred; owner
  withdrawal is not expense; bigint minor units remain lossless.
- **Start condition:** S8 and S9 closed with approved owner/opening contracts.
- **Closure intent:** One auditable money authority for all later settlements.

### S11 - Manual Inventory, Stock Projection, and Costing

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Establish independent inventory and cost authority before sales.
- **Distinct boundary:** Inventory is movement-driven and independent from supplier
  invoice/payable posting.
- **Hard dependencies:** S5 Product/Unit, S7 settings, and S9 periods.
- **Soft dependencies:** S6 Supplier for optional trace references.
- **Primary deliverables:** Manual inventory documents; authoritative inventory
  movements; protected stock projections; opening stock; counts and adjustments;
  locking/concurrency; negative-stock policy; weighted-average and pending/unknown cost.
- **Explicit non-scope:** Supplier invoice posting, automatic goods receipt, payables,
  sales, and COGS posting.
- **Coverage:** PRD manual inventory, stock, counts, adjustments, and costing.
- **Known risks/migrations:** Do not reuse legacy goods-receipt payable coupling. Unknown
  cost must not become known zero. Optional invoice trace creates no reciprocal effect.
- **Start condition:** S5, S7, and S9 closed; inventory contract and any forward
  migration independently reviewed.
- **Closure intent:** Tested stock/cost authority ready for inventory-enabled sales.

### S12 - Supplier Invoices and Payables

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Post supplier invoices as payable effects only.
- **Distinct boundary:** Invoice recognition and payable creation are separate from
  inventory entry and later cash settlement.
- **Hard dependencies:** S5 Product/Unit, S6 Supplier, and S9 periods.
- **Soft dependencies:** S11 optional inventory trace contract.
- **Primary deliverables:** Mandatory forward remediation; invoice/item lifecycle;
  payable ledger; supplier opening balances; totals and bigint API contract; posting,
  reversal, idempotency, audit, RLS, and concurrency tests.
- **Explicit non-scope:** Inventory movement, goods receipt, partial receipt, supplier
  payment, and expense creation.
- **Coverage:** PRD supplier invoices/payables and approved v1.1 separation.
- **Known risks/migrations:** Legacy invoice closure requires full receipt; receipt
  creates payable; supplier ledger semantics and period context require forward review.
- **Start condition:** S9 closed and the legacy-remediation migration is approved before
  first invoice posting.
- **Closure intent:** Auditable invoice-originated payables with zero automatic inventory
  effects.

### S13 - Supplier Payments and Allocations

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Settle supplier liabilities atomically against approved money sources.
- **Distinct boundary:** Payment/allocation replay and locking differ from invoice
  recognition and deserve independent verification.
- **Hard dependencies:** S10 money/owner authority and S12 supplier payables.
- **Soft dependencies:** S7 alert/default settings.
- **Primary deliverables:** Supplier payment documents; cash/transfer/owner funding;
  allocations; payable and money effects; supplier credits where approved; duplicate,
  rollback, over-allocation, concurrency, reversal, and tenant-isolation tests.
- **Explicit non-scope:** Supplier invoice editing, inventory, goods receipt, and second
  expense recognition.
- **Coverage:** PRD supplier payment and allocation behavior.
- **Known risks/migrations:** Payment must reduce payable and money exactly once and must
  not alter inventory or recognize expense again.
- **Start condition:** S10 and S12 closed with payment/allocation policy approved.
- **Closure intent:** Least-privileged, replay-safe supplier settlement.

### S14 - Sales Posting and Customer Receivables

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Post paid, partial, and credit sales with atomic accounting and inventory
  effects.
- **Distinct boundary:** Sale creation differs from later receivable collection and
  allocation.
- **Hard dependencies:** S4 Customers, S5 Product/Unit, S10 money authority, and S11
  inventory/costing.
- **Soft dependencies:** S7 credit policies and S8 account catalog.
- **Primary deliverables:** Sales/items; readable document numbers; anonymous fully paid
  sales; Customer-required partial/credit sales; mixed payments; receivables; customer
  openings; inventory and COGS; audit/change events; atomic replay and rollback.
- **Explicit non-scope:** Later Customer collections and general return orchestration.
- **Coverage:** PRD sales, payment-at-sale, debt, inventory, and COGS requirements.
- **Known risks/migrations:** Client totals are untrusted; unknown cost remains explicit;
  stock/payment/receivable effects must commit together.
- **Start condition:** S10-S11 closed and sales posting contract independently reviewed.
- **Closure intent:** Correct, tenant-safe, offline-compatible sale posting.

### S15 - Customer Collections, Credits, and Settlement

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Settle existing Customer receivables independently from sale posting.
- **Distinct boundary:** Allocation, overpayment, credit, and replay form a separate
  accounting transaction boundary.
- **Hard dependencies:** S10 money authority and S14 receivables.
- **Soft dependencies:** S7 credit/default policies.
- **Primary deliverables:** Customer payments; default/custom allocation; remaining
  balance protection; overpayment credit/refund flow; independent settlement/discount
  records; money effects; reversal and concurrency tests.
- **Explicit non-scope:** Sale creation and destructive receivable edits.
- **Coverage:** PRD customer collection, allocation, credit, and settlement rules.
- **Known risks/migrations:** Allocations cannot exceed payment or remaining receivable;
  Customer debt is not expense and credit receipt is not sale revenue.
- **Start condition:** S10 and S14 closed with allocation/overpayment policy approved.
- **Closure intent:** Replay-safe receivable settlement with auditable balances.

### S16 - Expenses and Expense Payments

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Recognize paid and due expenses once and settle liabilities correctly.
- **Distinct boundary:** Expense recognition has separate accounting semantics from
  owner capital and supplier payable workflows.
- **Hard dependencies:** S9 periods and S10 money/owner authority.
- **Soft dependencies:** S7 defaults and S21 attachments.
- **Primary deliverables:** Categories; paid/due expense recognition; liabilities;
  cash/transfer/owner-funded payment; manual recurrence metadata; reversal and audit.
- **Explicit non-scope:** Owner-ledger foundation, supplier invoice posting, automatic
  recurrence scheduling, and attachment storage implementation.
- **Coverage:** PRD expense recognition and payment requirements.
- **Known risks/migrations:** Paying an already recognized due expense must not recognize
  expense twice; owner-paid expense creates the correct owner claim.
- **Start condition:** S9-S10 closed and expense lifecycle approved.
- **Closure intent:** Single-recognition expense accounting with correct settlement.

### S17 - Returns and Cross-Domain Corrections

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Coordinate business returns and corrections spanning completed domains.
- **Distinct boundary:** Cross-domain returns combine inventory, money, receivables,
  payables, and period effects beyond each source workflow's basic reversal mechanism.
- **Hard dependencies:** S11-S16 transactional workflows.
- **Soft dependencies:** S7 policy and notification settings.
- **Primary deliverables:** Customer and supplier returns/credits; refund/credit/debt
  settlement; stock disposition; linked correction/replacement documents; closed-period
  correction in an open period; comprehensive atomicity and audit tests.
- **Explicit non-scope:** Retrofitting basic immutability into unsafe source workflows;
  each posting Station must be safe when introduced.
- **Coverage:** PRD returns, cancellations, corrections, and reversal requirements.
- **Known risks/migrations:** Original posted records remain immutable; corrections must
  preserve links, balances, cost, and period history.
- **Start condition:** S11-S16 closed and cross-domain correction contract approved.
- **Closure intent:** Auditable, non-destructive correction and return orchestration.

### S18 - Subscription, Offline Licensing, and SaaS Administration

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Complete central subscription, signed offline license, and platform
  administration lifecycle.
- **Distinct boundary:** Platform administration uses server-only identity and licensing
  authority, separate from tenant accounting modules.
- **Hard dependencies:** S3 authentication/security and S4 store-status enforcement.
- **Soft dependencies:** Business Stations provide usage context but do not block the
  platform contract.
- **Primary deliverables:** Plans; subscriptions; activation, renewal, expiry,
  suspension, and revocation; signed local license issuance/verification contract;
  read-only expiry behavior; store/device administration; admin audit.
- **Explicit non-scope:** Shop accounting, mobile UI, payment-gateway integration, and
  client-side license storage.
- **Coverage:** Historical subscriptions/licenses and PRD SaaS administration.
- **Known risks/migrations:** Runtime store-status enforcement is not proof of complete
  subscription lifecycle; signing keys and admin authority are high risk.
- **Start condition:** Platform contract, signing/key-management policy, and admin
  authorization are approved.
- **Closure intent:** Complete least-privileged platform lifecycle ready for offline sync
  and release.

### S19 - Offline Sync and Consistent Data Bootstrap

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Provide deterministic convergence between SQLite clients and PostgreSQL.
- **Distinct boundary:** Generic push/pull, conflict, cursor, and snapshot consistency are
  cross-domain infrastructure built after mutation contracts stabilize.
- **Hard dependencies:** Stable mutation and lifecycle contracts from S4-S18.
- **Soft dependencies:** S20 reporting consumers.
- **Primary deliverables:** Push/pull APIs; operation dispatch; canonical payload
  registry; ordered change cursors; conflict/dead-letter handling; device provenance;
  snapshot-plus-later-changes bootstrap; disconnect/retry/concurrency testing.
- **Explicit non-scope:** Mobile sync implementation, backup file storage, silent
  last-write-wins, and rewriting domain business rules.
- **Coverage:** PRD offline synchronization and new-device data bootstrap.
- **Known risks/migrations:** Generic events may use `update` while processed operations
  retain business actions such as `restore`; sync must not assume they are equal.
- **Start condition:** S4-S18 mutation contracts are stable and sync protocol approved.
- **Closure intent:** Gap-free, duplicate-free, auditable server synchronization and
  consistent data bootstrap.

### S20 - Dashboard, Reports, Search, Documents, and Export

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Deliver authoritative user-facing read models and documents.
- **Distinct boundary:** Reports and documents consume stabilized ledgers and projections
  without becoming new accounting authority.
- **Hard dependencies:** S11-S19 authoritative transactional and synchronized data.
- **Soft dependencies:** S21 attachment and notification presentation.
- **Primary deliverables:** Dashboard; daily/monthly, profit, liquidity, Customer,
  Supplier, inventory, and account reports; known/unknown cost disclosure; global
  search/filtering; invoice/report PDF and export; OpenAPI/data-dictionary consolidation.
- **Explicit non-scope:** New ledger effects, notification persistence, attachment
  storage, and audit-engine replacement.
- **Coverage:** PRD dashboard, reporting, global search, PDF, and export requirements.
- **Known risks/migrations:** Reports must reconcile to authoritative movements and expose
  cost uncertainty; machine-readable documentation debt must be closed without reopening
  completed business behavior.
- **Start condition:** S11-S19 closed and report definitions approved.
- **Closure intent:** Deterministic reports and documents traceable to source records.

### S21 - Notifications, Attachments, and Audit Access

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Complete cross-domain operational support and history access.
- **Distinct boundary:** Notification state, secure file metadata, and audit visibility
  are cross-cutting capabilities with separate security and lifecycle requirements.
- **Hard dependencies:** S17-S20 stable domains and read-side links.
- **Soft dependencies:** S22 backup failure notifications.
- **Primary deliverables:** Notification causes, deduplication, read/unread state and
  resolution; secure attachment metadata/access; Customer/Product/Supplier/expense
  attachment integration; owner/admin audit views; tenant-safe record links.
- **Explicit non-scope:** Replacing central audit infrastructure, mobile file pickers,
  external object-store choice without approval, and report calculation.
- **Coverage:** PRD notifications, images/attachments, and audit access.
- **Known risks/migrations:** Files must not expose tenants or secrets; audit immutability
  remains database-enforced; S22 later integrates backup-failure causes.
- **Start condition:** S17-S20 closed with storage/security policy approved.
- **Closure intent:** Secure, deduplicated support capabilities over stable domains.

### S22 - Backup, Restore, and Recovery

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Establish an operational, tested recovery story for server and new-device
  restoration.
- **Distinct boundary:** Backup retention, encryption, restoration, and disaster recovery
  differ from online sync and consistent snapshot delivery.
- **Hard dependencies:** S19 sync/bootstrap and stable S21 schema/contracts.
- **Soft dependencies:** S18 SaaS administration and S21 notifications.
- **Primary deliverables:** Encrypted backup lifecycle; metadata and retention; restore
  authorization; integrity verification; new-environment and new-device recovery;
  recovery-point documentation; failure alerts; operational runbooks and drills.
- **Explicit non-scope:** Sync redesign, production credentials in the repository,
  unapproved cloud provider integration, and restoring uncommitted client data.
- **Coverage:** PRD backup, restore, recovery, and failed-backup notification needs.
- **Known risks/migrations:** Restore must preserve tenant isolation, migration checksums,
  audit history, and only committed server data.
- **Start condition:** S19-S21 closed and backup encryption/retention policy approved.
- **Closure intent:** Demonstrated, repeatable recovery with documented limits.

### S23 - Final Validation and Release Readiness

- **Status:** PROPOSED - NOT STARTED.
- **Purpose:** Execute the complete backend release gate.
- **Distinct boundary:** Cross-domain assurance cannot be proven by isolated Station
  tests alone.
- **Hard dependencies:** S7-S22 closed and reviewed.
- **Soft dependencies:** Deployment environment and release operations.
- **Primary deliverables:** Full static/build/test suites; real PostgreSQL RLS,
  transaction, locking, concurrency, migration, and role verification; accounting and
  sync scenarios; backup/restore drill; performance checks; secret and dependency audit;
  OpenAPI/data dictionary; deployment, monitoring, rollback, and support runbooks.
- **Explicit non-scope:** New product features or silent acceptance of skipped tests.
- **Coverage:** Historical final validation and PRD release-readiness requirements.
- **Known risks/migrations:** Production readiness cannot be inferred from static checks
  or partially skipped suites; the reference runtime test must be handled honestly.
- **Start condition:** Every prior Station is formally closed with findings resolved or
  accepted by the backend owner.
- **Closure intent:** Evidence-backed backend release decision and complete handoff.

## 12. Dependency Model and Sequence Proof

The hard-dependency graph is:

```text
S3/S4 -> S7
S3/S4 -> S8
S7 -> S9
S8 + S9 -> S10
S5 + S7 + S9 -> S11
S5 + S6 + S9 + supplier forward remediation -> S12
S10 + S12 -> S13
S4 + S5 + S10 + S11 -> S14
S10 + S14 -> S15
S9 + S10 -> S16
S11..S16 -> S17
S3 + S4 -> S18
stable S4..S18 mutations -> S19
S11..S19 -> S20
S17..S20 -> S21
S19 + stable schema/contracts -> S22
S7..S22 -> S23
```

S18 is an independent platform branch after S3/S4 but must close before generic sync and
release. S7 and S8 closed as independent foundations in dependency-correct order. The
remaining graph has no dependency cycle and places no consumer before its required
foundation.

## 13. Deferred and Future-Owned Work

| Deferred capability                      | Reason                                              | Future owner |
| ---------------------------------------- | --------------------------------------------------- | ------------ |
| Period controls                          | Required before posting                             | S9           |
| Money/owner ledger/opening balances      | Requires accounts and periods                       | S10          |
| Inventory/costing/opening stock          | Requires Products, settings, and periods            | S11          |
| Supplier invoices/payments               | Requires Supplier master and accounting foundations | S12-S13      |
| Sales/receivables/collections            | Requires inventory, money, and periods              | S14-S15      |
| Expenses                                 | Requires money/owner authority                      | S16          |
| Returns/corrections                      | Requires source workflows                           | S17          |
| Subscription/license/SaaS administration | Store-status enforcement is only partial            | S18          |
| Generic sync/business-data bootstrap     | Mutation contracts must stabilize                   | S19          |
| Reports/search/export/OpenAPI debt       | Requires authoritative domain data                  | S20          |
| Notifications/attachments/audit access   | Requires stable causes and permissions              | S21          |
| Backup/restore/recovery                  | Requires sync/bootstrap and stable schema           | S22          |
| Final release validation                 | Requires all capabilities                           | S23          |

The Station 3 sync observation remains owned by S19. Existing non-blocking
machine-readable Customer/OpenAPI documentation debt is assigned to S20 with final
enforcement at S23; this assignment does not reopen S4. No deferred capability is
orphaned.

## 14. Known Legacy and Forward-Migration Risks

| Risk                                | Current legacy state                                                         | Approved target                                       | Future owner        | Required before                  | Baseline rewrite |
| ----------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------- | -------------------------------- | ---------------- |
| Invoice close requires full receipt | PostgreSQL/SQLite validation couples closure to received quantities          | Invoice affects payable only                          | S12                 | First invoice posting            | No               |
| Goods receipt creates payable       | Receipt validation requires a matching `goods_receipt` supplier-ledger entry | Manual inventory and payable are independent          | S11-S12             | Receipt reuse or invoice posting | No               |
| Supplier ledger semantics           | Legacy payable origin centers on goods receipt                               | Invoice-originated payable and independent settlement | S12                 | Payable implementation           | No               |
| Purchase invoice period context     | Legacy shape lacks the required modern posting-period contract               | Period-controlled supplier posting                    | S12                 | Invoice posting                  | No               |
| Unknown inventory cost              | Numeric defaults can be mistaken for known zero                              | Explicit pending/unknown cost                         | S11                 | Costing/opening stock            | No               |
| PostgreSQL/SQLite compatibility     | Both references retain legacy receipt coupling                               | Versioned compatible contract                         | S11-S12; verify S19 | Sync exposure                    | No               |
| Restore event semantics             | Generic event may say `update` while processed action says `restore`         | Sync interprets both without assuming equality        | S19                 | Generic sync                     | No               |

These risks require forward migrations or explicit compatibility contracts. They do not
authorize editing or replaying the baseline or changing the read-only reference package.

## 15. Cross-Station Accounting, Security, Migration, and Offline Rules

- Backend-owner decisions, `AGENTS.md`, the PRD, applied migrations, and approved
  contracts remain above this roadmap.
- PostgreSQL remains the central authority. SQLite/mobile implementation remains outside
  this repository while shared compatibility is preserved.
- Persistent IDs use UUIDs; money uses bigint minor units; quantities use integer
  milli-units; PostgreSQL timestamps use UTC `timestamptz`.
- Tenant operations derive store, user, device, and request context from authenticated
  server state and set it transaction-locally on the same connection.
- Forced RLS remains fail closed. Runtime roles never gain owner, migrator, superuser, or
  `BYPASSRLS` authority.
- Feature actor authorization is derived independently from approved sources. Customer
  authorization semantics are not automatically inherited by future domains.
- Every mutation uses stable `operationId`, canonical request identity, exact replay,
  rejected replay, and atomic business/change/audit effects.
- Every posting Station owns period enforcement, atomic rollback, idempotency,
  immutability, and reversal/replacement from its first implementation.
- Supplier invoices affect payable only. They never create inventory, stock movements,
  goods receipts, locations, or partial-receipt workflows.
- Manual inventory is independent. An optional Supplier Invoice reference is traceability
  only and creates no reciprocal effect.
- `inventory_movements` is authoritative; `stock_balances` is a protected projection.
  Monetary balances are projections over authoritative movements.
- Unknown cost remains unknown. Supplier debt is payable, Customer debt is receivable,
  and neither is silently reclassified as expense or available cash.
- Existing central audit infrastructure is extended through access/reporting rather than
  recreated.
- Sync must not assume that a generic change-event action equals the lifecycle business
  action stored in `processed_operations`.
- Applied migrations and reference baselines are immutable. Changes use reviewed
  versioned forward migrations with ownership, RLS, rollback, and compatibility analysis.
- High-risk work requires applicable real PostgreSQL RLS, duplicate, rejection, rollback,
  concurrency, cross-tenant, and migration tests plus independent review.

## 16. Open Roadmap-Level Owner Decisions

No roadmap-level owner decision is open. Station 9 is closed; S10 is the next candidate and
remains not started.

Station-local product, accounting, licensing, storage, and operational-policy decisions
remain intentionally deferred to the relevant Station orientation. A deferred local
decision does not authorize an implementer to invent policy.

## 17. Roadmap Maintenance and Approval Rules

- Completed Stations S0-S9 remain historical records and are not renumbered or reopened
  without new concrete blocking evidence and backend-owner approval.
- Future Stations S9-S23 remain proposed until the backend owner approves each Station's
  orientation and contract boundary.
- Adding a Station to this document does not authorize implementation.
- Material roadmap changes require repository evidence, PRD coverage analysis,
  dependency review, independent review, and backend-owner approval.
- Detailed behavior belongs in approved Station/Task contracts, not in roadmap edits.
- A future contract may refine a Station within higher-authority rules but cannot silently
  override the PRD, `AGENTS.md`, applied migrations, or owner decisions.
- Closure requires implementation, repository verification, independent review where
  applicable, finding resolution or explicit acceptance, and backend-owner approval.
- Roadmap maintenance must preserve complete PRD ownership and reject duplicate or
  orphaned capabilities.

## 18. Current Position and Next Candidate Station

| Field                                 | Current position                                     |
| ------------------------------------- | ---------------------------------------------------- |
| Last fully closed Station             | S9 - Accounting Periods and Posting Controls         |
| Last closed implementation checkpoint | `85ab494ac9383e6e31cba266a5b0d3749dee7740`           |
| Safe completed capabilities           | S0-S9 boundaries documented above                    |
| First incomplete release dependency   | S10 - Money Posting, Opening Balances, and Owner Ledger |
| Next candidate                        | S10.5 reversal / replacement                           |
| S10 current status                    | IN PROGRESS - S10.1-S10.4 closed; S10.5 next         |

Do not start S10.5 from this document. S10.5 requires its own execution prompt and
explicit backend-owner approval before implementation.
