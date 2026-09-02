# Money Posting Contract v1

## 1. Status and Authority

This document freezes Dokana Station 10 / Task 10.1 for independent review. It is a
backend-owner-approved contract record, not an implementation-status record. Current
implementation status is tracked in the Backend Execution Roadmap and Task records.

The contract is subordinate to current backend-owner decisions, root
[`AGENTS.md`](../../AGENTS.md), the
[approved PRD v1.1](../product/Dokana_PRD_v1.1_APPROVED.md), applied migrations, and the
closed [Accounting Period Contract v1](./accounting-period-v1.md) and
[Store Settings / Operational Time Contract v1](./store-settings-operational-time-v1.md).
The read-only PostgreSQL and SQLite reference package remains **unchanged**: Station 10 adds
**zero** migrations, columns, constraints, indexes, views, RLS policies, grants, functions,
or triggers. All Station 10 invariants below are enforced in application code over the
existing physical schema.

## 2. Scope and Ownership

S10 owns authoritative money posting on top of the closed S8 Money Account catalog and S9
accounting-period authority:

```text
money movements (authoritative facts)
+ derived Money Account balances
+ opening money state
+ owner ledger (equity / liability) events
+ internal transfers
+ same-domain reversal / replacement
```

S10 does **not** own and must not implement: inventory/costing (S11), supplier
invoices/payables (S12), supplier payments (S13), sales/receivables (S14), customer
collections/settlement (S15), expense recognition/payment (S16), cross-domain correction
coordination (S17), generic offline sync (S19), or reporting/dashboards (S20).

## 3. Frozen Decisions (D10-P1 … D10-P15)

### D10-P1 — Money source of truth
`ledger.money_movements` is the **authoritative, append-only** record of Money Account
monetary history. The Money Account balance is a **derived projection**, defined by
`ledger.v_money_account_balances` as `COALESCE(SUM(amount_delta_minor), 0)` per account. No
S10 service may maintain a second mutable monetary balance authority; `money_accounts` has
no balance column and must not gain one.

### D10-P2 — Money representation and the bigint edge
Storage is `bigint` minor units; the domain layer uses bigint-safe integers; the public API
uses exact decimal strings per the existing money contract. JavaScript floating point is
never monetary authority. Because transfers and reversals negate amounts, the valid absolute
posting amount domain **excludes** any value whose signed inverse is unrepresentable — i.e.
the PostgreSQL bigint minimum `-9223372036854775808` and any magnitude `> 9223372036854775807`
are rejected deterministically at validation, before any database arithmetic. Movement amount
deltas are non-zero (existing `CHECK (amount_delta_minor <> 0)`).

### D10-P3 — S10 posting-date policy
For S10 MVP the domain posting date is frozen as:

```text
postingDate = businessDate(occurredAt)   in Asia/Hebron (S7 rule)
```

This is an **S10 domain policy**, not a global redefinition of the distinct concepts
`occurredAt` / `businessDate` / `postingDate` / `accountingPeriodId` (S9 remains globally
authoritative). It exists so the existing physical `occurred_at` + `accounting_period_id`
columns and the existing `ledger.enforce_period_open('occurred_at')` trigger remain valid
**without** a `posting_date` column. Proven equivalence (Asia/Hebron, verified at
local-midnight, spring/autumn DST, year-rollover, and leap-day instants):

```text
period selected from businessDate(occurredAt)  ==  the period whose [starts_at, ends_at)
                                                    half-open UTC range contains occurredAt
```

Because S9 period boundaries are the Store-local month midnights expressed as UTC instants,
`occurredAt ∈ [starts_at, ends_at)` always holds for the period S10 assigns, so
`enforce_period_open('occurred_at')` only effectively enforces `status = 'open'` — exactly
S9 eligibility. The trigger is **not** modified.

### D10-P4 — S9 consumption
Every posting-capable S10 command runs inside the caller business-write transaction and
consumes the closed S9 authority `AccountingPeriodPostingContextService.resolveForWrite` (and
`AccountingPeriodProvisioningService.ensureMonthlyAccountingPeriod`). Canonical order:

```text
trusted Store write-eligibility
-> processed-operation lookup/claim
-> derive postingDate = businessDate(occurredAt)
-> S9 resolveForWrite (provisions/loads canonical period, holds period FOR SHARE)
-> resolve affected Money Account identity/identities
-> lock EVERY affected Money Account row FOR UPDATE
   (single- and multi-account commands alike; multiple accounts in canonical
   order per D10-P13)
-> revalidate account lifecycle/write eligibility and perform all account-dependent
   validation UNDER the lock
-> insert immutable accounting facts
-> build response snapshot
-> complete processed operation
-> commit / rollback
```

