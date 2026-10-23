# Dokana Backend Execution Roadmap

## 1. Document Status and Governance

| Field                     | Value                                      |
| ------------------------- | ------------------------------------------ |
| Status                    | **APPROVED - ACTIVE EXECUTION ROADMAP**    |
| Repository                | `C:\Users\esmail\Desktop\Dokana`           |
| Review branch             | `main`                                     |
| S19.4 starting checkpoint | `139b408c6e2fc367d02604b6af30e3201fe8c65e` |
| Closed execution history  | Stations S0-S21; S22 awaiting re-review     |
| Current Station           | S22 remediation implemented; re-review required |

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

| Check                           | Verified state                             |
| ------------------------------- | ------------------------------------------ |
| Branch                          | `main`                                     |
| S19.4 starting HEAD             | `139b408c6e2fc367d02604b6af30e3201fe8c65e` |
| Starting `origin/main`          | `139b408c6e2fc367d02604b6af30e3201fe8c65e` |
| Ahead/behind                    | `0/0`                                      |
| Working tree at S19.4 start     | Clean                                      |
| Migrations                      | 33 applied, 0 pending                      |
| Migration checksum verification | Pass                                       |
| Reference SHA-256 verification  | 11 files checked, 0 mismatches             |
| Last fully closed Station       | S21                                        |
| Current task                    | S22 remediation awaiting independent re-review |

The approved reference package under
[`database/reference/backend_database_reference`](../../database/reference/backend_database_reference/)
remains read-only. Its all-in-one PostgreSQL schema is an initialization baseline, not
the future migration mechanism.

## 5. Completed Stations S0-S22

Completed Stations are immutable execution history. Remaining work may build on their
foundations but must not reopen or repeat them without new concrete blocking evidence.

| Station                                                 | Status | Delivered capability                                                                                                                                                                    | Historical coverage                                                | Evidence                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0 - Repository and Reference Assessment                | CLOSED | Repository, baseline, SQLite, mapping, and test-reference assessment                                                                                                                    | Historical repository/reference assessment                         | Project history and reference package                                                                                                                                                                                                                                 |
| S1 - PostgreSQL Runtime Validation                      | CLOSED | Real PostgreSQL baseline/runtime assessment and documented limitations                                                                                                                  | Historical PostgreSQL validation                                   | Reference runtime evidence and project history                                                                                                                                                                                                                        |
| S2 - NestJS Backend Infrastructure                      | CLOSED | Configuration, logging, health, database transaction context, and test infrastructure                                                                                                   | Historical NestJS infrastructure                                   | Git history and [README](../../README.md)                                                                                                                                                                                                                             |
| S3 - Authentication and Database Security Foundation    | CLOSED | Controlled migration ledger/runner, role boundaries, auth API, sessions/tokens, membership and device bootstrap, RLS/security tests                                                     | Historical migration foundation and much of identity/platform core | [Station 3 architecture](../station-3-architecture.md) and migrations `0001`-`0005`                                                                                                                                                                                   |
| S4 - Business Foundation and Customers                  | CLOSED | Store business-write gate plus Customer database, validation, read, write, lifecycle, privacy, and idempotency contracts                                                                | Customer portion of historical master data                         | Commits through `a6f567f` and Customer contracts                                                                                                                                                                                                                      |
| S5 - Product and Product Unit Catalog                   | CLOSED | Product/unit mapping, validation, reads, writes, lifecycle, privacy, replay, and rollback behavior                                                                                      | Product/unit portion of historical master data                     | [Station 5 closure](../product-unit-station5-closure-v1.md)                                                                                                                                                                                                           |
| S6 - Supplier Master Data Foundation                    | CLOSED | Supplier mapping, validation, reads, writes, lifecycle, privacy, replay, and rollback behavior                                                                                          | Supplier-master portion of historical master data                  | [Station 6 closure](../supplier-station6-closure-v1.md)                                                                                                                                                                                                               |
| S7 - Store Operational Settings Foundation              | CLOSED | Settings mapping, operational-time context, tenant-safe reads, initialization, and idempotent owner-authorized mutations                                                                | Operational settings portion of historical master data             | [S7 contract](../contracts/store-settings-operational-time-v1.md) and [S7.4 record](../settings-station7-safe-mutation-v1.md)                                                                                                                                         |
| S8 - Money Account Catalog Foundation                   | CLOSED | Money Account mapping, validation, tenant-safe reads/writes, lifecycle, idempotency, and one-active-Cash invariants                                                                     | Money Account portion of historical master data                    | [S8.2 record](../money-account-station8-physical-foundation-v1.md), [S8.3 record](../money-account-station8-read-v1.md), and [S8.4 record](../money-account-station8-lifecycle-v1.md)                                                                                 |
| S9 - Accounting Periods and Posting Controls            | CLOSED | Monthly period mapping/identity, boundaries, non-overlap, tenant-safe reads, on-demand provisioning, terminal owner close, idempotency, and posting-context/close-vs-post control       | Accounting-period portion historically deferred with corrections   | [S9.1 contract](../contracts/accounting-period-v1.md), [S9.2 record](../accounting-period-station9-physical-foundation-v1.md), [S9.3 record](../accounting-period-station9-read-v1.md), and [S9.4 record](../accounting-period-station9-provisioning-lifecycle-v1.md) |
| S10 - Money Posting, Opening Balances, and Owner Ledger | CLOSED | Authoritative money movements and balances, owner ledger, internal transfers, opening balances, and same-domain corrections                                                             | Historical money and owner-ledger foundation                       | [Money Posting Contract v1](../contracts/money-posting-v1.md), current implementation, and migration `0006`                                                                                                                                                           |
| S11 - Manual Inventory, Stock Projection, and Costing   | CLOSED | Independent manual inventory posting, protected stock projection, costing, stock counts, and correction workflows                                                                       | Historical manual inventory and costing foundation                 | Current inventory implementation, tests, and migrations `0007`-`0008`                                                                                                                                                                                                 |
| S12 - Supplier Invoices and Payables                    | CLOSED | Supplier financial reads, opening payables, payable-only invoice posting, immutable edit/cancel correction chains, and zero automatic inventory or money effects                        | Historical supplier-invoice and payable recognition                | Current Supplier financial implementation, tests, and migrations `0009`-`0010`                                                                                                                                                                                        |
| S13 - Supplier Payments and Allocations                 | CLOSED | Explicit Invoice/Opening Payable allocations, Money Account or owner funding, settlement reads, and immutable payment cancellation/replacement chains                                   | Historical supplier settlement                                     | Current Supplier Payment implementation, tests, and migration `0011`                                                                                                                                                                                                  |
| S14 - Sales Posting and Customer Receivables            | CLOSED | Paid, partial, credit, split-tender, tracked/untracked and manual-line Sale posting; Customer Opening Receivables; tenant-safe reads; immutable Sale cancellation/replacement chains    | Historical sales posting and receivable origination                | Current Sales implementation, tests, and migrations `0012`-`0013`                                                                                                                                                                                                     |
| S15 - Customer Collections, Credits, and Settlement     | CLOSED | Customer collections, Sale/Opening allocation, overpayment/advance Credit, refunds, non-cash settlement, Sale Credit tender, and immutable active-leaf correction chains                | Historical customer collection, credit, and settlement authority   | Current Customer financial implementation, tests, and migrations `0014`-`0015`                                                                                                                                                                                        |
| S16 - Expenses and Expense Payments                     | CLOSED | Expense Category lifecycle; DUE, immediate Money-paid, and Owner-funded recognition; later settlement; derived outstanding; immutable Expense/Payment corrections and operational reads | Historical expense recognition and settlement authority            | Current Expense implementation, tests, and S9/S10 posting authorities                                                                                                                                                                                                 |
| S17 - Returns and Cross-Domain Corrections              | CLOSED | Customer Sale Returns, Supplier financial Returns, settlement/inventory orchestration, tenant-safe reads, replay, dependency protection, and immutable correction chains                | Historical returns and cross-domain correction orchestration       | Current Return implementation and S17.1-S17.7 verification                                                                                                                                                                                                            |
| S18 - Subscription, Offline Licensing, and SaaS Admin   | CLOSED | Platform Admin, Store and Subscription lifecycle, central online entitlement, signed Offline Licenses, revocation, immutable admin audit, and the S19 entitlement handoff               | Historical subscriptions, licenses, and SaaS administration        | Current S18 implementation, migrations `0016`-`0021`, and S18.3-S18.7 verification                                                                                                                                                                                    |
| S19 - Offline Sync and Consistent Data Bootstrap        | CLOSED | SQLite parity handoff, consistent bootstrap, canonical offline push, commit-ordered pull, conflict/quarantine/recovery, accounting equivalence, and integrated convergence verification | Historical synchronization engine and data bootstrap               | Current S19 implementation, migrations `0022`-`0028`, and S19.3-S19.9 verification                                                                                                                                                                                    |
| S20 - Dashboard, Reports, Search, Documents, and Export | CLOSED | Authoritative dashboard, operational/accounting reports, Store search, canonical PDFs, OpenAPI, and data-dictionary coverage                                                            | Historical reports, search, documents, export, and API documentation | Current S20 implementation and S20.1-S20.6 verification                                                                                                                                                                                                               |
| S21 - Notifications, Attachments, and Audit Access      | CLOSED | Owner-focused actionable notifications, privacy-safe business audit, and secure private attachments with integrated cross-domain verification                                           | Historical notification, attachment, and Store audit access        | Current S21 implementation, migrations `0029`-`0032`, and S21.1-S21.5 verification                                                                                                                                                                                    |

The safe completed boundary includes generic synchronization, read-side reporting, and
owner support capabilities through S21. It does not include backup/restore operations or
release readiness.

## 6. Historical Roadmap Reconciliation

| Historical area                         | Current classification  | Already satisfied by                                                    | Remaining work                                       | Proposed future owner |
| --------------------------------------- | ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| Repository/reference assessment         | DONE                    | S0                                                                      | None                                                 | None                  |
| PostgreSQL runtime validation           | DONE                    | S1                                                                      | Final release revalidation                           | S23                   |
| NestJS infrastructure                   | DONE                    | S2                                                                      | Domain-specific extensions                           | Respective Stations   |
| Drizzle schema and migration foundation | PARTIAL, ABSORBED       | S3-S18                                                                  | Incremental domain mappings and versioned migrations | Respective Stations   |
| Identity/platform core                  | SPLIT, COMPLETE         | S3-S4 and S18                                                           | None                                                 | None                  |
| Subscriptions/licenses                  | DONE                    | S18                                                                     | None                                                 | None                  |
| Master data                             | SPLIT, COMPLETE         | Customers S4, Products S5, Suppliers S6, Settings S7, Money Accounts S8 | None                                                 | None                  |
| Sales/receivables                       | SPLIT, COMPLETE         | Sale/receivable origination S14; collections and settlement S15         | None                                                 | None                  |
| Supplier invoices/payables              | SPLIT, COMPLETE         | Supplier invoice/payable recognition S12; settlement S13                | None                                                 | None                  |
| Manual inventory/costing                | DONE                    | S11                                                                     | None                                                 | None                  |
| Expenses/owner ledger                   | SPLIT, COMPLETE         | Money and owner-ledger foundation S10; Expenses S16                     | None                                                 | None                  |
| Returns/corrections/periods             | SPLIT, COMPLETE         | Period controls S9, same-domain corrections S10-S16, Returns S17        | None                                                 | None                  |
| Sync engine                             | PARTIAL, STILL REQUIRED | UUID/replay foundations, consistent bootstrap, commit-ordered feed base | Push, incremental pull, conflicts, recovery          | S19                   |
| Backup/bootstrap/restore                | SPLIT, STILL REQUIRED   | Auth/device and consistent business-data bootstrap                      | Backup and recovery                                  | S22                   |
| Reports/audit/admin                     | PARTIAL, SPLIT          | Central audit infrastructure and SaaS administration S18                | Reports, audit access, notifications                 | S20-S21               |
| Final validation                        | STILL REQUIRED          | Per-Station verification                                                | Cross-domain release gate                            | S23                   |

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
- Accounting periods, authoritative money movements and balances, owner ledger,
  internal transfers, and same-domain money corrections.
- Independent manual inventory movements, stock projections, costing, counts, and
  same-domain inventory corrections.
- Supplier financial reads, opening payables, payable-only invoice posting, and
  immutable invoice/opening-payable edit and cancellation chains.
- Supplier Payment posting with explicit Invoice/Opening Payable allocations,
  Money Account or owner funding, active-allocation correction guards, tenant-safe reads,
  and immutable cancellation/replacement chains.
- Sale posting for paid, partial, credit, split-tender, inventory-tracked, untracked, and
  manual-line Sales; Customer Opening Receivables; tenant-safe Sale/Receivable reads; and
  immutable active-leaf Sale cancellation/replacement chains.
- Expense Category lifecycle; DUE, immediate Money-paid, and Owner-funded Expense
  recognition; partial/full/repeated later settlement; authoritative derived outstanding;
  and immutable Expense/Payment active-leaf correction chains.
- Customer Sale Returns with a 48 actual-hour window, historical value/cost authority,
  Receivable-first settlement, Credit restoration, explicit residual settlement,
  Inventory dispositions, tenant-safe reads, and immutable corrections.
- Supplier financial Returns with no global deadline, Payable-first settlement, distinct
  Supplier Credit, explicit Credit Applications, actual Refunds, no automatic Inventory
  effect, tenant-safe reads, and immutable corrections.
- Domain mutation foundations using stable UUIDs, `operationId`, canonical request
  hashes, exact/rejected replay, versions, processed operations, audit effects, and
  change events.
- Authenticated, dependency-ordered consistent initial bootstrap under one read-only
  `REPEATABLE READ` snapshot, with signed-License validation, bounded pages, integrity
  metadata, restart semantics, and a safe base watermark captured in the same boundary.
- Store-scoped commit-ordered, versioned, sanitized change capture and narrow
  least-privilege read functions, implemented as the prerequisite foundation for S19.6.

### Partially implemented

- Audit infrastructure exists, but product-facing and administrative audit access does
  not.
- Generic offline-operation push, incremental pull APIs, conflicts, quarantine, and
  recovery are not implemented; S19.4 implemented bootstrap and the commit-order feed
  foundation only.
- Drizzle maps current implemented domains, not every future baseline table.

### Still required

Generic synchronization beyond bootstrap, reports, notifications, attachments,
backup/restore, and final release validation.

## 8. Remaining PRD Coverage and Completeness Map

| PRD capability                                     | Current state                        | Execution owner              |
| -------------------------------------------------- | ------------------------------------ | ---------------------------- |
| Authentication/session/device foundation           | Implemented                          | S3; platform extensions S18  |
| Tenant isolation/business-write authorization      | Implemented                          | Reused by every domain       |
| Customer master data                               | Implemented                          | S4; attachment support S21   |
| Product and Product Unit catalog                   | Implemented                          | S5; attachment support S21   |
| Supplier master data                               | Implemented                          | S6; settlement workflows S13 |
| Store operational settings                         | Implemented                          | S7 (closed)                  |
| Money Account catalog                              | Implemented                          | S8 (closed)                  |
| Accounting periods/posting controls                | Implemented                          | S9 (closed)                  |
| Money movements/transfers/balances/owner ledger    | Implemented                          | S10 (closed)                 |
| Manual inventory/stock projection/costing          | Implemented                          | S11 (closed)                 |
| Supplier invoices/payables                         | Implemented                          | S12 (closed)                 |
| Supplier payments/allocations/credits              | Implemented                          | S13 (closed)                 |
| Sales and customer receivable origination          | Implemented                          | S14 (closed)                 |
| Customer collections/credit/settlement             | Implemented                          | S15 (closed)                 |
| Expenses and expense payments                      | Implemented                          | S16 (closed)                 |
| Returns/reversals/corrections                      | Implemented                          | S17 (closed)                 |
| Subscription/offline licensing/SaaS administration | Implemented                          | S18 (closed)                 |
| Generic sync and consistent data bootstrap         | Bootstrap implemented; sync partial  | S19                          |
| Dashboard/reports/search/documents/export          | Implemented                          | S20 (closed)                 |
| Notifications/attachments/audit access             | Implemented                          | S21 (closed)                 |
| Backup/restore/recovery                            | Implemented                          | S22 (closed)                 |
| Final security/recovery/release validation         | Still required                       | S23                          |
| Automatic or partial invoice goods receipt         | Superseded by approved design        | No future owner              |
| Flutter/Drift/SQLite mobile implementation         | Outside backend scope                | Mobile project               |

If S18-S23 are completed against their approved future contracts, every material backend
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

- **Status:** CLOSED. S10.1 CLOSED; S10.2 CLOSED (Money Movement Authority);
  S10.3 CLOSED (Opening Balance and Owner Ledger); S10.4 CLOSED (Internal Transfers);
  S10.5 CLOSED (Same-Domain Reversal / Replacement).
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

- **Status:** CLOSED; S11.1-S11.6 CLOSED.
- **Purpose:** Establish independent inventory and cost authority before sales.
- **Distinct boundary:** Inventory is movement-driven and independent from supplier
  invoice/payable posting.
- **Hard dependencies:** S5 Product/Unit, S7 settings, and S9 periods.
- **Soft dependencies:** None; supplier-invoice linkage is excluded from S11.
- **Primary deliverables:** Manual inventory documents; authoritative inventory
  movements; protected stock projections; opening stock; counts and adjustments;
  locking/concurrency; negative-stock policy; weighted-average and pending/unknown cost.
- **Explicit non-scope:** Supplier invoice posting, automatic goods receipt, payables,
  sales, and COGS posting.
- **Coverage:** PRD manual inventory, stock, counts, adjustments, and costing.
- **Known risks/migrations:** Do not reuse legacy goods-receipt payable coupling. Unknown
  cost must not become known zero. No supplier-invoice linkage is implemented in S11.
- Deferred DB capability: Stock Counts that established inventory from MISSING cannot be historically reversed/replaced in the current MVP; correct current state with a new Stock Count and revisit projection retraction only if later development/release review requires it.
- **Start condition:** S5, S7, and S9 closed; inventory contract and any forward
  migration independently reviewed.
- **Closure intent:** Tested stock/cost authority ready for inventory-enabled sales.

### S12 - Supplier Invoices and Payables

- **Status:** CLOSED. S12.1-S12.4 CLOSED.
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
- **Known risks/migrations:** Migration `0009` decouples payable recognition from Goods
  Receipt and adds period-controlled Supplier payable facts; `0010` permits the approved
  optional Product/ProductUnit pair. The immutable references retain legacy coupling for
  future S19 compatibility review.
- Deferred capability: Supplier Invoice items retain optional Product/ProductUnit linkage for future explicit Goods Receipt/inventory integration; invoice posting itself remains financially independent from inventory.
- **Start condition:** S9 closed and the legacy-remediation migration is approved before
  first invoice posting.
- **Closure intent:** Auditable invoice-originated payables with zero automatic inventory
  effects.

### S13 - Supplier Payments and Allocations

- **Status:** CLOSED; S13.1-S13.5 CLOSED.
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
- **Known risks/migrations:** Migration `0011` adds the XOR physical allocation target for
  either a Purchase Invoice or an active original Opening Supplier Payable. Payment must
  reduce payable and money exactly once and must not alter inventory or recognize expense
  again. S13.3 completed explicit, replay-safe payment posting; S13.4 added tenant-safe
  payment history/detail reads and ledger/allocation-derived settlement state; S13.5 added
  immutable whole-payment cancellation/replacement with active-leaf concurrency control.
- **Deferred capability:** Supplier Credit / Advance. Future owner-authorized overpayment
  or payment in advance may let the Store hold positive credit with a Supplier and later
  apply it to Supplier Invoices. Current S13 rejects over-allocation and does not support
  unallocated advances; Supplier Credit must be an explicit financial authority, not a
  negative Supplier Payable.
- **Start condition:** S10 and S12 closed with payment/allocation policy approved.
- **Closure intent:** Least-privileged, replay-safe supplier settlement.

### S14 - Sales Posting and Customer Receivables