The period `FOR SHARE` lock (step 4) is always acquired **before** the Money Account
`FOR UPDATE` locks (step 6); account locks are held until the caller transaction commits
or rolls back. S10 must not reimplement month calculation, period identity, provisioning,
OPEN/CLOSED checks, or close-vs-post locking.

### D10-P4a — Money Account serialization (mandatory for every posting command)
Every new posting-capable S10 command — opening balance, owner contribution, owner loan,
owner reimbursement, owner withdrawal, internal transfer, and any reversal/replacement that
posts a Money Account effect — must acquire an **exclusive `FOR UPDATE` row lock on each
affected `money_accounts` row** (the same row S8 lifecycle locks), then **revalidate account
lifecycle/write eligibility and run all account-dependent validation while the lock is held**,
holding the lock through commit. This is not limited to transfers; single-account commands
lock their one account. "Account-dependent validation" (validation that depends on mutable
account state, and must therefore occur under the lock) includes: account is active/available
for new posting, account belongs to the trusted Store, account type is valid for the command,
**no original opening balance already exists** (D10-P5), `source ≠ destination` and both
accounts remain eligible for a transfer. Account locking exists for lifecycle/invariant
serialization only — it does **not** introduce balance non-negativity (D10-P8). Required
proofs (all via the existing `money_accounts` row lock; no new constraint or lock table):

```text
Opening uniqueness — two distinct overlapping opening operations on account X:
  A locks X FOR UPDATE -> sees no original opening -> inserts opening -> commits
  B waits for X -> acquires after A -> re-checks -> sees the original opening -> rejects
  => at most one success.

Posting-first / archive-second:
  S10 locks X FOR UPDATE -> revalidates eligible -> inserts fact -> commits
  S8 archive waits for X -> acquires after commit -> evaluates archive against the new state
  => no posting occurs after an archive decision made on stale ACTIVE state.

Archive-first / posting-second:
  S8 archive locks X FOR UPDATE -> archives -> commits
  S10 waits for X -> acquires later -> revalidates -> sees archived/unavailable -> rejects
  => no new money fact is posted on a pre-lock ACTIVE read.
```

This serialization is required purely for backend transactional correctness under realistically
overlapping HTTP requests (including retries and foreground/background overlap from the **single
primary MVP device**). It introduces no multi-device architecture, distributed locking, queueing,
conflict-resolution, or S19 sync behavior. It reuses the existing PostgreSQL row lock, the
existing business-write transaction, and the existing S8 lifecycle semantics only. Lock order is
non-cyclic: S10 posting takes period `FOR SHARE` then account `FOR UPDATE`; S8 archive takes only
account `FOR UPDATE`; S9 close takes period `FOR UPDATE` and no account lock — so no transaction
acquires a conflicting pair in reverse order.

### D10-P5 — Opening balance
Opening balance is money already present when Dokana's accounting history begins. It is
represented as a single `money_movements` row with `movement_type = 'opening_balance'` under
the normal S10 posting / S9-eligibility path. It does **not** auto-create owner equity or
liability (pre-Dokana composition is not authoritatively reconstructable). Rules:
at most **one** original opening-balance operation per Money Account, enforced in application
under the account `FOR UPDATE` lock per D10-P4a (the "does an original opening already exist?"
check is an account-dependent validation and must occur after the lock is held — a pre-check
then later insert is unsafe; no new DB constraint); a zero amount creates **no** fact; a posted
opening balance is never edited or deleted; an archived/unavailable account cannot receive a new
opening posting; correction is via the D10-P15 reversal/replacement model.

### D10-P6 — Owner accounting classification
Owner money events are never revenue or expense. Each is represented by `owner_ledger_entries`
(equity/liability deltas), paired with a `money_movements` row when money actually moves,
sharing one transaction group:

| Event | Money Account | Equity Δ | Owner-liability Δ | Revenue | Expense |
|---|---|---|---|---|---|
| Owner contribution (`capital_contribution`) | +X | +X | 0 | no | no |
| Owner loan to store (`owner_loan_to_store`) | +X | 0 | +X | no | no |
| Owner reimbursement / loan repayment (`owner_reimbursement`) | −X | 0 | −X | no | no |
| Owner personal/capital withdrawal (`personal_withdrawal` / `capital_withdrawal`) | −X | −X | 0 | no | no |

Owner liability and equity are derived projections (`ledger.v_owner_position`:
`store_owes_owner_minor = SUM(owner_liability_delta_minor)`,
`owner_equity_movement_minor = SUM(equity_delta_minor)`).

### D10-P7 — Profit withdrawal deferred
The physical `entry_type = 'profit_withdrawal'` remains **dormant**. S10 MVP exposes no
command that lets a caller declare money as "profit," because the server has no authoritative
retained-profit information (sales revenue, COGS, expenses, and corrections are not yet
implemented). The enum value is not removed; future domain authority may activate it.

### D10-P8 — Negative derived balance allowed
A negative derived Money Account balance is a valid auditable projection and is **not** an
S10 posting prohibition (offline-first, delayed/out-of-order future sync, optional missing
opening state, late-arriving facts, preservation of real facts). No mutable overdraft state
and no per-account overdraft configuration is introduced. Consequently balance
non-negativity does not require serializing postings.

### D10-P9 — Business operation vs accounting fact identity
The business command `operationId` is owned by the existing `sync.processed_operations`
infrastructure (Store binding, device binding, canonical request fingerprint, exact replay,
changed-request conflict, in-progress handling, stored response). S10 builds **no** new
idempotency system. One command may produce several immutable facts; command identity is not
fact identity.

### D10-P9a — Deterministic fact-identity contract
Existing per-table `UNIQUE(store_id, operation_id)` is unchanged. Each generated fact
receives deterministic, offline-reproducible identities derived by RFC 4122 UUIDv5:

```text
S10_FACT_NAMESPACE = faafc598-0d3d-5010-a246-0c178972e337
   = uuidv5("dokana:s10:money-fact-identity:v1", RFC4122 URL namespace 6ba7b811-9dad-11d1-80b4-00c04fd430c8)

canonicalCommandOp = lowercase hyphenated business operationId
factId(effect)          = uuidv5(S10_FACT_NAMESPACE, `${canonicalCommandOp}|${discriminator}|id`)
factOperationId(effect) = uuidv5(S10_FACT_NAMESPACE, `${canonicalCommandOp}|${discriminator}|op`)
transaction_group_id    = canonicalCommandOp        (groups all facts of one command)
```

Frozen effect discriminators: `opening`, `owner-money`, `owner-entry`, `transfer-source`,
`transfer-destination`, `transfer-header`, and for a correction the reversing fact of an
original effect `E`: `reversal:${E}` / `replacement:${E}`. Properties: same command+effect →
same identity; different effect or command → different identity; no locale, device-clock, or
random input. Verification vectors (command `7f3a9c2e-1b4d-4a6f-8c0e-2d5b7e9a1c33`):

```text
opening              id=29d91ec3-f470-5698-af7b-0be86931a7ad  op=93c3fabf-9cba-5439-9520-b85d36402106
owner-money          id=4fb42be9-9167-536a-b32b-c52bb1f6673d  op=e19a7e2f-e956-5e06-9a3f-6554371ac1cb
owner-entry          id=cf6bec35-21d0-5d5f-84f8-5b93712b683e  op=d6f8f595-2938-57ba-acbd-9ecc0079d204
transfer-source      id=8afc9b08-3b8e-5240-b560-69821294a154  op=4241cec8-4e2d-5010-8eb6-37ca37d8c9d3
transfer-destination id=45685b8c-4f79-5a4f-b5be-1d0e4c16aea8  op=26a66f60-c2b7-5bdc-83a9-094f59d15466
transfer-header      id=4bff13e7-f520-5287-b0aa-3581510bbc5f  op=07cde60a-d459-5a96-94f2-8762d78f4106
```

### D10-P10 — Immutability (physical + application)
Posted `money_movements` and `owner_ledger_entries` are immutable. This is **already enforced
physically**: the existing triggers `trg_money_movements_no_mutation` and
`trg_owner_ledger_no_mutation` run `ledger.prevent_mutation()` `BEFORE UPDATE OR DELETE` and
raise `55000` ("… is append-only. Create a reversal entry instead."), so any UPDATE/DELETE of a
posted money or owner fact is rejected **regardless of the runtime role's SQL grants**.
Independently of that guard, S10 exposes **no** UPDATE / PATCH / DELETE /
destructive-cancellation path for posted facts. Correction is reversal/replacement (D10-P15).
Narrowing the runtime role's broad `UPDATE`/`DELETE` grant remains optional defense-in-depth
(the trigger already prevents the mutation), not a correctness requirement.