- **Status:** CLOSED; S14.1-S14.5 CLOSED.
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
  stock/payment/receivable effects must commit together. Migration `0012` makes the
  existing Sale validator require the exact linked S11 inventory decrement for tracked
  Products and forbid Sale inventory movements for untracked Products and manual lines.
  Current MVP Sale total must be positive; explicit zero remains distinct from missing
  input. Archived Customers, Products, and Product Units remain historically readable but
  cannot participate in applicable new S14 writes. S14.3 implements owner-authorized,
  replay-safe fully paid, partial, credit, and split-tender Sale posting; Customer Opening
  Receivable remains an independent immutable ledger fact rather than a fake Sale. S14.4
  adds tenant-safe Sale list/detail and Customer Receivable reads, exact ledger-derived
  outstanding amounts, deterministic keyset pagination, archived-history readability,
  and zero read-side business effects. S14.5 adds owner-authorized immutable active-leaf
  Sale cancellation and replacement, exact Money/Receivable/Inventory/COGS reversals,
  post-reversal replacement validation, deterministic replay, rollback, and concurrency
  protection. Migration `0013` preserves normal archived-catalog write rejection while
  allowing only a physically exact linked reversal of a committed historical inventory
  movement to use an archived Product or Product Unit. It does not add Supplier receipt
  behavior, and optional Supplier Invoice Product/Product Unit traceability remains intact.
- **Start condition:** S10-S11 closed and sales posting contract independently reviewed.
- **Closure intent:** Correct, tenant-safe, offline-compatible sale posting.

### S15 - Customer Collections, Credits, and Settlement

- **Status:** CLOSED; S15.1-S15.5 and S15.4A are closed.
- **Delivered:** Customer collections, Credit, settlement, Sale Credit tender, and
  immutable active-leaf corrections.
- **DB:** 15 applied / 0 pending; no DB change in S15.5.

### S16 - Expenses and Expense Payments

- **Status:** CLOSED; S16.1-S16.5 are closed.
- **Purpose:** Recognize paid and due expenses once and settle liabilities correctly.
- **Distinct boundary:** Expense recognition has separate accounting semantics from
  owner capital and supplier payable workflows.
- **Hard dependencies:** S9 periods and S10 money/owner authority.
- **Soft dependencies:** S7 defaults and S21 attachments.
- **Physical readiness:** Existing PostgreSQL tables represent categories, Expense
  recognition, one-Expense-to-many-Payments, Money Account/owner funding, and derived
  outstanding. One Payment belongs to one Expense. No S16 database blocker was found.
- **Authority boundary:** `expenses.amount_minor` is the recognition amount; posted
  `expense_payments` are settlement facts; outstanding is derived from posted Payments.
  `expenses.paid_total_minor` is not authoritative for later settlement and its SQLite
  projection behavior requires S19 compatibility review.
- **Explicit non-scope:** Owner-ledger foundation, supplier invoice posting, automatic
  recurrence scheduling, attachment storage, and mobile/SQLite implementation.
- **Coverage:** PRD expense recognition and payment requirements.
- **Known risks:** Paying a due Expense must not recognize Expense twice; owner-funded
  payment creates an Owner claim and no fake Money Movement; recurrence policy beyond
  manual entry is not inferred from the current schema.
- **Start condition:** S9-S10 closed and expense lifecycle approved.
- **Delivered:** Expense Categories; DUE, immediate Money-paid, and Owner-funded
  recognition; partial/full/repeated Money or Owner settlement; authoritative derived
  outstanding; exact bigint; idempotency, concurrency, RLS, read-only enforcement,
  atomic rollback, operational reads, and immutable active-leaf Expense/Payment
  corrections through S9/S10 authorities.
- **Approved limitations:** Split or mixed funding and one Payment spanning multiple
  Expenses are not approved. SQLite parity remains deferred to S19.
- **DB:** 15 applied / 0 pending; S16 DB delta 0.
- **Closure:** Single-recognition Expense accounting and settlement verified end to end.

### S16.1 - Expense Orientation and Execution Decomposition

- **Status:** CLOSED.
- **Purpose:** Verify physical readiness and freeze dependency-correct execution stages.
- **Deliverables:** PostgreSQL/SQLite/Drizzle/application assessment; accounting boundary;
  database-blocker decision; S16.2-S16.5 plan.
- **Non-scope:** Business logic, API, tests, migrations, and database writes.
- **DB:** Zero delta; 15 applied / 0 pending.
- **Verification:** Repository/roadmap authority, migration checksums, live catalog, RLS,
  S9 posting context, and S10 Money/Owner interfaces inspected.
- **Exit:** Roadmap-only plan committed and S16.2 identified.

### S16.2 - Expense Categories and Recognition Foundation

- **Status:** CLOSED.
- **Purpose:** Add the mapped catalog and single-recognition paid/due Expense authority.
- **Deliverables:** Drizzle mappings; Category lifecycle/reads; paid-now and due-later
  Expense posting; bigint/server-derived accounting; S9 context; immediate Money or
  owner-funded effects; core Expense reads and derived outstanding contract.
- **Non-scope:** Later due-Expense Payments, corrections, attachment storage, automatic
  recurrence, reporting, and SQLite implementation.
- **DB:** 15 applied / 0 pending; S16.2 DB delta 0.
- **Verification:** Focused mapping/category/recognition tests plus real PostgreSQL RLS,
  period, replay, rollback, and paid-now atomicity scenarios.
- **Delivered:** Expense Category lifecycle and reads; DUE, immediate single-Money-Account,
  and Owner-funded recognition; exact bigint, idempotency, atomicity, S9/S10 effects,
  Drizzle/application foundation, and core operational reads.
- **Deferred:** Partial/later Expense settlement to S16.3; immutable Expense/Payment
  corrections to S16.4; SQLite parity to S19.
- **Exit:** Categories and Expense recognition completed without duplicate Expense effects.

### S16.3 - Due Expense Payments and Outstanding

- **Status:** CLOSED.
- **Purpose:** Settle recognized due Expenses without recognizing Expense again.
- **Delivered:** One-source-per-Payment Money Account or owner funding; partial/full and
  repeated settlement; authoritative locked outstanding; exact S9 payment posting and S10
  Money/Owner effects; overpayment protection; idempotency, concurrency, atomic rollback,
  Payment reads, historical master-data reads, and S16.4 correction lineage.
- **Non-scope:** Bulk one-Payment-to-many-Expenses allocation, corrections, Supplier
  Payables, split/mixed funding, reporting, and recurrence scheduling.
- **DB:** 15 applied / 0 pending; S16.3 DB delta 0; one Payment remains physically bound
  to one Expense.
- **Verification:** Focused real PostgreSQL partial/full, overpayment rejection, Money,
  Owner, replay, rollback, locking, RLS, read-only, and cross-tenant tests.
- **Deferred:** Immutable Expense/Payment corrections to S16.4; final broad S16
  verification to S16.5; SQLite parity to S19.
- **Exit:** Later settlement changes only liability/outstanding and Money/Owner authority.

### S16.4 - Immutable Expense and Payment Corrections

- **Status:** CLOSED.
- **Purpose:** Correct posted Expense and Payment operations without destructive editing.
- **Delivered:** Immutable Expense and later-Payment cancel/replacement; DUE, MONEY_PAID,
  and OWNER_FUNDED correction; exact historical Money/Owner reversal; active-leaf
  lineage and reason; current-period correction; active dependent-Payment protection;
  historical Category/Money Account reversal safety; current replacement eligibility;
  idempotency, concurrency, atomic rollback, and correction reads/history.
- **Non-scope:** Cross-domain returns, S17 orchestration, destructive edits, and closed-
  period rewrites.
- **DB:** 15 applied / 0 pending; S16.4 DB delta 0.
- **Verification:** Focused PostgreSQL reversal, replacement, dependency, duplicate,
  rollback, archive-history, period, concurrency, RLS, and lineage tests.
- **Deferred:** Broad final S16 verification to S16.5; SQLite parity to S19.
- **Exit:** Original facts remain auditable and every active effect reverses exactly once.

### S16.5 - Final Expense Verification and Closure

- **Status:** CLOSED.
- **Purpose:** Prove S16 completeness and close the Station without adding capability.
- **Deliverables:** Cross-stage accounting/security audit, focused regression, final
  repository gates, Roadmap closure, and S17 handoff.
- **Non-scope:** New Expense behavior, S17 implementation, reporting, sync, or files.
- **DB:** 15 applied / 0 pending; checksum verification passed; S16.5 DB delta 0.
- **Verification:** Focused S16 regression passed 71/71 tests across 5 suites; full unit
  passed 942/942 across 104 suites; broad PostgreSQL integration passed 692/692 across
  54 suites; no skipped tests. Typecheck, lint, build, role checks, reference integrity,
  residue, and idle-transaction gates passed.
- **Exit:** S16 closed after integrated recognition, settlement, correction, accounting,
  tenant-security, and repository verification; S17 is next and not started.

### S17 - Returns and Cross-Domain Corrections

- **Status:** CLOSED; S17.1-S17.7 CLOSED.
- **Purpose:** Append later Customer Sale Return and approved Supplier financial Return
  documents that atomically coordinate existing period, receivable/payable, Customer
  Credit, money, and inventory authorities without rewriting valid original postings,
  duplicating same-domain correction engines, or coupling Supplier finance to inventory.
- **Return boundary:** A correction says the original posting was wrong and remains owned
  by its S10-S16 source workflow. A Return records a later commercial event against a
  valid original document. Refund/Credit/Receivable settlement is the value consequence;
  stock changes only for an approved physical disposition and never follow from a refund
  alone.
- **Authority boundary:** S7/S9 own operational time and posting eligibility; S10 owns
  Money; S11 owns Inventory Movement and stock projection; S12/S13 own Supplier Payable
  and settlement; S14 owns Sale/Receivable; S15 owns Customer settlement/Credit; S16
  remains the sole Expense authority. S17 may orchestrate those authorities in one
  transaction but must not create parallel ledgers, balance projections, or corrections.
- **Initial physical readiness:** `ledger.sale_returns`, Return items/settlements, Supplier Return
  counterparts, generic immutable ledgers/movements, `sync.processed_operations`, forced
  RLS, audit, and change capture provide a partial foundation. Sale and Sale-line lineage,
  the two approved `saleable`/`damaged` dispositions, current-period posting, split
  settlement representation, and Supplier financial settlement representation exist.
  S17.2 now supplies exact Drizzle mappings and non-public Customer Return calculation and
  locking authority, S17.3 supplies the owner-authorized atomic posting composition
  across existing period, money, inventory, Sale, and Customer authorities, and S17.4
  supplies tenant-safe operational reads and immutable settlement trace. S17.5 supplies
  immutable active-leaf cancellation/replacement, exact cross-domain reversal, dependency
  safety, and correction lineage reads.
  PostgreSQL's Return validator does not by itself serialize returnable quantity/value or
  validate every cross-domain link; the application transaction remains authoritative.
  S17.2-S17.6 completed the required application work without a database delta.
- **Database decision:** No migration was required. S17.2 locks the
  trusted Customer/Sale/Sale-line and affected Product/Unit resources and calculates
  remaining returnable quantity/value server-side. S17.3 composes the Return, financial,
  inventory, audit/change, and operation effects atomically. A later owner
  decision requiring a new Return against archived Product/Unit state without restoration
  would need a separate physical review because migration `0013` permits archived catalog
  use only for an exact linked correction reversal.
- **Backend-owner Customer Return policy:** Ordinary eligibility is 48 actual hours from
  the original Sale occurrence, evaluated using server transaction time. Full, partial,
  line-level, registered-Customer, and anonymous Returns are supported against the active
  Sale leaf using its existing readable number and historical net value. Settlement
  reduces the Sale Receivable first, restores historically consumed Customer Credit next,
  then requires explicit Refund or Customer Credit for a registered Customer; anonymous
  residual value is Refund only. Refund uses one currently eligible Money Account.
  Tracked lines require explicit `RESTOCK_SALEABLE` or `DAMAGED_NO_RESTOCK`; historical
  cost controls any cost reversal. Cumulative Returns cannot exceed original quantity or
  value. Customer archive requires both Receivable and Customer Credit to be zero.
- **Backend-owner Supplier Return policy:** There is no fixed system-wide Return time
  limit. A Supplier financial Return links to its Supplier Invoice, reduces Payable first,
  and records excess as distinct Supplier Credit that may later be applied explicitly or
  refunded. A Supplier refund is a Money inflow, not Revenue. No automatic Supplier
  inventory Return is approved; future supplier inventory-return authority requires
  Purchase/Goods Receipt lineage and a separate approval.
- **Hard dependencies:** Closed S11-S16 transactional workflows and the frozen policies
  above.
- **Explicit non-scope:** Ordinary Sale, collection, Supplier Payment, Expense correction,
  or manual Inventory operations; Goods Receipt/Purchase Receipt; recursive cancellation
  of valid history; reports/export/OpenAPI; offline sync/SQLite implementation;
  attachments; subscription/licensing; backup/recovery; and Stock Count missing-state
  remediation.
- **Coverage:** PRD customer/supplier returns, linked correction documents, settlement,
  product-condition inventory effects, and open-period correction requirements.
- **Known risks:** A Sale Return must append facts rather than cancel the valid Sale or its
  later payments. Supplier Invoice remains payable-only; no Supplier Return inventory
  effect is approved merely from Invoice lineage. Return cancellation/replacement must
  not consume spent Customer Credit, invalidate later inventory facts, exceed refundable
  value, or bypass current-period and current-account eligibility.
- **Closure intent:** Auditable, replay-safe, tenant-isolated Return orchestration with
  exact dependency protection and no destructive historical mutation.

### S17.1 - Return Orientation, Ownership, and Physical Readiness

- **Status:** CLOSED.
- **Purpose/deliverable:** Froze the Return-versus-correction/refund boundaries, existing
  domain ownership, physical readiness, policy gate, and dependency-safe S17 stages.
- **DB and verification:** 15 applied / 0 pending with checksum verification passed;
  database, PostgreSQL reference, SQLite, code, test, Drizzle, and API deltas were zero.
- **Exit:** Physical verdict is partial application work with database delta 0 expected;
  no DB blocker exists, but S17.2 waits for the recorded owner policy decisions.

### S17.2 - Sale Return Contract, Mapping, and Internal Authority

- **Status:** CLOSED.
- **Purpose:** Freeze the approved Customer Sale Return command/read contract, map the
  existing Return tables, and build non-public server-calculated returnable
  quantity/value authority.
- **Dependencies/owners reused:** S9 posting context, S14 Sale/Receivable lineage, S15
  Customer state/Credit semantics, and the S17 policy gate.
- **Delivered:** Owner policy freeze; exact Drizzle mappings for the six existing Return
  tables; canonical command validation/hash identity; active Sale and Sale-line authority;
  server-time 48-hour eligibility; full/partial cumulative quantity, historical value,
  historical cost, and disposition calculation; Customer settlement waterfall; canonical
  Customer-before-Sale and Sale-line lock preparation; and transaction-aware internal
  repository primitives. No incomplete public posting route was exposed.
- **Non-scope/DB:** No settlement payout, stock effect, public Return workflow, Supplier
  Return, migration, or SQLite change; expected database delta 0.
- **Verification:** Focused unit coverage proves the policy calculations and canonical
  identity; focused real-PostgreSQL coverage proves exact mapping, tenant/Sale/line
  linkage, prior active quantities, lock serialization, archive guard, and forced-RLS
  fail-closed behavior. DB: 15 applied / 0 pending; S17.2 database delta 0.
- **Exit:** Internal authority is ready for S17.3 atomic posting composition. Public
  posting, idempotency claim persistence, financial/Inventory effects, reads, and Return
  corrections remain in their planned stages.

### S17.3 - Atomic Customer Sale Return Posting

- **Status:** CLOSED.
- **Purpose:** Expose Customer Sale Return posting only when every approved financial,
  Money, Inventory, and historical-cost consequence can commit atomically.
- **Dependencies/owners reused:** S17.2 plus S9, S10, S11, S14, and S15 transaction-aware
  authorities.
- **Delivered:** Owner-authorized posting API, Receivable/Credit/refund settlement,
  tracked saleable/damaged and untracked/manual inventory behavior, historical cost
  treatment, audit/change facts, and applied/rejected replay.
- **Non-scope/DB:** No ordinary source-domain posting, Supplier Return, correction of a
  posted Return, SQLite, or expected migration.
- **Verification:** Item and settlement totals equal the Return, active returned
  quantity/value never exceeds the original under concurrency, no current-cost
  recomputation, no stock from refund or untracked/manual lines, S9 period/account rules,
  atomic rollback, RLS/cross-tenant isolation, and exact duplicate behavior. Focused unit
  and isolated real-PostgreSQL happy, rejection, rollback, replay, and cross-domain race
  tests passed with database delta 0.
- **Exit:** Atomic Customer Sale Return posting is complete. Tenant-safe Return reads and
  settlement trace remain owned by S17.4; Return correction remains owned by S17.5.

### S17.4 - Tenant-Safe Return Reads and Settlement Trace

- **Status:** CLOSED.
- **Purpose:** Read Return history and its original Sale, line, settlement, inventory, and
  cost trace without exposing internal or foreign-tenant state.
- **Dependencies/owners reused:** S17.3 facts and existing S14/S15 read authorities.
- **Delivered:** Owner-authorized Return list/detail and per-Sale history APIs; current
  remaining-returnable Sale state; deterministic scope-bound keyset pagination; lossless
  bigint, milli-unit, and UTC values; immutable original-Sale, line, settlement, Money,
  inventory, and historical-cost trace; archived historical display joins; distinct
  Receivable reduction, restored original Credit, new Credit, and Money refund effects;
  lifecycle state; malformed-input rejection; and generic not-found privacy.
- **Non-scope/DB:** No write, reporting/export, global search, or expected DB change.
- **Verification:** Focused unit coverage passed 6/6 and isolated real-PostgreSQL coverage
  passed 8/8 with no skips. Targeted S17.3 regression coverage passed 4/4 selected tests.
  Tests prove root-stable pagination, cursor scope, immutable settlement/inventory/cost
  trace, anonymous and registered-Customer cases, current eligibility, archived display,
  read-only Store access, zero read-side effects, owner authorization, forced-RLS and
  cross-tenant fail-closed behavior, exact numeric representations, and transaction/test
  cleanup. Typecheck, lint, build, migration status/checksums, runtime DB safety, reference
  integrity, residue, and idle-transaction gates passed. Database delta 0.
- **Exit:** Operational Customer Sale Return reads and settlement trace are complete.
  Immutable Return correction and dependency safety are delivered by S17.5.

### S17.5 - Immutable Return Corrections and Dependency Safety

- **Status:** CLOSED.
- **Purpose:** Cancel or replace the active Return leaf through linked compensating facts
  in the current eligible period without mutating original economic history.
- **Dependencies/owners reused:** S17.3 plus S10/S11/S14/S15 correction and reversal
  primitives.
- **Delivered:** Owner-authorized immutable Return cancel/replace APIs; active-leaf and
  linear predecessor/successor validation; exact Receivable, both Customer Credit sources,
  historical Money refund, Inventory quantity, and known/unknown/pending cost reversal;
  spent-Credit and later-stock dependency protection; current S9 correction posting over
  closed historical periods; archived historical refund-account reversal; current
  replacement eligibility; non-expansive replacement after 48-hour expiry; exact replay,
  rollback, audit/change capture, and correction lineage reads.
- **Non-scope/DB:** No recursive cascade cancellation, source Sale correction redesign,
  Supplier Return correction, or expected migration.
- **Verification:** Focused unit/shared regression passed 49/49. Isolated real-PostgreSQL
  correction coverage passed 20/20 with no skips, including the eight required race
  classes; targeted S17.3/S17.4 regression passed 10 selected tests. Typecheck, full lint,
  build, changed-file format, migration status/checksums, database role checks, reference
  integrity, RLS/read_only, residue, and idle-transaction gates passed. DB: 15 applied / 0
  pending; S17.5 database delta 0; PostgreSQL reference and SQLite deltas 0.
- **Exit:** Customer Sale Return correction and dependency safety are complete. S17.6 is
  next and not started; S17 remains open.

### S17.6 - Supplier Financial Returns

- **Status:** CLOSED.
- **Purpose:** Append an approved Supplier financial Return/credit against Supplier
  payable history without automatically creating or reversing inventory.
- **Dependencies/owners reused:** S12 Invoice/Payable, S13 settlement, S9 period, S10 Money,
  and the approved Supplier Return/Credit policy.
- **Delivered:** Supplier Financial Return with no global Return time limit and exact
  Supplier Invoice linkage; payable-first settlement without negative payable; distinct
  Supplier Credit creation, application, available-balance reads, and actual Supplier
  Refunds through S10 Money authority; no automatic Inventory, COGS, Revenue, or Expense
  effect; Supplier archive protection while payable or credit remains outstanding;
  immutable Return/Application/Refund cancel-or-replace corrections, active-leaf lineage,
  spent-Credit dependency safety, idempotent replay, serialized concurrency, and
  tenant-safe operational reads.
- **Non-scope/DB:** No Goods Receipt, automatic/partial receipt, automatic stock movement,
  implicit invoice-to-inventory lineage, PostgreSQL reference change, or SQLite change.
  SQLite parity remains deferred to S19.
- **Verification:** Focused unit passed 20/20 and isolated real-PostgreSQL S17.6 coverage
  passed 16/16 with no skips, including required concurrency, RLS, read-only, rollback,
  balance, and zero-inventory assertions. Targeted S9/S10/S12/S13 regression passed 79/79;
  the final invoice-correction lock-order change additionally passed its focused 10/10
  regression. Typecheck, lint, build, changed-file format, migration status/checksums,
  database role checks, reference integrity, residue, and idle-transaction gates passed.
  DB: 15 applied / 0 pending; S17.6 database delta 0.
- **Exit:** Supplier financial Returns and Supplier Credit lifecycle are complete. S17.7
  is next and not started; S17 remains open.

### S17.7 - Final Returns Verification and Closure

- **Status:** CLOSED.
- **Purpose:** Prove integrated Customer and approved Supplier Return behavior and close
  S17 without adding new capability.
- **Dependencies/owners reused:** Completed S17.2-S17.6 and all reused source authorities.
- **Delivered:** Cross-stage accounting/security and completeness audit; focused
  Customer/Supplier Return regression; final replay-conflict evidence for Supplier
  Credit Application, Refund, and correction families; full repository, database-role,
  migration, reference-integrity, residue, and idle-transaction gates; and Roadmap
  closure.
- **Non-scope/DB:** No new Return behavior, migration, future Station work, or SQLite
  implementation.
- **Verification:** The targeted S17 selection passed 23/23 executed tests across four
  suites, with 30 intentionally non-selected tests and zero failures. Full unit passed
  1,050/1,050 across 110 suites; broad real-PostgreSQL integration passed 756/756 across
  59 suites; neither full suite skipped tests. Existing executed S17.3, S17.5, and S17.6
  concurrency evidence remained valid and the broad suite re-executed the current race
  coverage. Typecheck, lint, build, changed-file format, diff, role/security, migration
  checksum, and 11/11 reference checks passed. DB: 15 applied / 0 pending; S17.7 database
  delta 0; PostgreSQL reference and SQLite deltas 0; SQLite parity remains deferred to
  S19.
- **Exit:** Integrated Customer and Supplier Return accounting, security, reads,
  idempotency, dependency safety, and corrections are verified. S17 is closed. S18 is
  next and not started.

### S18 - Subscription, Offline Licensing, and SaaS Administration

- **Status:** CLOSED; S18.1-S18.7 CLOSED.
- **Purpose:** Complete central subscription, signed offline license, and platform
  administration lifecycle.
- **Distinct boundary:** Platform administration uses server-only identity and licensing
  authority, separate from tenant accounting modules.
- **Hard dependencies:** S3 authentication/security and S4 store-status enforcement.
- **Soft dependencies:** Business Stations provide usage context but do not block the
  platform contract.
- **Primary deliverables:** Plans; subscriptions; activation, extension, expiry, and
  cancellation; signed local license issuance/verification contract; read-only expiry
  behavior; Store/device administration; admin audit.
- **Explicit non-scope:** Shop accounting, mobile UI, payment-gateway integration, and
  client-side license storage.
- **Coverage:** Historical subscriptions/licenses and PRD SaaS administration.
- **Known risks/migrations:** Runtime store-status enforcement is not proof of complete
  subscription lifecycle; signing keys and admin authority are high risk.
- **Start condition:** Platform contract, signing/key-management policy, and admin
  authorization are approved.
- **Closure intent:** Complete least-privileged platform lifecycle ready for offline sync
  and release.
- **S18.1 authoritative function:** S18 makes PostgreSQL the ultimate Store SaaS
  entitlement authority; adds least-privileged platform-administrator authorization,
  audited Store/owner provisioning and subscription lifecycle, online session/write
  enforcement, and bounded signed Store-and-device offline licenses based on trusted
  server time. It reuses S3 authentication/RLS, S4-S17 Store lifecycle and business-write
  controls, and the S8 deterministic Cash provisioner. It does not own shop accounting,
  payment-provider processing, mobile license storage, or business-data synchronization;
  S19 owns sync/bootstrap and consumes the approved entitlement handoff.
- **S18.1 physical-readiness finding:** The historical baseline at
  `database/reference/backend_database_reference/shop_ledger_postgresql_v1_all_in_one.sql`
  and the live database contain `platform.subscription_plans`,
  `platform.subscriptions`, `platform.license_issuances`, `platform.admin_actions`, Store
  and device identities, server-time fields, and forced tenant RLS on Subscription and
  License rows. At that checkpoint all 15 migrations were applied with zero pending and
  preserved those objects, and Drizzle did not yet map the S18 platform tables.
- **S18.1 database verdict (resolved by authorized forward migrations):** The initial
  physical foundation was insufficient because no durable platform-administrator
  authorization identity exists, and no least-privileged transaction-safe database path
  connects entitlement truth to authentication, business-write enforcement, cross-Store
  administration, or append-only administrative audit. Runtime and authentication roles
  correctly have no direct access to the platform subscription tables; broad grants or
  an administrative runtime connection remain prohibited substitutes. Authorized
  migrations 0016-0020 now provide the approved narrow foundation, S18.4 lifecycle
  authority, and S18.5 Store-administration authority without broad runtime grants.
- **Store/Subscription relationship:** Store lifecycle and Subscription lifecycle remain
  separate authorities. `active`, `read_only`, `suspended`, and `archived` Store states
  already drive authenticated access and business-write behavior; S18 must compose those
  states with server-derived entitlement without treating expiry, suspension, and archive
  as interchangeable or granting SaaS administration access to accounting data.
- **Offline License boundary:** S18 owns central entitlement, signed Store-and-device
  License issuance/verification semantics, trusted server-time evidence, key/version
  identity, and bounded validity. SQLite already has a local-license reference shape, but
  mobile persistence, clock-state handling, queued business operations, and synchronization
  execution remain outside this repository and are handed to S19/mobile implementation.
- **SaaS Admin boundary:** The PRD requires Store/owner, plan/subscription,
  device/license, activation/renewal/suspension, free-day, and administrative-action
  management. S18.3-S18.5 provide durable Platform Admin identity, controlled first-admin
  bootstrap, Store provisioning, and the approved online administration APIs through a
  dedicated least-privileged boundary that has no tenant accounting authority and cannot
  bypass tenant RLS globally.
- **S18.2 central policy:** Store lifecycle and Subscription are separate authorities.
  PostgreSQL is the ultimate commercial-entitlement authority. Effective business-write
  access requires both an operationally eligible Store and active Subscription entitlement;
  a stronger `read_only`, `suspended`, or `archived` Store restriction always wins.
  Subscription expiry does not rewrite Store status: an otherwise operational Store retains
  reads while new business writes are blocked. Central validity uses authoritative server
  time and the half-open interval `startsAt <= serverTime < endsAt`; there is no separate
  commercial grace period or retroactive entitlement fabrication.
- **S18.2 Subscription policy:** MVP exposes only the `ACTIVE`, effective `EXPIRED`, and
  `CANCELLED` commercial semantics and one approved active Dokana plan. The existing
  extensible plan schema remains. Payment-provider processing, feature tiers, quotas, and
  usage billing are deferred. Activation, extension, cancellation, and manual overrides
  preserve immutable/versioned provenance. Every material manual admin mutation requires
  an authenticated Platform Admin, non-empty reason, authoritative server timestamp,
  previous/new semantic values, and immutable audit.
- **S18.2 Offline License policy:** A License is a server-issued, asymmetric-signature
  snapshot, not Subscription authority. It is bound to the Store, registered device,
  entitlement identity/version, and signing-key version, but not to a Store user. Its
  validity is at most seven actual days and never beyond the known central entitlement end.
  Renewal is online and server-authorized; clients cannot self-renew or self-extend. Private
  signing material remains backend-only and outside PostgreSQL business data, SQLite,
  client bundles, and Git. Versioned rotation retains old public verification keys for
  legitimately unexpired licenses, prevents retired keys from new signing, and makes no
  false promise of instant revocation for a truly offline device.
- **S18.2 offline enforcement:** License expiry or suspicious/unresolved local clock
  rollback causes effective read-only operation until online revalidation; clock rollback
  cannot extend entitlement. Central suspension/revocation reaches an offline device at
  reconnect or License expiry. An operation validly created under a matching signed lease
  remains eligible for S19 validation after later central expiry, without guaranteeing
  posting success. An operation created after local License expiry is rejected or
  quarantined under S19's final recovery contract.
- **S18.2 administration and provisioning:** Platform Admin is durable authority distinct
  from Store roles and database administration. Its narrow powers are Store listing and
  provisioning; operational-status and entitlement inspection; entitlement activation,
  extension, cancellation, and approved override; Store suspension and restoration from
  `suspended` only through existing lifecycle authority; License inspection and central
  revocation/future-renewal denial; and administrative-history inspection. Subscription
  renewal cannot restore an `archived` Store. Platform Admin is never an accounting
  superuser and cannot bypass tenant accounting safeguards. Material mutations record the
  actor, action, targets, reason, previous/new semantic values, authoritative server time,
  and operation/correlation identity where supported. S18 owns atomic Store foundation
  provisioning, including initial Owner membership, required settings, and
  `SystemCashProvisioningService.ensureForStore()`. Store identity and Subscription identity
  remain separate; an active Store without valid entitlement cannot perform business writes.
- **S18.2 S19 handoff:** S18 owns central entitlement, Store consequences, signed License
  issuance/verification, binding, and SaaS administration. S19 owns the offline queue,
  bootstrap, push/pull, conflicts, reconciliation, and application of S18 evidence during
  sync. S18 hands off entitlement and Store state, License identity and binding,
  `issuedAt`, `offlineValidUntil`, key/version, trusted-time evidence, verification result,
  connected suspension knowledge, and queued-operation policy classification.
- **S18.3 physical foundation:** Durable DB-backed Platform Admin assignment is distinct
  from Store roles and exposes no broad `platform` or accounting privilege. Two narrow,
  non-PUBLIC `SECURITY DEFINER` functions resolve the current actor's Platform Admin state
  and lock the Store then current Subscription for server-time effective-entitlement
  decisions inside the protected transaction. Existing Subscription, License, and
  administrative-audit objects are mapped in Drizzle; administrative audit is immutable.
  Migration 0016 introduced the authorized foundation and migration 0017 corrected its
  demonstrated missing-Subscription NULL result to fail closed without altering 0016.
  PostgreSQL historical references and SQLite remain unchanged. S18.6 now provides the
  signed seven-day Offline License and exact S19 entitlement handoff. S18.5 provides a
  controlled deployment/operational bootstrap for the first Platform Admin without public
  registration, email inference, Store-role promotion, or a migration-seeded person.

### S18.1 - Orientation, Database Readiness, and Stage Decomposition

- **Status:** CLOSED.
- **Result:** Repository authorities, all 15 migrations, live PostgreSQL catalog,
  RLS/functions/triggers/roles, Drizzle mappings, the historical PostgreSQL baseline, and
  relevant SQLite License structures were reconciled read-only. Database delta: 0.
- **Exit:** S18 scope and stages are defined; policy and future database authorization
  remain explicit gates.

### S18.2 - Subscription, License, and Platform Authority Contract Freeze

- **Status:** CLOSED.
- **Result:** Subscription/Store separation, effective access, the minimal Subscription
  lifecycle, server-time boundary, no-grace policy, one-plan MVP, immutable history,
  Platform Admin powers/accounting firewall, Store provisioning, seven-day Store/device
  License, signing-key custody/rotation, trusted-time behavior, queued-operation treatment,
  and the S18/S19 handoff are frozen without implementation.
- **Database expectation:** 0.
- **Exit:** Policies are approved and testable. Database remains 15 applied / 0 pending;
  no migration is authorized. S18.3 remains blocked on explicit database authorization.

### S18.3 - Platform Physical and Least-Privilege Security Foundation

- **Status:** CLOSED.
- **Delivered:** Durable Platform Admin assignment authority, immutable administrative
  audit hardening, exact Drizzle mappings for the existing Subscription/License/Admin
  tables, a narrow current-actor authority function, and an atomic server-time entitlement
  function with canonical Store-then-Subscription locking.
- **Security:** Platform Admin remains distinct from Store Owner/Manager roles. Runtime and
  auth roles received no broad `platform` or accounting access; functions are
  `SECURITY DEFINER` with a pinned `search_path`, no PUBLIC execute, and only the approved
  narrow execute grants. Forced RLS and the tenant accounting firewall remain intact.
- **Database:** 17 applied / 0 pending. Migration 0016 added the authorized foundation;
  immutable corrective migration 0017 made missing Subscription eligibility explicitly
  false after a focused PostgreSQL test demonstrated the NULL defect. Applied migrations
  were not edited. PostgreSQL historical reference delta 0; SQLite delta 0.
- **Verification:** Focused Platform Admin, entitlement, exact-end-boundary, RLS, and real
  PostgreSQL concurrency coverage passed 15/15; focused auth/write/RLS regression passed
  50/50. Full unit passed 1,050/1,050 across 110 suites. After correcting a pre-existing
  calendar-sensitive S17 test fixture, broad PostgreSQL integration passed 771/771 across
  60 suites with no skips. Typecheck, lint, build, migration checksum, role, live catalog,
  residue, and idle-transaction gates passed.
- **Deferred:** S18.5 owns a controlled deployment/operational first-Platform-Admin
  bootstrap. S18.6 owns the seven-day signed Offline License. No real administrator was
  seeded and no public administration API was added.
- **Exit:** The approved physical and least-privilege foundation is complete. S18.4 is next
  and not started; S18 remains open.

### S18.4 - Central Entitlement and Store Provisioning

- **Status:** CLOSED.
- **Delivered:** One-plan MVP Subscription activation, extension, cancellation, expired
  reactivation, internal lifecycle/history reads, and atomic Store provisioning with the
  intended initial Owner, required Settings, and reused S8 System Cash authority.
- **Lifecycle:** PostgreSQL server time controls the half-open entitlement interval. There is
  no commercial grace, no Store-lifecycle rewrite, and no retroactive entitlement
  fabrication. Material changes preserve reason, actor, previous/current values, version,
  and immutable administrative history.
- **Safety:** Stable operation identity provides exact replay and conflicting-reuse
  rejection. Store and Subscription remain separate, provisioning is atomic, and real
  PostgreSQL rollback, duplicate, cross-Store, least-privilege, and concurrency behavior is
  verified.
- **Database:** 19 applied / 0 pending. Authorized migration 0018 added five narrow,
  runtime-executable `SECURITY DEFINER` functions; immutable corrective migration 0019
  replaced unsupported UUID aggregation with deterministic Owner selection. Applied
  migrations were not edited. PostgreSQL historical reference delta 0; SQLite delta 0.
- **Verification:** Focused S18.4 PostgreSQL coverage passed 11/11. Full unit passed
  1,060/1,060 across 112 suites; broad integration passed 782/782 across 61 suites with no
  skips. Typecheck, lint, build, changed-file formatting, migration checksum, role,
  residue, and idle-transaction gates passed.
- **Deferred:** Public Platform Admin APIs and online session/business-write entitlement
  integration remain S18.5. The signed seven-day Offline License remains S18.6.
- **Exit:** Central Subscription lifecycle and Store provisioning are complete. S18.5 is
  next and not started; S18 remains open. Database, PostgreSQL-reference, and SQLite deltas
  return to zero by default.

### S18.5 - Online Entitlement Enforcement and SaaS Administration

- **Status:** CLOSED.
- **Delivered:** Least-privileged Platform Admin APIs now expose bounded Store reads,
  atomic Store provisioning, Subscription activation/extension/cancellation/reactivation,
  Store suspension/restoration from `suspended`, and immutable administrative history.
  A controlled non-public operational script bootstraps only the first Platform Admin.
- **Entitlement:** Every online business-write path now uses the central transaction-local
  effective-entitlement lock. An active Store with an expired, cancelled, missing, or
  future Subscription retains permitted reads while writes fail closed. `read_only`,
  `suspended`, and `archived` Store restrictions remain stronger than Subscription state.
- **Security:** Durable Platform Admin authority, required reason, optimistic versioning,
  canonical idempotency, concurrency locking, forced RLS, and the accounting firewall are
  preserved. Store roles alone gain no Platform Admin capability and no administration
  endpoint can modify tenant accounting.
- **Offline-first boundary:** S18.5 governs only requests reaching the backend. It does not
  require continuous Internet access and does not implement Offline License, local clock,
  SQLite licensing, or S19 synchronization; those License concerns remain S18.6.
- **Database:** 20 applied / 0 pending. Authorized migration 0020 adds only three narrow,
  non-PUBLIC `SECURITY DEFINER` functions and one Platform Admin Store-read policy; it adds
  no table, column, broad runtime privilege, accounting access, PostgreSQL reference change,
  or SQLite change.
- **Verification:** Focused real-PostgreSQL S18.5 coverage passed 7/7. Full unit passed
  1,080/1,080 across 114 suites; broad integration passed 789/789 across 62 suites with no
  skips; the explicit security suite passed 15/15. Typecheck, lint, build, changed-file
  formatting, migration checksum, role connections, residue, and idle-transaction gates
  passed.
- **Exit:** Online entitlement enforcement and SaaS administration are complete. S18.6 is
  next and not started; S18 remains open. Database, PostgreSQL-reference, and SQLite deltas
  return to zero by default.

### S18.6 - Signed Offline License and S19 Handoff

- **Status:** CLOSED.
- **Delivered:** Dokana remains Offline-First and does not require continuous Internet.
  Successful central verification issues a deterministic, versioned Ed25519 License bound
  to the active Store, registered device, Subscription identity/version, and signing-key
  version. The backend-only private key is secret-configured; retained public keys support
  safe verification across rotation.
- **Entitlement:** Authoritative server timestamps cap each License at the earlier of seven
  actual days or the central Subscription end. Renewal always revalidates current Store,
  Subscription, and device state. The exclusive expiry boundary and clock-rollback contract
  require future clients to become read-only and revalidate online; a local clock cannot
  extend entitlement.
- **Revocation and S19:** Central revocation prevents future trust/renewal but cannot claim
  instant delivery to a disconnected device. The S19 handoff distinguishes validly licensed
  in-window operations, which remain entitlement-eligible after later License or Subscription
  expiry, from post-expiry, mismatched, unknown, invalid, or revoked evidence that must be
  rejected or quarantined. SQLite storage and business synchronization remain S19 scope.
- **Database:** 21 applied / 0 pending. Backend-owner-authorized migration 0021 adds only five
  narrow, non-PUBLIC `SECURITY DEFINER` functions over the existing License foundation. It
  preserves forced RLS, direct platform-table/sequence denial, runtime least privilege, and
  the Platform Admin accounting firewall. PostgreSQL reference and SQLite deltas are 0.
- **Verification:** Focused signature/time/handoff unit coverage passed 21/21; focused real
  PostgreSQL licensing coverage passed 8/8; targeted S18 regression passed 46/46; security
  passed 15/15. Full unit passed 1,102/1,102 across 118 suites and broad integration passed
  797/797 across 63 suites, with no skips. Typecheck, lint, build, changed-file formatting,
  migration checksum, role, residue, and idle-transaction gates passed.
- **Exit:** Signed Offline Licensing and the S19 entitlement handoff are complete. S18.7 is
  next and not started; S18 remains open. Database, PostgreSQL-reference, and SQLite deltas
  return to zero by default.

### S18.7 - Final Platform Security Verification and Closure