### D10-P11 — Transfer accounting invariant
An internal transfer is one command → one atomic transaction producing a source movement
`−X` and a destination movement `+X` with `X > 0`, `source ≠ destination`, same Store, same
S9 posting context/period, equal absolute amount, net Store money effect `0`, zero revenue,
zero expense. Both accounts must satisfy S8 availability/lifecycle. A transfer never commits
one side only. The existing `money_transfers` header is populated atomically with both
`source_movement_id` and `destination_movement_id` (the nullable columns are never left
unset on a posted transfer).

### D10-P12 — Transfer status immutability
Physical `money_transfers.status` values (`draft`/`posted`/`cancelled`) are not all exposed
as product transitions. A posted transfer is **never** flipped `posted -> cancelled` to erase
its effect; correction is via reversal (D10-P15). No API mutates transfer state to bypass
financial reversal.

### D10-P13 — Canonical account order
A single-account command locks its one account (D10-P4a). When a command affects more than one
Money Account, all accounts are locked in **ascending lowercase canonical UUID string order**,
independent of business source/destination direction, so concurrent `A→B` and `B→A` transfers
acquire the same pair of locks in the same order and cannot form a lock cycle. Canonical
ordering is the multi-account rule; it does **not** mean locking is required only for transfers.

### D10-P14 — Store / account eligibility and replay
Store `active` → new posting allowed; `read_only` → historical reads and exact completed
replay only, no new posting; `suspended`/`archived` → fail closed per existing auth/session
policy. Money Account available/active (S8) may receive new postings; archived/held/
unavailable rejects new postings while historical reads remain. An exact completed-operation
replay returns the stored response and creates **no** new facts (child identities are not
regenerated and re-inserted); changed canonical intent under the same `operationId` is a
deterministic conflict. S10 never silently reactivates an account or Store.

### D10-P15 — Reversal / replacement boundary
Posted S10 facts are corrected by reversal/replacement, never destructive rewrite. The
original fact is preserved; a reversal is a new immutable opposite-economic fact linked via
the existing `reversal_of_id`; a replacement is a new correct fact where the workflow
requires it. The application prevents duplicate reversal of the same original fact (no new DB
uniqueness constraint). Opening-balance correction follows the same model and a
correction-generated replacement is not counted as a second original opening operation
(D10-P5). S10 owns same-domain correction only; **S17** owns cross-domain correction
coordination.

## 4. Owner Withdrawal Limit Policy (resolved from authority)

No approved PRD or contract rule imposes an equity/liability non-negativity gate on owner
withdrawals. S10 therefore freezes only the **accounting classification** (D10-P6) and does
not impose an unsupported "available equity" withdrawal ceiling; a withdrawal is recorded as
an owner drawing fact even if `v_owner_position` becomes negative (consistent with D10-P8 for
money balances). Owner **reimbursement**, however, represents repayment of an actual owner
liability and must be validated by S10.3 against the authoritative outstanding liability
(`store_owes_owner_minor`) under an appropriate serialization; it is not a general withdrawal.

## 5. Security, Offline, and Read Boundaries

Store/user/device identity is taken only from trusted runtime context; request bodies never
carry `storeId`/`tenantId`/role/period/computed balances/derived totals. Forced RLS and
same-Store composite foreign keys are relied upon unchanged. S10 exposes only operational
reads required by its workflows (current balance/history, owner position/history); analytical
reporting is S20. S10 keeps facts offline-safe (stable identities, amounts as decimal
strings, `occurredAt`, resolved `accountingPeriodId`, transaction grouping, reversal linkage,
provenance) but implements no S19 sync mechanism.

## 6. Deferred Defense-in-Depth (non-blocking)

The following are physically desirable but intentionally **deferred** under the frozen-database
directive and are handled by application invariants above; none blocks S10 correctness:
narrowing the runtime role's broad `UPDATE`/`DELETE` grant on the immutable fact tables (already
physically append-only via `prevent_mutation`, so this is pure defense-in-depth); absence of
central-audit (`audit.capture_row_change`) and sync change-event (`sync.capture_change_event`)
triggers on `money_movements`/`owner_ledger_entries`; optional `money_transfers` CHECK hardening
(posted ⇒ both movement links); DB-level duplicate-reversal uniqueness.

Note: posted-fact append-only immutability is **not** deferred — it is already enforced
physically by `trg_money_movements_no_mutation` / `trg_owner_ledger_no_mutation` (D10-P10).