- **Status:** CLOSED.
- **Integrated access:** Central Subscription remains the ultimate entitlement authority
  while Store lifecycle remains separate. An otherwise active Store with invalid
  entitlement retains permitted reads but cannot perform online business writes or obtain
  a new Offline License. `read_only`, `suspended`, and `archived` restrictions remain
  stronger, and restoration does not activate or extend a Subscription.
- **Security:** Platform Admin authority remains durable, active-assignment based, audited,
  idempotent, and separate from Store roles and accounting authority. The controlled first
  Platform Admin bootstrap remains non-public. Runtime has no broad platform-table or
  sequence access; S18 `SECURITY DEFINER` functions retain pinned `search_path`, narrow
  execution grants, forced RLS, tenant isolation, and the accounting firewall.
- **Offline entitlement:** Dokana remains Offline-First and requires no continuous Internet.
  Ed25519 Licenses remain Store/device/Subscription-version bound, capped at the earlier of
  seven actual days or Subscription end, based on authoritative server time. Backend-only
  private-key custody, key rotation, exact expiry, rollback-safe read-only behavior, durable
  central revocation, and the limits of disconnected revocation were verified.
- **S19 handoff:** In-window licensed operations remain entitlement-eligible for later S19
  evaluation after subsequent License or Subscription expiry. Post-expiry, mismatched,
  unknown, invalid, or revoked evidence remains distinguishable for rejection or quarantine;
  tenant, idempotency, stale-write, accounting, and conflict decisions remain S19 scope.
- **Verification:** Focused S18 unit coverage passed 36/36 across six suites; focused real
  PostgreSQL integration passed 62/62 across six suites; security passed 15/15. Full unit
  passed 1,102/1,102 across 118 suites and broad integration passed 797/797 across 63 suites,
  with zero skips or failures. Typecheck, lint, build, role connections, migration checksum,
  11/11 reference verification, residue, idle transactions, and repository hygiene passed.
- **Database:** 21 applied / 0 pending. S18.7 added no migration or database change;
  PostgreSQL-reference and SQLite deltas are 0.
- **Exit:** S18 is closed. S19 is next and not started.

### S19 - Offline Sync and Consistent Data Bootstrap

- **Status:** CLOSED; S19.1-S19.9 CLOSED.
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
- **S19.1 readiness finding:** Current sync implementation is partial. PostgreSQL has
  forced-RLS operation, change-event, cursor, conflict, dead-letter, and bootstrap metadata
  tables, and domain mutations already provide substantial idempotency, deterministic fact
  identity, stale-write protection, and reversal/correction authority. No generic sync API,
  operation dispatcher, bootstrap service, pull service, conflict service, or sync Drizzle
  mapping exists.
- **Sync unit:** Use a hybrid protocol. Push typed, versioned domain operations through the
  existing server business authorities; pull/bootstrap versioned and allow-listed
  authoritative aggregate or read-model representations referenced by a durable change
  feed. Raw rows, balances, totals, costs, signs, subscription state, audit, and projections
  are never accepted as client authority.
- **PostgreSQL/SQLite parity:** Required offline parity includes Store/settings and the
  permitted local identity subset, catalogs, periods needed for validation, inventory,
  Supplier financial workflows, Customer financial workflows, Expenses, Returns, and the
  Offline License representation. Auth/session internals, central Subscription and Platform
  Admin authority, RLS, security-definer functions, central audit, and sync ledgers remain
  server-only. SQLite outbox, inbox receipts, cursor/checkpoint state, trusted-time cache,
  and local file state remain client-only.
- **Deferred SQLite findings:** Migration `0012` tracked versus untracked Sale-line support
  is sufficient. Migration `0013` historical inventory reversal support is partial.
  Migration `0014` Opening Receivable allocation targets and migration `0015` Sale Customer
  Credit tender support are missing. The S18 local-license shape is partial and requires a
  versioned client contract for current key, Subscription, binding, and verification state.
  The mobile repository owns Drift/SQLite implementation; this backend reference remains
  read-only unless separately authorized.
- **Identity and mutation readiness:** Direct client UUIDs are supported for mutable master
  data; accounting periods use an approved deterministic UUIDv5 exception; most S10-S17
  posted facts use deterministic UUIDv5 derivation from `operationId`. Manual Inventory and
  Stock Count roots/effects still use server-random identities and need an approved offline
  identity contract. Existing canonical request hashing, exact replay, changed-payload
  rejection, expected versions, and immutable correction chains are reusable but require a
  generic protocol registry.
- **Offline operation envelope direction:** Freeze in S19.2 a bounded envelope containing
  protocol and operation versions, `operationId`, allow-listed operation type, aggregate ID
  where applicable, optional `expectedVersion`, client-recorded time, monotonic device
  sequence, explicit dependencies only where needed, typed payload, and S18 License and
  trusted-time evidence. Store and device assertions must match authenticated server context;
  request hashes are calculated by the server, and business date remains domain payload.
- **Offline eligibility direction:** Core financial and operational mutations may be
  candidates for offline capture, including Sales, Customer settlement, Expenses and
  payments, Manual Inventory, Supplier invoices and settlement, Returns, and approved money
  operations. Settings, catalog lifecycle, and opening-state operations remain admin/setup
  pending the S19.2 allow-list decision. Accounting-period close, Store/Subscription/License
  administration, Platform Admin, authentication, and device bootstrap remain online-only.
- **S18 handoff:** The signed License establishes Store/device/Subscription binding and a
  bounded historical entitlement window. Late arrival after central expiry or later Store
  suspension remains entitlement-eligible when evidence proves valid offline creation before
  the device learned of suspension; it still must pass every domain and accounting rule. The
  current validation service is reusable but does not yet compose License validation,
  operation claim, local-order evidence, and domain effects in one transaction. Revoked,
  unknown, mismatched, definitely outside-window, and rollback cases are rejected or
  quarantined according to the frozen S19.2 policy.
- **Bootstrap direction:** Produce one dependency-ordered snapshot under a single
  `REPEATABLE READ`, read-only PostgreSQL view and bind it to a safe base cursor. Stream or
  chunk that same snapshot with schema/protocol/checksum metadata; the client builds staging
  SQLite state and exposes it atomically only after complete verification, then pulls after
  the base cursor. MVP restart may repeat the snapshot; durable multi-request resume requires
  separate physical authorization if selected.
- **Push direction:** Accept bounded batches but commit and acknowledge each operation
  independently. Preserve device order and explicit dependencies; perform authentication,
  License evidence, operation claim/replay, dependency/version checks, domain authority,
  accounting effects, change capture, and audit atomically. Results distinguish apply,
  exact replay, final rejection, dependency retry, quarantine, and user resolution.
- **Pull/cursor direction:** The explicit Store-scoped durable change feed introduced by
  migration `0022` is authoritative, not `updated_at` scans or the legacy global
  insertion-order cursor. S19.6 delivered the incremental pull API, Store-bound signed cursor,
  bounded resumable pages, and complete lifecycle propagation on that commit-order authority.
- **Conflict and lifecycle direction:** Never use last-write-wins. Exact operation replay is
  accepted; changed replay and invalid historical entitlement are rejected; missing
  dependencies retry; stale versions, archived references, and conflicting correction chains
  require rejection, quarantine, or explicit user resolution. Archive, restore, deactivate,
  reverse, and replace are durable state transitions; no generic hard-delete or tombstone is
  introduced while physical business deletion remains prohibited. A generic event action may
  be `update` while `processed_operations` retains a business action such as `restore`.
- **Accounting authority:** Sync transports commands and authoritative representations, not
  client-calculated balances. Money and Inventory movements, receivable/payable histories,
  immutable posted facts, and reversal/replacement chains remain authoritative; projections
  are reconstructed or delivered only as server-approved read models.
- **Database verdict:** Migrations `0022`-`0023` delivered the commit-ordered change
  foundation. Migrations `0024`-`0026` delivered the narrow transaction-bound historical
  authorization, provenance, dependency, and durable changed-replay authority required by
  S19.5 without granting runtime direct platform or provenance-table access. Authorized
  migration `0027` added immutable sanitized v1 representations, a replayable cutover boundary,
  and narrow pull functions on the same Store stream. S19.7 may require a targeted
  conflict/dead-letter contract change; every additional need requires separate evidence and
  backend-owner authorization.
- **Security direction:** Authenticate and bind Store/device server-side; verify signed
  License evidence against central issuance; enforce forced RLS and cross-tenant references;
  canonicalize operation identity; bound batches and payloads; allow-list protocol and
  operation versions; preserve expected-version and correction rules; quarantine suspicious
  clock, dependency, sequence, or local-state evidence.
- **Start condition:** S4-S18 mutation contracts are stable. S19.1 orientation and S19.2
  protocol freeze are complete; S19.3 must freeze the mobile parity handoff before sync
  implementation.
- **Closure intent:** Gap-free, duplicate-free, auditable server synchronization and
  consistent data bootstrap.

#### S19.1 - Orientation, Sync Readiness, and Stage Decomposition

- **Status:** CLOSED.
- **Purpose:** Inventory existing foundations, parity gaps, accounting boundaries, security
  risks, and physical needs, then define the executable S19 stages.
- **Owned scope:** Read-only repository/database analysis and this Roadmap update.
- **Explicit non-scope:** Sync code, migrations, SQLite changes, and protocol implementation.
- **Expected DB impact:** None; verified 21 applied / 0 pending.
- **Expected SQLite impact:** None.
- **Entry dependencies:** S18 closed and S4-S18 mutation contracts stable.
- **Exit criteria:** Readiness verdict, architecture direction, owner decisions, and S19.2-
  S19.9 boundaries are recorded.

#### S19.2 - Sync Protocol and Offline Operation Contract Freeze

- **Status:** CLOSED. Contract and Roadmap only; no production code, migration, SQLite, or
  reference-package change.
- **Model:** The protocol is hybrid. Push transports typed, versioned domain commands through
  existing business authorities. Pull transports authoritative, versioned server
  representations through a durable Store-scoped change feed. Bootstrap is one consistent
  authoritative snapshot plus a safe base cursor from the same consistency boundary. Raw
  table mutation and client-authored balances, totals, costs, signs, projections,
  Subscription state, Store state, tenant authority, and audit facts are prohibited.
- **Protocol and registry:** `protocolVersion` starts at integer `1`. Each `operationType` is
  a lowercase, dot-delimited, allow-listed identifier ending in its command schema version,
  for example `sales.post.v1`. Every concrete identifier maps to exactly one existing domain
  parser/use case, authorization policy, canonicalizer, and response mapper. Patterns are
  documentation shorthand only; runtime registration is concrete. Unknown versions,
  operations, or required semantics never execute, and no table/action/method name is
  accepted for generic dispatch.

The version-1 push envelope is frozen as follows:

| Field                                                 | Presence                     | Created by | Validated by | Authority and semantics                                                                                                                 |
| ----------------------------------------------------- | ---------------------------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion`                                     | REQUIRED                     | Client     | Both         | SERVER AUTHORITY; must equal a supported protocol version                                                                               |
| `operationId`                                         | REQUIRED                     | Client     | Both         | CLIENT FACT; canonical UUID and immutable command identity within the Store                                                             |
| `operationType`                                       | REQUIRED                     | Client     | Server       | SERVER AUTHORITY; exact allow-list key including command schema version                                                                 |
| `storeId`                                             | REQUIRED                     | Client     | Server       | SERVER AUTHORITY; assertion only and must equal authenticated Store context                                                             |
| `deviceId`                                            | REQUIRED                     | Client     | Server       | SERVER AUTHORITY; assertion only and must equal the authenticated registered device                                                     |
| `aggregateId`                                         | CONDITIONAL                  | Client     | Both         | CLIENT FACT only for commands with approved client-created root identity; otherwise omitted and deterministically derived by the server |
| `expectedVersion`                                     | CONDITIONAL                  | Client     | Server       | HISTORICAL EVIDENCE of the client-observed version; server state remains authoritative                                                  |
| `clientRecordedAt`                                    | REQUIRED                     | Client     | Server       | HISTORICAL EVIDENCE for entitlement classification; never sufficient alone                                                              |
| Domain `occurredAt`, business date, and references    | CONDITIONAL inside `payload` | Client     | Both         | CLIENT FACT where the existing domain permits it; server resolves posting eligibility                                                   |
| `payload`                                             | REQUIRED                     | Client     | Both         | CLIENT FACT expressing typed business intent under the registered command schema                                                        |
| `offlineLicenseId`                                    | REQUIRED                     | Client     | Server       | HISTORICAL EVIDENCE; must bind to the signed and centrally recorded License                                                             |
| Signed License plus License/key/Subscription versions | REQUIRED                     | Client     | Server       | HISTORICAL EVIDENCE verified through S18 signature, central issuance, and exact bindings                                                |
| `trustedTimeEvidence`                                 | REQUIRED                     | Client     | Server       | HISTORICAL EVIDENCE containing versioned S18 trusted-time state, trusted server anchor, last-seen device time, and rollback state       |
| `localSequence`                                       | REQUIRED                     | Client     | Server       | HISTORICAL EVIDENCE; positive lossless integer ordered within Store plus device                                                         |
| `dependsOnOperationIds`                               | CONDITIONAL                  | Client     | Server       | CLIENT FACT; canonical UUIDs for unsynchronized prerequisite operations only                                                            |

Arbitrary metadata and any client-selected total, balance, cost authority, posting authority,
Store lifecycle, Subscription state, or License expiry are not included. The client creates
business intent; the server owns tenant, role, entitlement classification, period and posting
eligibility, accounting effects, projections, audit, server timestamps, and the canonical
execution result.

- **Canonical idempotency:** The registry reuses each existing domain canonicalizer and
  `sync.processed_operations`; it does not create another idempotency ledger. The material
  request identity covers command schema version/type and every semantic aggregate,
  expected-version, date, reference, amount, quantity, reason, and payload field consumed by
  the command. JSON key order, transport formatting, batch position, retry counters, License
  signature/document, trusted-time evidence, and dependency scheduling hints are not business
  intent. They are validated and audited separately. Same Store plus `operationId` plus the
  same canonical material request returns exact replay; any changed material request is a
  deterministic conflict. Reusing a sequence or provenance binding inconsistently is a
  security conflict or quarantine, never a new business effect.
- **Trusted time:** A valid signed License, S18 trusted-time state, and local-order evidence
  jointly bound risk; the device wall clock never grants entitlement. The client captures
  `clientRecordedAt`, trusted server anchor, last-seen device time, rollback state, and
  `localSequence` atomically with the local business operation/outbox row. Creation reliably
  within `[issuedAt, offlineValidUntil)` is entitlement-eligible even when received after
  expiry. Creation definitely outside the interval is rejected. Missing, inconsistent,
  rollback, or tamper-suspect evidence is quarantined for explicit recovery. This bounded
  model does not claim a compromised device clock is tamper-proof.
- **Local ordering:** `localSequence` is required for every offline operation, scoped to one
  Store plus registered device, monotonically allocated, positive, never reused, and encoded
  losslessly. Gaps are legal and do not prove data loss; exact contiguity is not required.
  Request processing normally follows ascending sequence, but explicit dependencies and
  domain locks govern correctness. Sequence is evidence and scheduling input, never
  accounting authority. Exact replay retains the original sequence. Reinstall/reset requires
  a new registered device identity; a sequence must not restart under the old `deviceId`.
- **Dependencies:** Durable aggregate UUIDs remain the primary relationship. The optional
  dependency list names client operations whose aggregates are not yet durable centrally,
  such as Customer before Sale or Supplier before Invoice. Missing unresolved prerequisites
  return `DEPENDENCY_PENDING`; a finally rejected prerequisite causes explicit dependent
  rejection, not infinite retry. Dependency IDs never substitute for payload references and
  cannot bypass same-Store validation.
- **Manual Inventory and Stock Count identity:** Future offline Manual Inventory commands
  must accept a client-created `entryId`; Stock Count commands must accept a client-created
  `stockCountId`. Internal movement, item, and projection-effect UUIDs remain server-derived
  deterministically from `operationId` plus a frozen role/canonical item identity. Clients do
  not author accounting or inventory-effect IDs. Current repositories use random UUIDs for
  these roots/effects, so S19.3 owns the SQLite contract and S19.5 owns the backend command and
  derivation change. Existing UUID columns require no schema change for this identity rule.

The MVP operation eligibility registry is frozen at the following policy boundary:

| Command family                                                                                                    | Eligibility                  | Identity, conflict, dependencies, and authority                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Store settings mutation                                                                                           | ONLINE_ONLY                  | Current version and owner authority; not accepted by offline push                                                                            |
| Customer, Supplier, Product, and Product Unit create/update                                                       | OFFLINE_ALLOWED              | Accepted client UUIDs; operation replay; expected version for updates; dependency ordering; server normalization and constraints             |
| Customer, Supplier, Product, and Product Unit archive/restore                                                     | ONLINE_ONLY                  | Sensitive catalog lifecycle remains outside the initial offline allow-list                                                                   |
| Money Account and Expense Category catalog lifecycle                                                              | ONLINE_ONLY                  | Sensitive financial/setup catalog authority                                                                                                  |
| Accounting Period provision/close/lifecycle                                                                       | ONLINE_ONLY                  | Provisioning remains server-internal; close remains explicit owner authority                                                                 |
| Money, Customer Receivable, and Supplier Payable opening state                                                    | ONLINE_ONLY                  | Initial setup operations are excluded from the offline allow-list                                                                            |
| Owner contribution, owner loan, reimbursement, and approved withdrawals                                           | OFFLINE_ALLOWED              | Deterministic operation/fact identity; immutable correction; Money Account and period dependencies; server signs effects                     |
| Internal Money Transfer and same-domain Money correction                                                          | OFFLINE_ALLOWED              | Deterministic identities; account locks; period authority; immutable reversal/replacement                                                    |
| Manual Inventory opening/increase/decrease and correction                                                         | OFFLINE_ALLOWED              | Client root UUID required by S19.5; deterministic effects; Product/Unit, policy, stock lock, and period validation                           |
| Stock Count                                                                                                       | OFFLINE_ALLOWED              | Client root UUID required by S19.5; deterministic item/effect identities; Product/Unit and stock-lock validation                             |
| Supplier Invoice and immutable correction                                                                         | OFFLINE_ALLOWED              | Deterministic IDs and payable-only authority; Supplier/Product references and period validation; no inventory side effect                    |
| Opening Payable                                                                                                   | ONLINE_ONLY                  | Initial setup operation                                                                                                                      |
| Supplier Payment, allocation, credit/refund, and immutable correction                                             | OFFLINE_ALLOWED              | Deterministic IDs; Invoice/payable and Money Account dependencies; server allocation and signs                                               |
| Sale and immutable correction                                                                                     | OFFLINE_ALLOWED              | Deterministic IDs; Product/Unit, Customer when required, Inventory, Money Account, and period authority                                      |
| Opening Receivable                                                                                                | ONLINE_ONLY                  | Initial setup operation                                                                                                                      |
| Customer Collection, allocation, Credit application/refund/settlement, and correction                             | OFFLINE_ALLOWED              | Deterministic IDs; Customer/Sale/receivable/Money Account dependencies; server allocation and signs                                          |
| Expense, Expense Payment, and immutable correction                                                                | OFFLINE_ALLOWED              | Accepted Expense root UUID or deterministic effect IDs; Category/Money Account/period dependencies; server recognition and payment authority |
| Customer Return and immutable correction                                                                          | OFFLINE_ALLOWED              | Deterministic IDs; original Sale, settlement, historical Inventory, Money, Customer, and period authority                                    |
| Supplier Return, Credit application/refund, and immutable correction                                              | OFFLINE_ALLOWED              | Deterministic IDs; Supplier Invoice/payable/Money Account and period authority; no automatic inventory coupling                              |
| Platform Admin, Store lifecycle, Subscription, License issuance/revocation, authentication, and device activation | NOT_APPLICABLE / ONLINE_ONLY | Central server authority; never dispatched through offline business push                                                                     |

Every offline-allowed command must present S18 License evidence and pass the existing domain
parser, idempotency, dependency, stale-state or immutable-correction, locking, period,
accounting, RLS, and audit authority. The table is an allow-list ceiling, not proof that the
current code already exposes sync dispatch.

- **Push batch:** Requests are bounded by server-configured item, body, and execution limits
  finalized in S19.5; S19.2 invents no arbitrary number. Structurally valid items are processed
  independently, normally in ascending device sequence with dependency-aware deferral. Each
  operation owns one authoritative PostgreSQL transaction and deterministic result; one item
  failure does not roll back unrelated committed items. An unparseable request envelope may
  reject the request; an identifiable malformed item is rejected without executing it.
  Retries reuse the same operation, sequence, material payload, and dependencies.
- **Validation order:** Authenticate the restricted sync request/device; derive Store context;
  validate protocol and concrete operation type; verify License identity/signature/binding;
  classify creation-time entitlement; claim or resolve `operationId`; resolve dependencies;
  validate expected version or immutable correction authority; resolve current S9 posting and
  domain rules; execute the existing domain authority; atomically persist business effects,
  authoritative result, change exposure, and audit; then return the stored per-operation
  result. Concrete lock order remains owned by each domain and future database design.
- **Result vocabulary:** `APPLIED` means the operation committed once. `EXACT_REPLAY` returns
  the stored result with no new effects. `REJECTED` is a final security, validation, period,
  or business-rule failure. `DEPENDENCY_PENDING` is retriable only after named prerequisites.
  `CONFLICT` means changed replay, stale version, competing immutable chain, or another state
  collision requiring a new operation or user resolution. `QUARANTINED` means the operation
  was received but no accounting effect was accepted because trust or compatibility evidence
  is insufficient; it is preserved for explicit recovery, not discarded or retried forever.
  Domain error codes remain subordinate to these six outcomes.
- **Conflict policy:** There is no last-write-wins. Changed replay and stale version are
  `CONFLICT`; missing prerequisite is `DEPENDENCY_PENDING`; closed/closing period is
  `REJECTED`; archived or otherwise ineligible references are explicit domain
  rejection/conflict; invalid correction lineage is rejection/conflict; creation definitely
  outside entitlement is `REJECTED`; uncertain entitlement or local tampering is
  `QUARANTINED`; cross-tenant identity is a non-disclosing security `REJECTED` result.
- **Temporal policy:** Subscription state at arrival does not replace the signed historical
  License window. An operation proven created under a valid License remains entitlement-
  eligible after License or Subscription expiry. Later Store suspension also does not erase
  eligibility when the device had not yet received a trusted suspension state; after such a
  state is acknowledged, later local operations are ineligible, and no new License may be
  issued while suspended. Central License revocation remains a rejection under S18. None of
  these entitlement decisions bypasses tenant, dependency, version, accounting, or domain
  rules.
- **Delayed accounting periods:** S9 has no historical offline exception. A delayed unseen
  posting resolves its existing posting context at server application time. If its derived
  period is `closed` or `closing`, the operation is `REJECTED`; the client must use the
  approved correction/replacement workflow in an eligible open period where applicable.
  Exact replay of an already completed matching operation remains replay and creates no new
  period or accounting effect.
- **Immutable facts:** Sync never replaces posted Money, Inventory, receivable, payable,
  Expense, Sale, Return, allocation, or correction rows. Offline corrections invoke existing
  reversal/replacement/correction-chain commands and preserve originals and lineage.
- **Bootstrap and pull boundary:** Bootstrap exposes one dependency-ordered `REPEATABLE READ`
  snapshot, integrity metadata, and a safe base cursor from the same consistency boundary;
  partial data stays in local staging and never becomes the active accounting database.
  Incremental pull returns Store-scoped authoritative changes with no committed gaps, safe
  replay, deterministic cursor advancement, resumable pagination, and visible archive,
  restore, reversal, replacement, and deactivation transitions. `updatedAt` scanning is not
  approved. S19.4 delivered the safe cursor/change-feed foundation early through migrations
  `0022`-`0023`; S19.6 subsequently delivered the incremental pull API and end-to-end
  propagation proof.
- **S19.3 SQLite handoff:** The mobile contract must add the frozen envelope, local sequence,
  dependencies, trusted-time evidence, six result states, inbox receipt and cursor/bootstrap
  metadata, accepted Manual Inventory/Stock Count root IDs, deterministic child/effect IDs,
  historical Inventory reversal parity, Opening Receivable allocation targets, Sale Customer
  Credit tender, and S18 License/key/Subscription/device/version binding. The backend
  reference and SQLite files remain unchanged in S19.2.
- **Authority boundary:** The client may author only typed business intent: approved client
  UUIDs, quantities, selected Product/Customer/Supplier references, permitted entered prices
  and amounts, notes/references, and domain-approved occurrence time. The server remains
  authoritative for tenant and role, effective entitlement, Store and Subscription state,
  posting and period eligibility, signs and derived totals, balances, Inventory projection,
  cost, receivable/payable effects, audit, server timestamps, and the canonical execution
  result.
- **Security ownership:** Existing authentication, registered-device binding, signed License
  verification, central issuance lookup, forced RLS, composite Store references, domain
  validation, canonical hash, operation claim, expected versions, deterministic fact IDs,
  append-only guards, and audit are reused. S19.5 owns restricted sync-only handling for
  historically eligible suspended-Store operations, atomic entitlement/domain composition,
  device-sequence provenance, strict allow-list dispatch, DTO limits, malformed-batch
  isolation, and clock/local-tamper quarantine. S19.6 delivered the public incremental pull API,
  cursor validation, and lifecycle propagation on the S19.4 foundation. S19.7 owns durable
  recovery and quarantine access. No client assertion grants tenant, device, Subscription,
  Store, period, or accounting authority.

| Threat                             | Existing control                                                                 | Future S19 owner                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Forged `storeId`                   | Authenticated membership, server-derived Store context, forced RLS               | S19.5 rejects any envelope assertion mismatch                                         |
| Forged `deviceId`                  | Registered-device authentication and S18 License device binding                  | S19.5 composes device validation in the operation transaction                         |
| Forged License or client expiry    | S18 signature/key verification and central issuance lookup                       | S19.5 performs atomic historical-entitlement classification                           |
| Cross-tenant entity reference      | Forced RLS and composite Store references                                        | S19.5 preserves non-disclosing domain rejection                                       |
| Client-selected Subscription/Store | Central platform authority; neither value is business intent                     | S19.5 ignores assertions as authority and validates protected state                   |
| Changed replay or duplicate effect | Canonical request hash, `sync.processed_operations`, deterministic fact identity | S19.5 returns conflict or exact replay without a second effect                        |
| Fabricated wall-clock entitlement  | Signed License window plus S18 trusted-time state                                | S19.5 quarantines insufficient/inconsistent evidence; S19.7 owns recovery             |
| Stale overwrite                    | Expected versions and immutable correction chains                                | S19.5 dispatches only through existing domain authority                               |
| Unsupported operation/version      | No generic dispatch                                                              | S19.5 uses a concrete allow-list and rejects or quarantines unsupported semantics     |
| Malformed batch smuggling          | DTO/runtime validation and request-size infrastructure                           | S19.5 bounds batches and isolates identifiable malformed items without executing them |
| Gap or cursor manipulation on pull | Store-scoped commit-order foundation and tenant authority                        | S19.6 delivered API cursor validation, resumable pages, and propagation proof         |

- **Future physical needs:** S19.4 is complete with restart-from-zero artifact delivery and the
  authorized `0022`-`0023` commit-order foundation; no snapshot-persistence table was added.
  S19.5 is complete with migrations `0024`-`0026`, which atomically lock and validate protected
  License/Store/device state, preserve the historical suspension boundary, bind device
  sequence provenance, and compose those checks with one domain transaction. S19.6 is complete
  with migration `0027`, immutable post-cutover representations, and narrow Store pull bounds
  and page functions. S19.7 is `LIKELY`: existing
  conflict/dead-letter rows may be reusable, but they do not cleanly freeze quarantine state,
  disposition, and recovery semantics. Every migration requires separate Station evidence
  and backend-owner authorization.
- **Future tests:** S19.3 owns SQLite migration/parity and atomic outbox evidence. S19.4 proved
  snapshot consistency, restart, failure, atomic local activation compatibility, commit order,
  pagination foundations, concurrent commits, Store isolation, and least privilege. S19.5
  proved real PostgreSQL License, sequence, idempotency, dependency, rollback, RLS,
  suspended-Store, batch, concurrency, durable changed-replay, and zero-double-effect behavior.
  S19.6 proved API pagination/cursor behavior, bootstrap continuity, Store commit order,
  online/offline unified propagation, complete relation coverage, retries, and fail-closed
  version handling. S19.7 owns retry/quarantine/recovery. S19.8 owns cross-domain
  offline accounting scenarios. S19.9 passed the integrated lifecycle, full unit, and broad
  integration closure gates.
- **Exit:** The hybrid model, envelope, registry, eligibility, identity, trusted-time,
  ordering, dependency, batch, result, conflict, quarantine, temporal, authority,
  bootstrap/pull, SQLite handoff, security, test, and future-database contracts are frozen.
  No S19.2 owner decision remains. S19.3 is closed.

#### S19.3 - SQLite/Drift Parity Contract and Mobile Handoff

- **Status:** CLOSED.
- **SQLite version:** The supported upgrade path is `1.2.0` / `user_version = 10200` to
  `1.3.0` / `user_version = 10300` through
  `database/reference/backend_database_reference/sqlite_v1_3_sync_parity_patch.sql`.
  Fresh creation applies the v1.1 baseline, the v1.2 settings patch, and the v1.3 sync-parity
  patch in order. Reapplying v1.3 is rejected by the version guard.
- **Domain parity:** Migration `0012` requires no SQLite change. The local contract retains
  immutable Inventory reversal lineage and its one-reversal invariant, adds the authoritative
  Manual Inventory root representation, retains the client-created Stock Count root identity,
  adds Opening Receivable allocation targets, and represents Sale Customer Credit as a
  distinct liability application rather than a negative receivable. Reversal/replacement
  successor details may be retained in the versioned operation result; no second editable
  Inventory correction model is introduced.
- **License and trusted time:** Local storage includes License/Store/device/Subscription/key
  binding, the signed document and signature, public Ed25519 verification material, explicit
  verification/revocation state, and durable trusted-time/rollback evidence. No private
  signing key is stored. SQLite evidence remains untrusted input to the future server-side
  S19.5 revalidation boundary.
- **Sync persistence:** The v1 outbox stores the frozen typed envelope, lossless Store/device
  local sequence and UUID dependencies. Results preserve all six frozen classifications.
  Inbox receipts, safe cursor state, bootstrap generation metadata, and a staging/validated/
  active dataset state support crash-safe future pull and bootstrap work without making local
  balances, totals, costs, Store state, Subscription state, or License state authoritative.
- **Upgrade evidence:** Focused SQLite integration coverage proves fresh creation, v1.2
  upgrade with preserved business and sync rows, deterministic repeat rejection, schema
  convergence, foreign-key and integrity checks, deferred `0013`-`0015` parity, exact 64-bit
  money/quantity/sequence storage, temporal distinctions, and bootstrap/cursor constraints.
- **Mobile handoff:** No Flutter/Drift project exists in this repository. The mobile project
  must materialize the same `10300` schema and constraints in Drift, allocate `localSequence`
  durably per Store/device, capture business intent and trusted-time evidence atomically, keep
  private signing keys off-device, build bootstrap data in a separate staging database, verify
  it completely, and expose it only through an atomic activation/swap. S19.3 does not
  implement Flutter, bootstrap transport, push, pull, server cursor sequencing, or recovery
  workflows.
- **Database impact:** PostgreSQL remains 21 applied / 0 pending with no PostgreSQL migration,
  database change, or PostgreSQL reference change. S19.3 changes only the authorized SQLite
  compatibility contract, its focused integration test, and this Roadmap.
- **Exit:** SQLite parity and the mobile implementation handoff are testable and closed. The
  safe-cursor prerequisite was subsequently delivered early under S19.4 by migrations
  `0022`-`0023`; this did not start S19.6.

#### S19.4 - Consistent Initial Bootstrap

- **Status:** CLOSED.
- **Delivered:** Authenticated owner-authorized bootstrap binds the current Store, device, and
  signed Offline License, then reads one dependency-ordered snapshot and its base watermark
  inside the same read-only `REPEATABLE READ` transaction. Delivery is bounded to 100 records
  per page, restartable, stored in private temporary artifacts, and protected by canonical
  manifest, dataset, page, and snapshot SHA-256 integrity metadata.
- **Consistency foundation:** Migration `0022` adds forced-RLS Store watermarks and change
  events, deferred commit-time capture over the approved synchronized relations, sanitized
  versioned payloads, and narrow boundary/page functions. Migration `0023` corrects only the
  boundary hash call using a verified schema-qualified PostgreSQL function. Real concurrency
  tests prove that a transaction committing after the bootstrap snapshot remains visible from
  the returned base watermark, even when a later transaction committed first.
- **SQLite handoff evidence:** Integration tests stage actual bootstrap pages into a SQLite
  `1.3.0` / `10300` database, verify checksums, foreign keys, integrity, exact 64-bit decimal
  values, and dependency order, then prove atomic staging-to-active activation with the safe
  cursor. Missing or tampered data never becomes active.
- **Security and scope:** Cross-Store, unsupported-version, invalid-device, and restricted
  requests fail closed. Runtime receives no direct sync-table access, raw unsanitized changes,
  or signing key. Push, the incremental pull HTTP API, conflicts, quarantine, and recovery are
  not part of S19.4. S19.6 subsequently consumed the commit-order foundation for pull.
- **Verification:** Focused bootstrap passed 5/5 and commit-order foundation passed 3/3. Full
  unit passed 1,104/1,104 across 119 suites and broad integration passed 813/813 across 66
  suites, with no skips or failures. Typecheck, lint, build, migration checksum/status, role
  checks, Store isolation, residue, and idle-transaction checks passed.
- **Database and compatibility:** PostgreSQL is 23 applied / 0 pending. SQLite remains
  `1.3.0` / `10300`; the historical PostgreSQL reference remains unchanged.
- **Exit:** Consistent initial bootstrap is closed. S19.5 is next / not started.

#### S19.5 - Offline Operation Push and Server Application

- **Status:** CLOSED.
- **Delivered:** Dedicated sync authentication and bounded push accept only the frozen concrete
  operation registry. Each identifiable item runs in its own Store-bound transaction through
  existing domain authorities with signed-License, Store/device, local-sequence, dependency,
  expected-version, canonical replay, and historical-entitlement validation. Exact replay does
  not duplicate effects; changed material is a durable sync conflict; malformed or unrelated
  batch items cannot partially execute another item.
- **Accounting and security:** Domain services remain the only business-posting authority.
  Runtime receives only narrow `SECURITY DEFINER` execution, with pinned `search_path`, forced
  RLS, transaction-local identity, and no direct platform or provenance-table privileges.
  Supplier Invoice remains payable-only. Money, Inventory, receivable/payable, Expense, Return,
  period, reversal, and replacement invariants remain enforced by their canonical services.
- **Verification:** Migration runner passed 8/8; affected sync units passed 46/46; focused real
  PostgreSQL authority passed 14/14; focused push passed 5/5, including concurrent durable
  changed replay with zero duplicate invoice/payable effect. Full unit evidence remains
  1,162/1,162 across 125 suites. Broad integration passed 832/832 across 68 suites with no
  skips or failures. Typecheck, lint, build, migration checksum/status, role checks, reference
  checksums, RLS/grants, Store isolation, residue, and idle-transaction checks passed.
- **Database and compatibility:** PostgreSQL is 26 applied / 0 pending after migrations
  `0024`-`0026`. SQLite remains `1.3.0` / `10300`; the historical PostgreSQL reference remains
  unchanged.
- **Exit:** Offline operation push and server application are closed. S19.6 is next / not
  started.

#### S19.6 - Commit-Ordered Incremental Pull and Change Propagation

- **Status:** CLOSED.
- **Delivered:** Authenticated `GET /v1/sync/pull` derives Store context server-side and reads
  the existing commit-ordered Store stream through narrow runtime functions. Signed
  Store-bound cursors preserve exact bigint positions, bounded pages advance only through
  delivered changes, retries redeliver safely, and legacy pointer-only cursors require a new
  bootstrap.
- **Representation and continuity:** Migration `0027` records immutable, sanitized v1
  representations atomically with each sync-visible mutation and establishes a deterministic
  cutover boundary without rewriting pointer-only history. All 41 mutable bootstrap relations
  have one deferred transactional publisher and a representation matching the bootstrap shape;
  platform identity, Subscription, and License internals remain server-only. Bootstrap and pull
  share the same Store watermark, and unknown required versions fail closed without cursor
  advancement.
- **Verification:** Focused cursor units passed 10/10; immutable representation and commit-order
  PostgreSQL tests passed 10/10; bootstrap continuity passed 6/6; representative offline and
  unified online/offline propagation passed 12/12. Full unit passed 1,172/1,172 across 127
  suites. Broad integration passed 841/841 across 69 suites with no skips or failures. Real
  PostgreSQL tests covered reversed commit order, rollback, pagination, response retry,
  Store isolation, RLS, least privilege, exact replay, false-event prevention, and cross-domain
  accounting/inventory publication.
- **Database and compatibility:** PostgreSQL is 27 applied / 0 pending after migration `0027`.
  Migration checksums and runtime/auth/migration role checks pass. SQLite remains `1.3.0` /
  `10300`; the historical PostgreSQL reference remains unchanged.
- **Exit:** Commit-ordered incremental pull and authoritative change propagation are closed.
  S19.7-S19.9 and S19 are closed.

#### S19.7 - Conflict, Retry, Recovery, and Quarantine

- **Status:** CLOSED.
- **Delivered:** Store-scoped non-mutating six-state operation status, explicit allow-listed
  quarantine recovery, immutable recovery-attempt lineage, bounded dependency-cycle handling,
  and serialization across normal push, concurrent recovery, and canonical idempotency.
  Recovery preserves the original operation identity and material request and reuses the typed
  domain authorities; it contains no independent accounting or inventory logic.
- **Database and security:** Reconciliation proved the required recovery authority did not exist
  in migrations `0022`-`0027`. Migration `0028` adds only the forced-RLS recovery lineage and
  narrow pinned `SECURITY DEFINER` status/recovery functions. Runtime retains no direct table
  privileges and legacy begin authority is no longer executable by runtime. PostgreSQL is 28
  applied / 0 pending; SQLite remains `1.3.0` / `10300`; the historical PostgreSQL reference is
  unchanged.
- **Verification:** Focused recovery PostgreSQL tests passed 13/13 and security tests passed
  15/15. Full unit passed 1,176/1,176 across 127 suites; broad integration passed 848/848 across
  69 suites, with no skips or failures. Typecheck, lint, build, formatting, migration
  checksum/status, role checks, Store isolation, RLS/grants, residue, and idle-transaction checks
  passed.
- **Exit:** Durable recovery and quarantine handling are closed. S19.8-S19.9 and S19 are
  closed.

#### S19.8 - Cross-Domain Offline Accounting Verification

- **Status:** CLOSED.
- **Coverage:** All 62 registered offline operations have an exhaustive checked classification:
  54 accounting- or inventory-significant operations are covered by 11 direct cross-domain
  PostgreSQL effect-vector cases and 43 equivalent canonical-authority cases; the remaining
  eight are non-accounting Customer, Supplier, Product, and Product Unit mutations. No
  accounting-significant operation remains unverified, and Sync continues to dispatch through
  the existing typed domain services rather than a second accounting engine.
- **Accounting equivalence:** Exact vectors verify Sale/Receivable/Inventory/Cost, Customer
  Collection, Supplier Invoice/Payable, Supplier Payment/Money, Expense/Payment, Manual
  Inventory, Stock Count, Supplier Return, and Sale Return effects. Supplier Invoice creates no
  inventory, Supplier Payment creates no second Expense, Expense Payment does not recognize a
  second Expense, and customer debt remains a Receivable. Money minor units, inventory
  milli-units, known costs, movement authority, protected projections, and immutable
  reversal/replacement behavior remain canonical.
- **Sync safety:** Exact replay leaves every business and accounting vector unchanged and emits
  no second authoritative change. Existing PostgreSQL coverage proves response-loss retry,
  conflict/dependency/quarantine zero effects, recovery-at-most-once behavior, Accounting Period
  enforcement for delayed operations, atomic rollback, deterministic concurrency, Store
  isolation, forced RLS, least privilege, and single S19.6 change-stream publication.
- **Verification:** The registry coverage unit passed 8/8; focused offline push passed 13/13;
  19 canonical accounting PostgreSQL suites passed 303/303; security passed 15/15. Full unit
  passed 1,177/1,177 across 127 suites and broad integration passed 848/848 across 69 suites,
  with no skips or failures. Typecheck, lint, build, changed TypeScript formatting, diff
  validation, database role checks, migration status/checksums, test residue, and
  idle-transaction checks passed. The Roadmap's pre-existing full-file Prettier warning was
  confirmed against the committed file and left unchanged as required.
- **Database and compatibility:** No migration or production behavior changed. PostgreSQL
  remains 28 applied / 0 pending. SQLite remains `1.3.0` / `10300`; the historical PostgreSQL
  reference remains unchanged.
- **Exit:** Cross-domain offline accounting equivalence is closed. S19.9 and S19 are closed.

#### S19.9 - Integrated Offline Sync Verification and S19 Closure

- **Status:** CLOSED.
- **Integrated lifecycle:** One real PostgreSQL flow proved consistent bootstrap and safe base
  cursor, mixed online/offline work, dependency-pending and quarantine zero-effect paths,
  durable recovery across application restart, canonical push, exact replay, changed-request
  conflict, commit-ordered pull, response-loss retry, and convergent client-visible state.
- **Accounting and security:** Canonical domain authorities produced the exact representative
  money, receivable, inventory, cost, and open-period effects. Replays, conflicts, rejected
  operations, pending dependencies, and pre-recovery quarantine produced no duplicate or false
  business effect. Store isolation, forced RLS, least privilege, sanitized representations,
  and secret exclusion remained intact.
- **Verification:** The focused offline-push suite passed 14/14. Full unit passed 1,177/1,177
  across 127 suites and broad integration passed 849/849 across 69 suites, with no skips or
  failures. Typecheck, lint, build, changed-file formatting, diff validation, database role
  checks, migration status/checksums, test residue, and idle-transaction checks passed.
- **Database and compatibility:** No migration or production behavior changed. PostgreSQL
  remains 28 applied / 0 pending. SQLite remains `1.3.0` / `10300`; the historical PostgreSQL
  reference remains unchanged.
- **Exit:** Integrated offline synchronization is verified and S19 is closed. S20 is next and
  not started.

#### S19.2-S19.9 - Approved Execution Decomposition

| Stage                                                          | Status             | Purpose and owned scope                                                                                                                                                                           | Explicit non-scope                                                    | Expected DB impact                                               | Expected SQLite impact                                                                    | Entry dependencies                                   | Exit criteria                                                                                      |
| -------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S19.2 - Sync Protocol and Offline Operation Contract Freeze    | CLOSED             | Freeze versions, operation allow-list, canonical envelope/hash, identity registry, acknowledgements, dependency and conflict dispositions, entitlement evidence, limits, and compatibility policy | Runtime endpoints and persistence changes                             | None                                                             | None; mobile handoff frozen for S19.3                                                     | S19.1 and owner decisions in the S19.2 prompt        | One reviewed protocol contract defines every supported operation and outcome                       |
| S19.3 - SQLite/Drift Parity Contract and Mobile Handoff        | CLOSED             | Map every offline operation and representation, resolve `0013`-`0015` and S18 License gaps, and publish a versioned mobile migration/compatibility handoff                                        | Flutter/Drift implementation in this repository or reference rewrites | None                                                             | Authorized SQLite compatibility patch `1.3.0` / `10300`; no Flutter/Drift code is present | S19.2                                                | Lossless, dependency-correct parity and upgrade requirements are testable                          |
| S19.4 - Consistent Initial Bootstrap                           | CLOSED             | Authenticated dependency-ordered `REPEATABLE READ` bootstrap, same-boundary safe base cursor, bounded artifacts/checksums, restart, SQLite staging compatibility, and failure semantics           | Backup storage and incremental push/pull                              | Migrations `0022`-`0023`; no persistent snapshot table           | Mobile implementation remains outside this repository; compatibility was proven in tests  | S19.2-S19.3 and authorized commit-order prerequisite | A device can establish one internally consistent local state and continue from its cursor          |
| S19.5 - Offline Operation Push and Server Application          | CLOSED             | Implement bounded push, per-operation transactions, S18 evidence, claim/replay, dependency/version checks, typed domain dispatch, and deterministic acknowledgements                              | Pull, broad conflict UI, or accounting redesign                       | Migrations `0024`-`0026`; PostgreSQL 26 applied / 0 pending      | Mobile outbox/envelope upgrade belongs to the mobile implementation                       | S19.2-S19.4 and approved DB authorization            | Supported operations apply once, replay exactly, fail atomically, and preserve domain authority    |
| S19.6 - Commit-Ordered Incremental Pull and Change Propagation | CLOSED             | Authenticated incremental pull, signed Store cursor, bounded retry-safe pages, immutable sanitized representations, bootstrap continuity, and unified online/offline propagation                  | `updated_at` polling or raw internal-row exposure                     | Migration `0027`; PostgreSQL 27 applied / 0 pending              | Mobile inbox/cursor application belongs to the mobile implementation                      | S19.2-S19.5                                          | Pull is gap-free, duplicate-safe, bounded, resumable, and dependency-correct                       |
| S19.7 - Conflict, Retry, Recovery, and Quarantine              | CLOSED             | Store-scoped six-state inspection, durable quarantine recovery and lineage, dependency-cycle safety, and serialized reuse of canonical domain/idempotency authority                              | Silent last-write-wins, destructive repair, or new accounting logic   | Migration `0028`; PostgreSQL 28 applied / 0 pending              | Mobile retry/quarantine state belongs to the mobile implementation                        | S19.5-S19.6                                          | Every non-success outcome is deterministic, auditable, and recoverable or final                    |
| S19.8 - Cross-Domain Offline Accounting Verification           | CLOSED             | Verify Sales, Customer and Supplier settlement, Expenses, Inventory, Returns, Money, periods, corrections, and projections across disconnect/retry/concurrency                                    | New accounting behavior                                               | None; PostgreSQL remains 28 applied / 0 pending                  | None; SQLite remains `1.3.0` / `10300`                                              | S19.3-S19.7                                          | Offline convergence preserves every authoritative movement, ledger, period, and reversal invariant |
| S19.9 - Integrated Offline Sync Verification and S19 Closure   | CLOSED             | Ran final protocol, security, RLS, concurrency, failure, bootstrap, push/pull, parity, regression, documentation, and repository-hygiene gates                                                     | S20 reporting, S21 support features, or S22 backup                    | None; PostgreSQL remains 28 applied / 0 pending                  | None; SQLite remains `1.3.0` / `10300`                                              | S19.2-S19.8 complete and independently reviewed      | S19 closed with gap-free, duplicate-free, tenant-safe, auditable convergence evidence               |

### S20 - Dashboard, Reports, Search, Documents, and Export

- **Status:** CLOSED; S20.1-S20.6 are closed.
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

S20.1 confirmed that existing domain reads, protected projections, transaction-local RLS,
owner authorization, keyset pagination, exact `bigint`/milli-unit serialization, Store-local
operational-time handling, and bounded `REPEATABLE READ` tenant snapshots are reusable.
Dashboard aggregation, cross-domain reports, global Store search, canonical PDF documents,
business-data export, and machine-readable API/data-dictionary coverage remain implementation
gaps. No new accounting authority, product/accounting decision, or database capability is
required to begin S20.2. Performance indexes or reporting projections remain evidence-based
questions only and require separate approval if later proven necessary.

S20.2 added the owner-authorized `GET /v1/dashboard` read model over one bounded,
read-only `REPEATABLE READ` Store snapshot. It reports Store-local today Sales and
collections, credit Sales, recognized Expenses, supplier payments, active money-account
balances, Customer receivables, Supplier payables, inventory projection and valuation
coverage, and a deterministic 20-item recent-activity feed. Existing canonical projections
and records remain authoritative; money and milli-units remain exact decimal strings, unknown
inventory value remains explicit, and online and offline-originated canonical data use the
same read path. Real PostgreSQL tests proved snapshot consistency, RLS/Store isolation,
`read_only` access, and no persistent test residue. PostgreSQL remains 28 applied / 0 pending,
with PostgreSQL-reference and SQLite deltas both 0.

S20.3 added owner-authorized, explicitly filtered and bounded daily/monthly operational,
profit, liquidity, Sales, Expense, money-movement, Customer-receivable,
Supplier-payable, inventory-stock/movement, return/correction, and owner-ledger reports.
They reuse canonical records and projections, deterministic scope-bound keyset pagination,
Store-local business dates, posting dates and accounting periods, exact money/milli-unit
strings, and read-only `REPEATABLE READ` Store snapshots for coherent rows and totals.
Current-state and historical-ledger semantics remain distinct; unknown cost remains explicit,
and reversal/replacement history remains visible. Real PostgreSQL tests reconciled overlapping
Dashboard metrics, online/offline-originated data, RLS/Store isolation, `read_only` access,
and concurrent snapshot consistency. PostgreSQL remains 28 applied / 0 pending, with
PostgreSQL-reference and SQLite deltas both 0.

S20.4 added owner-authorized `GET /v1/search` discovery over an explicit allow-list of
Customer, Supplier, Product, Sale, Supplier Invoice, Expense, Customer Collection,
Supplier Payment, Money Account, Money Movement, Sale Return, Supplier Return, and
Inventory Movement records. Search uses bounded normalized input, exact identifier,
phone, amount, and date matching where applicable, deterministic ranked keyset pagination,
scope-bound cursors, canonical stored values, and privacy-equivalent authorization errors.
Archived and corrected records remain discoverable with truthful status, while Platform,
authentication, synchronization, audit, internal-note, and secret data remain excluded.
Real PostgreSQL tests proved Store isolation, owner authorization, `read_only` access,
online/offline neutrality, adversarial input bounds, and read-only behavior. PostgreSQL
remains 28 applied / 0 pending, with PostgreSQL-reference and SQLite deltas both 0.

S20.6 closed the machine-readable API and data-semantics gap with an application-generated
OpenAPI document at `GET /openapi.json`. The document covers the current REST surface and
explicitly describes S20 Dashboard, report, search, document, and PDF operations, including
authentication, bounded filters and cursors, error responses, exact decimal-string money and
milli-unit values, Store-local business dates, posting dates, accounting periods, record
versions, unknown-cost disclosure, and operational-profit scope. Integrated real-PostgreSQL
verification reconciled Dashboard, reports, search, and canonical PDFs to existing domain
authorities; proved online/offline equivalence, `read_only` access, RLS and Store isolation,
consistent snapshots, deterministic pagination, and zero read-side mutation; and found no
second accounting engine. PostgreSQL remains 28 applied / 0 pending, with no migration,
PostgreSQL-reference, or SQLite delta.

S20 uses `businessDate` for Store-local operational activity, `postingDate` and
`accountingPeriodId` for financial/period reporting, and `occurredAt` for event chronology.
Single-query reads may use ordinary tenant transactions; multi-query dashboard/report/export
results require a bounded read-only consistent snapshot. Authorized reads remain available for
`read_only` Stores, while suspended/archived Store access continues to follow existing normal
authentication policy. PDFs are regenerable representations of canonical records, not posting
authority or attachment storage. Approved export scope is PDF; backup/restore belongs to S22.

| Sub-stage                                              | Status             | Purpose and implementation scope                                                                                                                                                                                                     | Dependencies and explicit non-scope                                                                                              | Database expectation                                                 | Security, accounting, and test closure                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S20.1 - Orientation, Scope, and Stage Decomposition    | CLOSED             | Inventory existing read authorities, freeze S20 boundaries, date/precision rules, consistency needs, gaps, and delivery order                                                                                                        | S19 closed; no product implementation                                                                                            | Database delta = 0                                                   | Repository/database baseline verified; no owner decision or database blocker                                                                                                                                                              |
| S20.2 - Dashboard and Shared Read Foundation           | CLOSED             | Add owner-authorized dashboard aggregates and shared bounded filters/snapshot primitives over canonical Sales, collections, Expenses, supplier payments, money balances, receivables, payables, inventory value, and recent activity | S7-S19; excludes notifications, audit browsing, new projections, and accounting writes                                           | Database delta = 0                                                   | Source reconciliation, Store-local day boundaries, unknown-cost disclosure, exact money, read-only access, RLS, cross-Store rejection, online/offline neutrality, and snapshot consistency proven                                         |
| S20.3 - Accounting and Operational Reports             | CLOSED             | Added bounded daily/monthly Sales, collections, debt, Expense/payment, profit, liquidity, Customer, Supplier, inventory, account, movement, return/correction, and owner-ledger reports using established domain signs and status   | S20.2 shared read foundation; excludes new financial statements, ledger effects, and rewritten correction history                | Database delta = 0; PostgreSQL remains 28 applied / 0 pending        | Current-state versus historical-ledger semantics, totals/subtotals, known/unknown cost coverage, date/period filters, exact precision, pagination, snapshots, RLS, and reconciliation proven                                              |
| S20.4 - Global Store Search and Read-Side Discovery    | CLOSED             | Added typed, allow-listed, bounded global Store search across approved Customer, Supplier, Product, invoice/document, phone, amount, date, status, account, and movement fields while retaining entity-specific search               | S20.2-S20.3; excludes arbitrary-table/full-text infrastructure, Platform data, and cross-tenant discovery                         | Database delta = 0; PostgreSQL remains 28 applied / 0 pending        | Deterministic scope-bound pagination, ranking/filter contract, archived/history behavior, privacy-equivalent errors, RLS, adversarial input bounds, read-only behavior, and Store isolation proven                                        |
| S20.5 - Canonical Business Documents and PDF Export    | CLOSED             | Added Sale, Customer Ledger, Supplier Ledger, and all approved S20.3 report PDFs from canonical Sale/report authorities, with truthful correction/return state, exact money/milli-unit formatting, unknown-cost disclosure, Arabic/long-text support, safe bounded multi-page rendering, and zero persistent generation effects | S20.2-S20.4 as applicable; excludes attachment storage, notification delivery, backup, restore, CSV/XLSX, and reposting metadata | Database delta = 0; PostgreSQL remains 28 applied / 0 pending         | API/PDF semantic equivalence, repeated-generation zero mutation, Store isolation, read-only access, safe filenames, injection boundaries, online/offline neutrality, and zero temporary-file residue proven                              |
| S20.6 - API/Data Dictionary and Integrated S20 Closure | CLOSED             | Added generated OpenAPI coverage and exact S20 data semantics, then executed integrated Dashboard/report/search/document/PDF verification                                                                                            | S20.2-S20.5; excludes S21/S22 implementation                                                                                     | Database delta = 0; PostgreSQL remains 28 applied / 0 pending        | Authoritative reconciliation, precision, date/period semantics, pagination, snapshots, RLS/Store isolation, least privilege, read-only behavior, online/offline equivalence, no second accounting engine, and clean code gates proven      |

### S21 - Notifications, Attachments, and Audit Access

- **Status:** CLOSED - S21.1-S21.5 CLOSED.
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
- **Start condition:** S17-S20 are closed. Each implementation stage must satisfy its
  stage-specific product, privacy, database, or storage decision gates before work begins.
- **Closure intent:** Secure, deduplicated support capabilities over stable domains.

S21.1 defines Notifications as Store-scoped in-app operational alerts reconciled from
committed canonical state for the approved debt, credit-limit, stock, supplier-due,
expense-due, subscription-expiry, and backup-failure causes. Notifications use stable
deduplication identity, bounded links to related records, and read/unread and resolution
state. Email, external mobile push, and marketing or messaging channels are not approved
S21 scope. Notification failure must never roll back or duplicate canonical business or
accounting effects. S22 owns the future backup-failure producer.

S21.2 implements owner-focused in-app notification reconciliation over committed canonical
Customer, Supplier, inventory, Expense, and Subscription state. It keeps per-user read state
separate from canonical active/resolved lifecycle, uses stable cause identity and 180-day
resolved-notification retention, permits notification reads/read-state in `read_only`, and
keeps settings writes under the existing business-write authority. Migration `0029` adds the
per-user presentation state and exact customer-debt amount threshold; corrective migration
`0030` replaces only the broken notification update trigger with an `updated_at`-only trigger,
without adding a notification version column or changing the shared generic trigger.
PostgreSQL is 30 applied / 0 pending; PostgreSQL-reference and SQLite deltas are 0. S22 still
owns production of backup-failure notifications.

S21.3 implements a bounded, deterministic, privacy-safe Owner business-audit API over a
narrow sanitized PostgreSQL boundary. Migration `0031` keeps raw central audit private,
allows active Store Owners only, preserves Store isolation and `READ_ONLY` access, and adds
transactional central capture for approved Store Settings and Owner Ledger activity. The
allow-listed view covers Customers, Suppliers, Products and Units, Money Accounts,
Accounting Periods, Sales and corrections, Supplier Invoices, Customer Collections,
Supplier Payments, Expenses and payments, Money Transfers, Sale and Supplier Returns,
Stock Counts, Manual Inventory, Owner Ledger, and Store Settings without exposing raw JSON,
authentication/session data, network metadata, synchronization internals, or Platform Admin
history. Actor and offline-origin attribution remain tied to authoritative business evidence;
corrections remain separate immutable events, and exact replay and rollback create no false
or duplicate business history. Store Settings and Owner Ledger central-audit coverage begins
with migration `0031`; no synthetic historical actor evidence was backfilled. The minimum
business-audit retention remains seven years. Accounting impact and second-ledger creation
are zero. PostgreSQL is 31 applied / 0 pending; PostgreSQL-reference and SQLite deltas are 0.

S21.4 implements Owner-authorized supporting files for Customer, Product, Supplier, and
Expense records only. PostgreSQL owns forced-RLS Store-scoped metadata, while private
S3-compatible object storage owns binary content through a provider-neutral NestJS port;
there is no PostgreSQL binary storage or production local-disk fallback. Original filenames
are sanitized display metadata only, and server-generated object keys and storage internals
are never exposed through the API or Owner audit feed. Uploads accept only validated PDF,
JPEG, and PNG content, are bounded to 10 MiB and 10 active attachments per parent, require a
fail-closed malware scan in production, and compensate or quarantine private orphan objects
when metadata persistence fails.

Migration `0032` adds durable server-controlled logical-removal actor/time evidence, narrow
logical-removal authority, and transactional `ATTACHMENT_ADDED` and `ATTACHMENT_REMOVED`
central-audit capture with sanitized S21.3 Owner mappings. Historical attachment audit
coverage begins with `0032`; no synthetic history was backfilled. Normal reads hide removed
metadata and block removed-binary access immediately. Tombstones are retained for at least
seven years, removed binaries become purge-eligible after 30 days, and unreferenced private
objects become bounded-cleanup candidates after 24 hours. `READ_ONLY` permits authorized
list/download and blocks upload/removal. Archiving a parent does not erase historical
attachments, replacement is a new attachment plus logical removal of the old one, and all
attachment operations have zero accounting, money, receivable, payable, inventory, Expense,
or period impact. PostgreSQL is 32 applied / 0 pending; PostgreSQL-reference and SQLite deltas
are 0.

Audit Access is a bounded, deterministic, owner-facing, privacy-safe view of immutable
business action evidence. Canonical ledgers, movements, postings, and reversal chains remain
the accounting authority. Raw audit JSON, authentication/session/security data, IP or user
agent details, signing or License internals, synchronization provenance/quarantine internals,
and Platform Admin history are not part of the Store-user feed. Existing central audit and
domain records must be reused rather than creating a second audit or accounting ledger.

Reusable foundations include forced Store RLS and transaction-local context, owner and Store
lifecycle authorization, deterministic pagination, `ledger.notifications`,
`ledger.attachments`, immutable `ledger.audit_logs` and `audit.central_audit_logs`, notification
settings, S20 public API conventions, and the S21.2-S21.4 application/Drizzle mappings. Generic
S19 bootstrap/pull does not currently publish these families and is not reopened by S21;
server-side S21 behavior operates on committed canonical state. Runtime retains no direct raw
central-audit access, and attachment lifecycle authority remains narrow and database-enforced.

S21.5 proves the three S21 families remain distinct while operating together across
canonical Customer debt and Collection, Supplier payable and Payment, Expense attachments,
Inventory alerts, offline replay, multiple Owners, `READ_ONLY`, Store lifecycle, privacy,
retention, failure, concurrency, and cross-Store boundaries. S21 support actions create zero
Receivable, Payable, Money, Inventory, Expense, Owner Ledger, or period delta and introduce
no second accounting or audit authority. The final PostgreSQL state is 32 applied / 0
pending with checksum, forced-RLS, least-privilege, residue, and idle-transaction checks
passing.

S22 must protect notification state/settings, immutable central business-audit evidence,
attachment metadata, and approved private binaries together. PostgreSQL-only backup is
insufficient for attachments; restore must verify metadata-to-binary consistency. S22 also
owns the actual backup-failure notification producer. S21 does not design or implement
backup, restore, or recovery.

The real S3-compatible provider smoke test remains unrun because no environment was
available and is an explicit S23 release-readiness item. Bounded dependency triage patched
the S21-reachable Nest/Express multipart and proxy dependencies within compatible releases;
the remaining production advisory is a moderate `@nestjs/swagger`/`js-yaml` path not
exploitable by the current generated-JSON-only OpenAPI usage, with its major-version upgrade
decision deferred to S23.

| Sub-stage | Status | Purpose and in scope | Dependencies and explicit non-scope | Database and storage expectation | Security, accounting, tests, and closure |
| --- | --- | --- | --- | --- | --- |
| S21.1 - Orientation, Scope, and Stage Decomposition | CLOSED | Freeze the three capability definitions, boundaries, reusable foundations, gaps, decision gates, and execution order | S20 closed; no product implementation | Database, reference, SQLite, and code deltas = 0 | Repository and live migration baseline verified; Roadmap is the only changed file |
| S21.2 - In-App Notifications and Lifecycle | CLOSED | Added owner-focused canonical cause reconciliation, stable episode deduplication, per-user read state, bounded APIs, configurable debt thresholds, lifecycle resolution, and retention | Reuses S7 settings, S18 entitlement state, S19 committed canonical state, and S20 links; excludes email, external push, backup execution, and accounting derivation | Migrations `0029` and `0030`; PostgreSQL 30 applied / 0 pending; PostgreSQL-reference and SQLite deltas = 0 | Trigger/reconciliation correctness, replay/concurrency deduplication, Store/user isolation, read-only behavior, lifecycle/retention, least privilege, and zero accounting mutation proven |
| S21.3 - Privacy-Safe Business Audit Access and Capture Hardening | CLOSED | Added bounded Owner business history with trusted actor/action/time context, approved filters, deterministic cursors, and transactional Store Settings and Owner Ledger capture | Reuses immutable central audit and canonical domain history; excludes Platform Admin, auth/security, raw sync, unrestricted logs, and a second ledger | Migration `0031`; PostgreSQL 31 applied / 0 pending; PostgreSQL-reference and SQLite deltas = 0; no synthetic historical backfill | Raw central audit remains private; active Owner-only and Store isolation, offline actor attribution, correction history, replay/rollback safety, privacy exclusions, seven-year retention, and zero accounting mutation proven |
| S21.4 - Secure Attachment Metadata and Binary Access | CLOSED | Added authenticated private upload, list, metadata, download, logical removal, bounded cleanup, and sanitized audit integration for Customer, Product, Supplier, and Expense | Reuses S21.3 audit authority and approved storage/file policy; excludes S20 PDF persistence, generic file drive, mobile picker/queue, S19 sync expansion, and S22 backup | Migration `0032`; private S3-compatible binary authority with PostgreSQL metadata only; PostgreSQL 32 applied / 0 pending; PostgreSQL-reference and SQLite deltas = 0 | File signatures/types/sizes, safe names and keys, fail-closed scanning, concurrent active limit, cross-Store and parent authorization, READ_ONLY behavior, retention/cleanup, lifecycle audit, compensation, and zero accounting mutation proven |
| S21.5 - Integrated Verification and S21 Closure | CLOSED | Reconciled all three families, least privilege, durable-asset inventory, dependency security, and S22/S23 handoffs | S21.2-S21.4 closed; no new product capability or S22 implementation | Database delta = 0; PostgreSQL remains 32 applied / 0 pending; PostgreSQL-reference and SQLite deltas = 0 | Integrated Customer, Supplier, Expense/Attachment, Inventory, offline/replay, multi-owner, READ_ONLY, lifecycle, privacy, retention, failure, concurrency, RLS, accounting-nonmutation, OpenAPI, and full regression gates passed |

### S22 - Backup, Restore, and Recovery

- **Status:** CLOSED - S22.1-S22.5 CLOSED.
- **Purpose:** Create verified, encrypted recovery points and a repeatable disaster-recovery
  path that reconstructs coherent canonical business state without duplicating accounting,
  weakening tenant isolation, or making offline synchronization unsafe.
- **Recovery scope for v1:** Platform-wide database disaster recovery into an isolated
  validation target or empty replacement environment. Live single-Store rollback into a
  shared production database is not supported: the Store's accounting, idempotency, audit,
  sync, notification, attachment, authorization, and platform relationships cannot be safely
  separated by the current architecture.
- **Hard dependencies:** S19 sync/bootstrap and stable S21 schema/contracts.
- **Soft dependencies:** S18 subscription/licensing authority, S21 notification/audit support,
  and the production deployment/provider model.
- **Explicit non-scope:** Business export, Store-downloadable backups, direct restore over an
  active production database, tenant data editing, a second accounting engine, a new sync or
  subscription engine, production secrets in Git, and recovery of client data that never
  reached the server.

#### S22.1 - Recovery Authority and Durable Asset Inventory

| Asset class                 | Recovery authority and classification                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL canonical state  | The complete `platform`, `ledger`, `sync`, and `audit` database state, including migration checksums, roles/grants dependencies, business ledgers, projections, Store/device authority, subscriptions/licenses, notifications, audit history, attachment metadata, idempotency, provenance, recovery lineage, and the commit-ordered change stream, is critical database state. It must be recovered as one coherent database recovery point. |
| Private attachment binaries | S3-compatible private objects are external durable business assets. PostgreSQL metadata, `remote_key`, size, checksum, and removal state authorize and identify them, but do not contain the binary. PostgreSQL-only recovery is incomplete.                                                                                                                                                                                                  |
| Deployment-managed secrets  | Database and object-storage credentials, auth signing secrets, Offline License private/public key material, TLS material, and future backup encryption keys remain in approved secret/key management. They are not plaintext business-backup payloads and require a separate tested recovery process.                                                                                                                                         |
| Reconstructible state       | Application source, migrations, dependency lockfile, and deployment artifacts are reconstructed from reviewed Git/build inputs. Database roles and extensions must be provisioned from approved infrastructure or repository procedures before an isolated restore when the backup format does not include cluster globals.                                                                                                                   |
| Ephemeral and test state    | In-memory notification scheduling, generated bootstrap files under temporary storage, upload buffers, caches, logs, coverage/build output, and test fixtures are not authoritative backup assets. S19 bootstrap is a short-lived delivery artifact, not a server backup.                                                                                                                                                                      |

The baseline contains `ledger.backup_metadata` and `platform.server_backups`, but neither is
used by application or infrastructure code. Both are Store-scoped legacy foundations and do
not currently represent one platform-wide PostgreSQL recovery point plus its attachment
manifest. They are not sufficient recovery-catalog authority without implementation-stage
proof and compatibility review.

| Existing capability                                | Classification          | Evidence and consequence                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL backup                                  | FOUNDATION ONLY         | Migration ledger/checksum verification and two unused metadata tables exist. No `pg_dump`, `pg_restore`, physical-backup, WAL-archive, PITR, scheduler, retention, encryption, integrity, or backup-health implementation exists. The inspected local development server has `archive_mode=off`; that is not a production deployment decision. |
| Restore                                            | MISSING                 | No restore runner, isolated-target validator, recovery fence, cutover gate, recovery-mode flag, or operational restore authorization exists. S19 bootstrap restores a mobile database from committed server state; it does not restore PostgreSQL.                                                                                             |
| Attachment backup                                  | FOUNDATION ONLY         | The private S3-compatible adapter supports conditional put, bounded get/list/delete, AES256 server-side encryption, and SHA-256 verification. Provider versioning, immutable copy/replication, backup destination, manifest, and restore reconciliation are absent.                                                                            |
| Scheduling/background jobs                         | NOT SUITABLE            | The only scheduler is process-local, session-triggered notification reconciliation. Attachment purge methods are callable but unscheduled. Neither provides durable backup-job authority.                                                                                                                                                      |
| Health, notification, audit, and admin foundations | REUSABLE WITH HARDENING | Readiness checks database/auth connectivity; `backup_failure` is an allowed notification type; central audit and Platform Admin authority exist. None currently reports backup freshness, authorizes recovery, or proves restored readiness.                                                                                                   |
| Deployment, Docker, and CI recovery support        | MISSING                 | No tracked Docker, deployment, infrastructure, CI, backup, or restore configuration establishes provider behavior.                                                                                                                                                                                                                             |

#### S22 Recovery Model

- A successful backup is an immutable, identified, encrypted, verified recovery point, not a
  successful file copy. Logical custom-format backup is appropriate for portable verification
  and isolated restore, but alone cannot satisfy a sub-day RPO and does not capture deployment
  secrets or PostgreSQL cluster roles. Physical backup plus continuous WAL/PITR, or an
  equivalent managed-database capability, is the preferred production mechanism when the
  approved RPO requires it. Provider snapshots are complementary only when exportability,
  retention, encryption, and restore drills are proven.
- Repository/application scope owns recovery contracts, artifact identity, integrity checks,
  backup-health semantics, reconciliation, and verification entry points. Production
  infrastructure owns scheduling, database-native backup execution, WAL/provider retention,
  isolated destinations, IAM, encryption keys, and traffic cutover. Exact ownership depends on
  the approved deployment model.
- PostgreSQL and object storage do not share an ACID transaction. S22 therefore requires a
  manifest/checkpoint that binds an immutable database recovery identity and migration level
  to a versioned/checksummed attachment object set and verification result. A quiesced boundary
  or versioned copy window plus post-restore reconciliation may provide coherence; S22 must not
  claim cross-system atomicity.
- Attachment metadata remains authorization authority after recovery. Object existence alone
  never restores access. Removed metadata remains retained for at least seven years, removed
  binaries remain purge-eligible after 30 days, and orphans after 24 hours. Purge must be
  suspended during recovery reconciliation. Selecting a database point before a logical
  removal is an explicit recovery-point rollback risk, not silent object authorization.
- Restore targets are an isolated validation environment, an empty replacement database, or a
  fenced disaster replacement. Production traffic must stop or remain routed away until
  migration/checksum, RLS, role, accounting, sync, attachment, subscription, audit, and health
  gates pass. A partial restore remains unavailable and is recreated/retried from immutable
  backup identity; it is never repaired in place through ad hoc accounting writes.
- Restored PostgreSQL is canonical accounting authority. Verification reconciles ledgers,
  projections, inventory, periods, correction chains, and balances without recalculating or
  rewriting them through a second accounting engine.
- S19 state is non-disposable business-safety state. A rollback can move watermarks backward,
  reuse sequence positions, invalidate representations, lose processed-operation hashes or
  provenance, and make acknowledged client state newer than the server. Ordinary push/pull must
  remain fenced until a recovery generation/epoch, cursor invalidation, operation-history
  policy, and forced-rebootstrap flow are proven. This is a **POTENTIAL DATABASE NEED - MUST BE
  PROVEN IN IMPLEMENTATION STAGE**.
- Restored Subscription, Store lifecycle, License issuance/revocation, and admin history remain
  central authority. Recovery must use current real server time, never move time backward or
  manufacture grace, and must freshly validate/reissue entitlement when required. Device-held
  signed licenses may retain only their already-approved offline validity; recovery does not
  extend it.
- Canonical notification causes and user read state are restored from PostgreSQL, then derived
  causes are reconciled using current time. S22.2 owns the future authoritative backup-health
  failure producer; the existing S21 notification system owns presentation only.

#### S22 Failure Model

| ID  | Failure                                         | Detection and impact                                                                | Authority and safe response                                                           | Alert / owner                                                | Stage             |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------- |
| A   | PostgreSQL unavailable                          | Readiness and backup probes fail; canonical service stops                           | Fence writes; fail over or restore only through database operations                   | Platform critical; generic Owner service notice if prolonged | S22.2/S22.4/S22.5 |
| B   | Logical corruption or operator error            | Invariants, audit, reconciliation, or known incident identifies bad canonical state | Fence; select a verified earlier recovery point; restore in isolation                 | Platform critical; Owner impact after scope is known         | S22.4/S22.5       |
| C   | PostgreSQL backup job fails                     | No completed fresh generation or job terminal failure; RPO degrades                 | Never mark ready; bounded retry and durable failure signal                            | Platform always; Owner semantics are a decision              | S22.2             |
| D   | Database artifact corrupt/incomplete            | Checksum, inventory, or isolated restore validation fails                           | Quarantine generation and use a prior verified point                                  | Platform only                                                | S22.2/S22.5       |
| E   | Object storage unavailable                      | Bounded list/get/copy probes fail; attachments or binary backup unavailable         | Fail closed and do not declare a coherent recovery point                              | Platform; affected Owner notice is policy-driven             | S22.3             |
| F   | Attachment object lost                          | Manifest/key/checksum reconciliation finds absence                                  | Restore the exact protected version; keep access unavailable until verified           | Platform and affected Owner                                  | S22.3/S22.4       |
| G   | Metadata exists, binary missing                 | Reconciliation detects an active metadata reference without matching content        | Restore exact checksum or keep download fail-closed                                   | Platform and affected Owner                                  | S22.3/S22.4       |
| H   | Binary exists, metadata missing                 | Manifest/orphan reconciliation finds unreferenced content                           | Never expose it; quarantine through the recovery window, then apply lifecycle cleanup | Platform only                                                | S22.3/S22.4       |
| I   | Backup destination unavailable                  | Destination write/list/verification fails; no new protected generation              | Fail backup, preserve last verified generation, alert on freshness breach             | Platform; Owner policy decision                              | S22.2/S22.3       |
| J   | Backup credential or encryption key unavailable | IAM/KMS/decryption preflight fails; backup or restore is impossible                 | Stop; recover through approved key custody; never bypass encryption                   | Platform security only                                       | S22.2-S22.5       |
| K   | Restore fails halfway                           | Restore logs or validation fail while target remains fenced                         | Discard/recreate isolated target and retry from immutable identity                    | Platform only                                                | S22.4/S22.5       |
| L   | PostgreSQL restored, attachments incomplete     | Database-to-manifest reconciliation fails                                           | Keep recovery fenced until required binaries and lifecycle checks pass                | Platform; Owner notice after impact is known                 | S22.3-S22.5       |
| M   | S19 cursor/idempotency state unsafe             | Stream generation, bounds, provenance, or replay verification fails                 | Keep sync fenced; invoke approved invalidation/rebootstrap recovery protocol          | Platform and affected Owners                                 | S22.4/S22.5       |
| N   | Wrong recovery point selected                   | Immutable identity/time/environment confirmation disagrees with incident target     | Abort before cutover; require explicit operator confirmation                          | Platform; dual control recommended                           | S22.4             |
| O   | Wrong environment targeted                      | Target fingerprint and environment preflight mismatch                               | Fail before destructive work; never restore over an active authority                  | Platform security only                                       | S22.4             |
| P   | Cross-Store contamination                       | RLS, tenant/FK, counts, or representative cross-Store probes fail                   | Reject target; no live single-Store import; investigate as a security incident        | Platform critical and incident response                      | S22.4/S22.5       |

#### S22 Owner and Deployment Decisions

The backend owner approved the S22.2 platform-wide recovery policy: a 15-minute design RPO,
4-hour design RTO, 7-day production PITR target, 35-day daily logical retention, 12-month
monthly logical retention, a dedicated private backup destination, and Owner-only safe backup
status. These are engineering targets, not customer SLA claims. Production deployment,
restore-operator, provider, IAM, KMS/key-custody, and measured RPO/RTO evidence remain S22.4-S23
gates where applicable.

| Decision                      | Approved S22.2 direction                                                                                                                                                                             | Cost and risk tradeoff                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| RPO                           | 15-minute design target through managed PITR or continuous WAL; achievement is unverified until deployment/S23 evidence                                                                              | Lower RPO increases provider/storage/operations cost; daily logical backup alone cannot satisfy this target.                             |
| RTO                           | 4-hour design target, to be measured in S22.5/S23                                                                                                                                                    | Lower RTO increases automation, standby, staffing, and rehearsal cost.                                                                   |
| Retention/PITR window         | Verified daily logical points for 35 days, monthly points for 12 months, and a 7-day production PITR target                                                                                          | Longer retention increases cost and secret/data exposure; short retention weakens delayed-corruption recovery.                           |
| Deployment model              | Prefer a managed PostgreSQL service with encrypted snapshots and PITR if available; otherwise explicitly fund self-managed base backups, WAL archiving, monitoring, and off-host restore drills      | Managed service reduces operational burden but creates provider dependency; self-managed recovery requires substantially more expertise. |
| Destination/object protection | Use a private, versioned/immutable backup bucket or account separated from the ordinary attachment bucket and runtime IAM; approve replication region/provider as needed                             | Separation limits compromise and deletion blast radius but adds storage and operational cost.                                            |
| Encryption/key custody        | Require provider/KMS or envelope encryption with recoverable, access-logged keys held outside the database and backup bucket                                                                         | Strong separation protects artifacts but key loss makes every backup unrecoverable; custody and rotation must be drilled.                |
| Restore operators             | Limit to designated infrastructure recovery operators; require explicit production target confirmation and preferably two-person approval for cutover                                                | Dual control slows emergency action but materially reduces wrong-target and wrong-point risk.                                            |
| Owner-visible status          | Matching Store Owners, including READ_ONLY, see only generic high-level protection status after the approved freshness threshold; infrastructure details remain hidden                              | Early Owner alerts improve transparency but can cause noise and disclose operational details; silent prolonged failure is unacceptable.  |

#### S22 Delivery Stages

| Stage                                                                  | Purpose, scope, dependencies, and code areas                                                                                                                                                                                                                                                                                                                                                                                                                              | Database/storage expectation and cross-domain impact                                                                                                                                                                                                                                                                                                                 | Security, accounting, tests, decisions, and closure                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S22.1 - Backup, Restore, and Recovery Orientation                      | **CLOSED.** Defined authority, assets, granularity, failure model, consistency problem, decision gates, and stages. No backup, restore, notification producer, or infrastructure implementation. Depends on S19-S21 closure; Roadmap only.                                                                                                                                                                                                                                | Database/reference/SQLite/application/test deltas = 0. PostgreSQL remains 32 applied / 0 pending.                                                                                                                                                                                                                                                                    | Bounded repository/catalog inspection and migration verification only; no broad tests or drill. Closure is this reviewed orientation record.                                                                                                                                                                                                                                                                                                            |
| S22.2 - PostgreSQL Recovery Points, Integrity, and Backup Health       | **CLOSED.** Added PostgreSQL custom-format recovery-point creation, immutable UUID identity, external versioned manifests/catalog, SHA-256 integrity, stored-artifact verification, bounded retention cleanup, isolated restore-smoke, safe Owner status, and S21 `backup_failure` reconciliation. Excludes production restore/cutover and attachment copying.                                                                                                                             | Database delta = 0; PostgreSQL remains 32 applied / 0 pending. The dedicated recovery destination holds encrypted private artifacts and manifests under a controlled namespace; no catalog table, PostgreSQL-reference change, SQLite change, S19 mutation, S18 entitlement mutation, or accounting mutation was introduced.                                                   | Daily retention is 35 days and monthly retention is 12 calendar months. PITR target is 7 days, but provider PITR, the 15-minute RPO, production KMS/IAM, scheduler, and real storage-provider behavior remain unverified deployment/S23 gates. Focused recovery, notification, privacy, full unit, broad integration, migration, role, residue, and isolated PostgreSQL restore checks passed. |
| S22.3 - Attachment Protection, Manifest, and Recovery Consistency      | **CLOSED.** Bound the exact active attachment set to the database recovery point through one exported PostgreSQL snapshot, protected immutable binaries in dedicated recovery storage, and a versioned encrypted companion manifest. Added bounded resume, deep SHA-256 verification, isolated reconstruction smoke, coherent health, and reference-safe retention. Excludes broad restore/cutover and Store access to recovery artifacts.                                          | Database delta = 0; PostgreSQL remains 32 applied / 0 pending. The same `recoveryPointId` correlates the custom database artifact, immutable database manifest, snapshot inventory, protected attachment mappings, and companion manifest. PostgreSQL-reference, SQLite, S18, S19, attachment business lifecycle, and accounting deltas are 0.                    | ACTIVE-at-snapshot completeness, later upload/removal boundaries, REMOVED non-resurrection, missing/corrupt source or protected content, immutable reuse, same-ID mutation rejection, no cross-attachment hash deduplication, crash/restart safety, Owner-safe health, and S21 `backup_failure` integration passed. Real S3-compatible provider, KMS/IAM, versioning/replication, and measured RPO/RTO remain S23 gates. |
| S22.4 - Isolated Restore, Recovery Fencing, and Offline Reconciliation | **CLOSED.** Added restartable isolated restore orchestration, protected-attachment reconstruction, explicit verify/approve/activate gates, Recovery Generation fencing, recovery-aware authentication, stale session/cursor/PUSH rejection, and forced fresh bootstrap. Excludes live single-Store rollback and accounting reconstruction.                                                                                                                                            | Migration `0033` is the sole database evolution; PostgreSQL is 33 applied / 0 pending and migration `0034` does not exist. Forced RLS, narrow definer functions, S19 six-state semantics, PostgreSQL reference, SQLite, and accounting authority remain intact.                                                    | Wrong-target and source-fence guards, login/fence and activation races, rollback residue, isolated restore, attachment reconciliation, RLS, entitlement, cursor/replay, and cross-domain duplicate-effect tests passed. Production infrastructure traffic fencing and the production-like drill remain S22.5/S23 gates.                                                                                       |
| S22.5 - Integrated Disaster-Recovery Drill and S22 Closure             | **CLOSED.** Executed one deterministic two-Store disaster timeline through coherent backup, post-point divergence, transactional fencing, isolated database and attachment restore, verification, activation, stale-authority rejection, fresh bootstrap, and exactly-once post-recovery writes. No new product capability or accounting authority was introduced.                                                                                                                           | Database delta = 0. PostgreSQL remains 33 applied / 0 pending; migration `0033` is immutable, migration `0034` does not exist, and PostgreSQL-reference and SQLite deltas are 0. The database artifact, attachment manifest, protected binaries, and recovery generation remained bound to one verified point.                                                        | Real PostgreSQL accounting, inventory, RLS/FORCE RLS, Store isolation, attachment lifecycle, current-time entitlement, session, cursor, PUSH, replay/conflict, failure-gate, concurrency, cleanup, and full regression evidence passed. The local drill measured a 2.095-second point age/loss window and 25.732-second test drill; production RPO/RTO and real provider controls remain S23 gates.                            |

#### S22.2 Closure Evidence and Handoffs

- Recovery scope is platform-wide v1; live single-Store restore remains unsupported. Daily
  `pg_dump` custom-format artifacts protect coherent `platform`, `ledger`, `sync`, and `audit`
  state, including central Store/device, Subscription/License, notification, attachment
  metadata, audit, migration, and synchronization authority. Cluster roles/globals and secrets
  remain deployment-managed and must be reprovisioned and verified during full restore.
- Only complete `VERIFIED` manifests with matching encrypted artifact metadata count as healthy.
  CREATING and FAILED states remain distinct, corrupt stored artifacts fail SHA-256 verification,
  and the external catalog is rediscoverable after process restart. Filesystem storage is
  test/local only; production requires the separately configured private S3-compatible boundary.
- `GET /v1/backup-status` exposes high-level state only to the matching Store Owner, including
  READ_ONLY Stores. Non-Owners are blocked. Material loss of fresh verified protection produces
  one Store-scoped S21 `backup_failure` episode and recovery resolves it; transient failed
  attempts do not invalidate a still-fresh verified generation.
- The 15-minute RPO and 4-hour RTO remain design targets, not SLAs. Production PITR is
  `UNVERIFIED - DEPLOYMENT/S23 GATE`; the repository does not claim the 15-minute RPO. Real
  provider storage, versioning/Object Lock, IAM, KMS/key custody, scheduling/monitoring, PITR,
  and measured RPO/RTO remain deployment/S23 verification items.
- Central device and Offline License authority is inside the PostgreSQL recovery point. New-phone
  recovery remains same account and Store with a new device identity and fresh S19 bootstrap;
  server backup cannot guarantee unsynchronized phone-only data. Central device revocation is
  enforced where recorded, but an Owner-facing revoke/replace workflow remains a dedicated
  future product enhancement.
- S22.3 binds protected attachment-binary generations to this recovery-point identity,
  manifest version, timestamps, verification state, retention model, and separate storage
  boundary. S22.4 retains isolated/fenced restore, a new recovery generation, cursor safety,
  rebootstrap, replacement-device authorization, and no automatic reauthorization of revoked
  devices. S22.5 completed the integrated local drill; S23 owns production release evidence.

#### S22.3 Closure Evidence and Handoffs

- Database dump and attachment inventory use the same exported `REPEATABLE READ` PostgreSQL
  snapshot and the same S22.2 `recoveryPointId`; arbitrary later live state is never mixed into
  the recovery point. The final version-1 companion manifest is published only after every
  required binary and supporting inventory/entry artifact passes SHA-256 and encryption checks.
- PostgreSQL attachment metadata remains lifecycle authority. Every attachment ACTIVE in the
  snapshot is required, including active attachments on archived parents; REMOVED rows remain in
  the database artifact but do not require or reactivate a binary. Later uploads are excluded,
  while content active at the snapshot remains protected even if removed afterward.
- Protected objects use attachment identity plus SHA-256 in dedicated private recovery storage.
  Unchanged objects are reused across retained recovery points, different attachment IDs never
  deduplicate solely by content hash, and the same attachment ID with different bytes fails as an
  immutability violation. Normal attachment download has no recovery fallback or auto-repair.
- Recovery-point retention remains 35 days for daily points and 12 calendar months. Cleanup is bounded and
  reference-safe across all retained companion manifests; unreferenced protected objects receive
  a 168-hour internal recovery-job grace period. S21 live-object purge remains a separate policy
  and cannot delete the protected recovery copy.
- Backup health now uses the latest coherent database-plus-attachment point and reuses the single
  S21 `backup_failure` episode model. Owner status remains high-level and exposes no manifest,
  object key, provider, Store, or attachment detail.
- Focused deterministic storage/manifest tests and real PostgreSQL snapshot/isolated-restore
  tests passed. PostgreSQL remains 32 applied / 0 pending with no migration `0033`; accounting,
  S18, S19, SQLite, and the PostgreSQL reference remain unchanged.
- S22.4 receives the verified database artifact, companion manifest, protected mappings, digests,
  retention authority, and coherent status. It still owns recovery fencing, new Recovery
  Generation, cursor invalidation, offline replay safety, forced rebootstrap, device continuity,
  and controlled cutover. S23 retains real provider, versioning/replication, IAM/KMS/key-custody,
  PITR, and measured 15-minute RPO / 4-hour RTO verification.

#### S22.4 Closure Evidence and Handoffs

- Recovery-aware login issues the legacy session and validates current recovery authority on the
  same checked-out authentication connection inside one explicit transaction. Validation failure
  rolls back session and device effects. The applied `issue_session_recovery_v1` composite wrapper
  remains a known unusable migration-0033 defect and is deliberately unused by application runtime;
  S23 must retain this item in its final migration audit.
- Recovery execution restores only to a guarded isolated target, reconstructs required protected
  attachment binaries, verifies database and attachment integrity, and separates verification,
  approval, and activation. Activation establishes a new Recovery Generation atomically while the
  source remains fenced; production traffic fencing remains an infrastructure/S23 deployment gate.
- Pre-recovery sessions and refresh, old signed cursors, stale-generation PUSH, pre-cutoff Offline
  Licenses, and ambiguous local operations fail closed or require fresh bootstrap/revalidation.
  S19's six durable outcomes are unchanged, and no stale handler or automatic accounting replay is
  permitted.
- Real PostgreSQL recovery, authentication concurrency, RLS, attachment, synchronization, and
  duplicate-effect verification passed. Full unit passed 1,331 tests and broad integration passed
  900 tests with no skips. PostgreSQL is 33 applied / 0 pending; migration `0033` is immutable,
  migration `0034` does not exist, and PostgreSQL-reference, SQLite, and accounting deltas are zero.
- S22.5 completed the integrated disaster-recovery drill, backend startup against the recovered
  target, local timing measurement, and final S22 closure. S23 retains provider, IAM/KMS,
  production fencing, PITR, authenticated recovery-operator audit integration, and
  release-readiness evidence. Recovery-attempt phases are already immutable and hash-chained, but
  central operator-identity audit evidence is not claimed by S22.4.

#### S22.5 Closure Evidence and Handoffs

- A deterministic two-Store fixture created one fresh, coherent schema-level-33 recovery point
  containing representative Customer, Supplier, Product, period, money, Sale/Receivable,
  Collection, Supplier Invoice/Payable/Payment, Expense/Payment, transfer, inventory,
  Return/Correction, notification, audit, ACTIVE attachment, and REMOVED attachment state.
  Database and attachment manifests, protected binaries, checksums, and migration identity were
  verified before the disaster boundary.
- Post-point divergence covered Sale, Collection, Supplier Payment, Expense/Money, Inventory, and
  Return/Correction effects. Client knowledge covered acknowledged commit, committed response loss,
  local-only work, and a dependent local chain. None was copied into the selected recovery point or
  automatically replayed after cutover.
- A real PostgreSQL in-flight write held the shared recovery lock while fencing requested the
  exclusive lock. The admitted write completed exactly once, the fence then committed without
  deadlock, and later business writes, Offline License issuance, PUSH, and PULL were blocked. The
  old source remained fenced after activation, preserving one writable authority.
- The database and protected attachments restored into an isolated target. Partial restore,
  missing attachment content, and deliberately removed FORCE RLS each blocked verification or
  activation. Target verification now fails when a Store-owned application table lacks both RLS
  and FORCE RLS, excluding only the explicit server-only `platform.admin_actions` and
  `platform.auth_sessions` tables.
- The restored accounting snapshot exactly matched the selected point with zero recovery balancing
  writes and no second accounting engine. Sales/Receivables, Collections/Money,
  Payables/Payments, Expense/Money, Inventory projection, Return/Correction, Owner Ledger, and
  period invariants passed. Cross-Store leakage and removed-attachment resurrection were zero.
- Activation established one new Recovery Generation. Old sessions and refresh authority failed,
  stale cursors required rebootstrap, cursor-ahead claims failed, and stale-generation PUSH reached
  no handler or durable provenance effect. Old Offline Licenses did not gain time, an expired
  Subscription was not revived, and trusted server time remained current.
- Fresh login, bootstrap, generation-bound cursor, Sale, financial operation, and inventory
  operation passed after cutover. Each new business effect occurred exactly once; exact replay
  returned the canonical result and changed material under the same `operationId` produced a
  deterministic conflict.
- The recorded local evidence was: recovery point `2026-10-23T12:48:43.650Z`, simulated disaster
  and recovery start `2026-10-23T12:48:45.745Z`, database restore
  `2026-10-23T12:48:49.508Z`, attachment restore `2026-10-23T12:48:49.903Z`, verification
  `2026-10-23T12:48:51.235Z`, activation `2026-10-23T12:48:52.395Z`, fresh bootstrap
  `2026-10-23T12:48:53.631Z`, and first valid new-generation business operation
  `2026-10-23T12:48:53.733Z`. The observed point-age/loss window was 2.095 seconds, recovery start
  to first valid operation was 7.988 seconds, and the measured local test drill was 25.732 seconds.
  These are local test measurements, not production RPO/RTO evidence.
- Focused recovery and the integrated drill passed; full unit passed 1,331 tests and broad
  integration passed 901 tests with no skips. PostgreSQL is 33 applied / 0 pending with verified
  checksums, no migration `0034`, no test database, binary, lock, or idle-transaction residue, and
  zero PostgreSQL-reference or SQLite delta.

#### S22 Independent Audit Remediation Status

- An independent S22 audit identified two high-severity blockers: recovery did not populate the
  isolated target's operational attachment storage, and several platform mutation families did
  not hold shared recovery authority through their authoritative transaction commit.
- H1 remediation now restores every required ACTIVE protected attachment into separately
  configured isolated operational storage at the metadata-authoritative key and verifies target
  size, SHA-256, and readback before activation. REMOVED attachments remain unavailable, and the
  corrected drill no longer manually seeds the target.
- H2 remediation now acquires the existing PostgreSQL recovery-write authority inside the actual
  mutation transaction for subscription lifecycle, Store provisioning/lifecycle, Platform Admin,
  Offline License revocation, and notification writes. Existing business-write fencing and the
  accounting authority remain unchanged.
- Focused remediation tests, the corrected real-PostgreSQL drill, 1,340 unit tests, and 901 broad
  integration tests passed with no skips. The corrected focused drill observed a 2.145-second
  point-age/loss window and a 26.493-second local drill duration; these are local test measurements,
  not production RPO/RTO evidence.
- Remediation implementation is complete, but independent S22 closure re-review remains required.
  S23 is not started and may not begin from this remediation record.

#### S23 Recovery Handoffs

S23 must preserve and close the remaining deployment and release gates: real managed PostgreSQL
PITR and the seven-day window; production evidence for the 15-minute RPO and 4-hour RTO; real
S3-compatible business attachment and recovery-storage providers; KMS/key custody; IAM least
privilege; object versioning, replication, and Object Lock where configured; production
network/load-balancer fencing; real operator dual control; authenticated recovery operational
audit; Owner lost-device revocation/replacement; the applied-but-unused broken
`issue_session_recovery_v1` wrapper; final PostgreSQL/migration/RLS/Drizzle/SQLite parity; and the
release-candidate schema baseline decision. S23 must not present any skipped provider, RLS,
accounting, synchronization, attachment, or recovery gate as release success.

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
  or partially skipped suites; the reference runtime test must be handled honestly. Run the
  real S3-compatible provider smoke test and reassess the remaining moderate generated-OpenAPI
  `@nestjs/swagger`/`js-yaml` advisory before release.
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

S18 closed as an independent platform branch after S3/S4 and now permits generic sync to
begin after separate approval. S7 and S8 closed as independent foundations in
dependency-correct order. The
remaining graph has no dependency cycle and places no consumer before its required
foundation.

## 13. Deferred and Future-Owned Work

| Deferred capability                    | Reason                                    | Future owner |
| -------------------------------------- | ----------------------------------------- | ------------ |
| Period controls                        | Required before posting                   | S9           |
| Money/owner ledger/opening balances    | Requires accounts and periods             | S10          |
| Inventory/costing/opening stock        | Requires Products, settings, and periods  | S11          |
| Sales/receivables/collections          | Requires inventory, money, and periods    | S14-S15      |
| Expenses                               | Requires money/owner authority            | S16          |
| Generic sync/business-data bootstrap   | Mutation contracts must stabilize         | S19          |
| Reports/search/export/OpenAPI debt     | Requires authoritative domain data        | S20          |
| Notifications/attachments/audit access | Requires stable causes and permissions    | S21          |
| Final release validation               | Requires all capabilities                 | S23          |

The Station 3 sync observation remains owned by S19. Existing non-blocking
machine-readable Customer/OpenAPI documentation debt is assigned to S20 with final
enforcement at S23; this assignment does not reopen S4. No deferred capability is
orphaned.

## 14. Known Legacy and Forward-Migration Risks

| Risk                                | Current legacy state                                                 | Approved target                                       | Future owner        | Required before       | Baseline rewrite |
| ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | ------------------- | --------------------- | ---------------- |
| Invoice close requires full receipt | PostgreSQL decoupled by `0009`; references retain legacy coupling    | Invoice affects payable only                          | S12.1 (closed)      | Complete              | No               |
| Goods receipt creates payable       | PostgreSQL decoupled by `0009`; references retain legacy coupling    | Manual inventory and payable are independent          | S12.1 (closed)      | Complete              | No               |
| Supplier ledger semantics           | `0009` adds invoice-originated payable type                          | Invoice-originated payable and independent settlement | S12.1 (closed)      | Complete              | No               |
| Purchase invoice period context     | `0009` adds the S9 period link and guard                             | Period-controlled supplier posting                    | S12.1 (closed)      | Complete              | No               |
| Unknown inventory cost              | Numeric defaults can be mistaken for known zero                      | Explicit pending/unknown cost                         | S11                 | Costing/opening stock | No               |
| PostgreSQL/SQLite compatibility     | Both references retain legacy receipt coupling                       | Versioned compatible contract                         | S11-S12; verify S19 | Sync exposure         | No               |
| Restore event semantics             | Generic event may say `update` while processed action says `restore` | Sync interprets both without assuming equality        | S19                 | Generic sync          | No               |

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

No roadmap-structure, S18 policy, or S19.2 contract decision is open. The S19.2 backend-owner
decisions freeze bounded creation-time trust with quarantine for insufficient evidence,
historical entitlement eligibility after later Store suspension before device knowledge, and
an initial offline allow-list limited to proven daily operations while sensitive setup and
administration remain online-only. Later Stations may not broaden those boundaries without a
new explicit owner decision.

## 17. Roadmap Maintenance and Approval Rules

- Completed Stations S0-S22 remain historical records and are not renumbered or reopened
  without new concrete blocking evidence and backend-owner approval.
- Future Station S23 remains proposed until the backend owner approves its orientation and
  contract boundary.
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

| Field                               | Current position                                   |
| ----------------------------------- | -------------------------------------------------- |
| Last fully closed Station           | S21 - Notifications, Attachments, and Audit Access |
| S19.4 starting checkpoint           | `139b408c6e2fc367d02604b6af30e3201fe8c65e`         |
| Safe completed capabilities         | S0-S21; S22 remediation implemented                |
| First incomplete release dependency | S22 independent remediation re-review              |
| Current Station                     | S22 RE-REVIEW REQUIRED; S23 NOT STARTED            |
| S18 current status                  | CLOSED                                             |
| S18.1 current status                | CLOSED                                             |
| S18.2 current status                | CLOSED                                             |
| S18.3 current status                | CLOSED                                             |
| S18.4 current status                | CLOSED                                             |
| S18.5 current status                | CLOSED                                             |
| S18.6 current status                | CLOSED                                             |
| S18.7 current status                | CLOSED                                             |
| S19 current status                  | CLOSED                                             |
| S19.1 current status                | CLOSED                                             |
| S19.2 current status                | CLOSED                                             |
| S19.3 current status                | CLOSED                                             |
| S19.4 current status                | CLOSED                                             |
| S19.5 current status                | CLOSED                                             |
| S19.6 current status                | CLOSED                                             |
| S19.7 current status                | CLOSED                                             |
| S19.8 current status                | CLOSED                                             |
| S19.9 current status                | CLOSED                                             |
| S20 current status                  | CLOSED                                             |
| S20.1 current status                | CLOSED                                             |
| S20.2 current status                | CLOSED                                             |
| S20.3 current status                | CLOSED                                             |
| S20.4 current status                | CLOSED                                             |
| S20.5 current status                | CLOSED                                             |
| S20.6 current status                | CLOSED                                             |
| S21 current status                  | CLOSED                                             |
| S21.1 current status                | CLOSED                                             |
| S21.2 current status                | CLOSED                                             |
| S21.3 current status                | CLOSED                                             |
| S21.4 current status                | CLOSED                                             |
| S21.5 current status                | CLOSED                                             |
| S22 current status                  | REMEDIATION IMPLEMENTED / RE-REVIEW REQUIRED       |
| S22.1 current status                | CLOSED                                             |
| S22.2 current status                | CLOSED                                             |
| S22.3 current status                | CLOSED                                             |
| S22.4 current status                | CLOSED                                             |
| S22.5 current status                | CLOSED                                             |
| S23 current status                  | NOT STARTED                                        |

Do not start S23 from this document. It requires a separate orientation and execution prompt.
Database, PostgreSQL-reference, and SQLite deltas remain 0 by default.
