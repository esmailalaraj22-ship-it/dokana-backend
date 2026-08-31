# Money Account Station 8 Physical Foundation v1

This record documents Station 8 / Task 8.2 only. It adds the application mapping
and domain foundation over the existing `ledger.money_accounts` table. It does
not add APIs, repositories, mutations, Cash provisioning, balance reads, money
movements, transfers, opening balances, or posting behavior.

## Physical Mapping

`src/database/schema/ledger.ts` maps all fourteen existing columns exactly:
UUID identity and Store ownership, display and normalized names, physical type
and availability values, default and lifecycle state, archive timestamp,
device/operation provenance, timestamps, and lossless `bigint` version.

The mapping preserves the three Store-scoped unique constraints, both tenant-safe
foreign keys, all seven checks, and the partial unique index allowing only one
active physical Cash row per Store. The table remains forced-RLS protected and
hard-delete protected by the existing database policy and triggers. There is no
physical balance column.

No PostgreSQL or SQLite object changed. The applied schema and both approved
references already support the frozen S8 contract, so Task 8.2 requires no
migration.

## Domain Separation

Physical compatibility values remain representable:

- account types: `cash`, `transfer`, `external_party`;
- availability: `available`, `held_by_external_party`;
- lifecycle: `active`, `archived`.

Current MVP user creation is narrower: only `transfer`, always `available`, and
never default. The only user-authored Money Account profile field is `name`.
Every other physical field is controlled by the database, trusted application
workflow, or synchronization protocol and must not become generic form input.

The permanent system Cash identity is defined once as `SYSTEM_CASH_MONEY_ACCOUNT`:
name `الصندوق`, type `cash`, availability `available`, and `isDefault = true`.
Task 8.2 defines this identity but does not provision it.

## Name Normalization v1

`normalizeMoneyAccountNameV1` is an explicit, versioned identity algorithm:

1. require PostgreSQL-representable Unicode text;
2. normalize with Unicode NFKC;
3. apply ECMAScript `toLowerCase()`, the supported deterministic and
   locale-independent runtime equivalent to default case folding;
4. collapse the explicit Unicode White_Space code-point set to ordinary ASCII
   spaces and remove leading/trailing whitespace runs;
5. reject an empty normalized identity.

The algorithm performs no transliteration, Arabic-letter folding, diacritic or
tatweel removal, punctuation or digit removal, zero-width removal, fuzzy match,
or database-collation-dependent transformation. Test vectors make the contract
reproducible for a future Dart/SQLite implementation. No arbitrary maximum name
length is introduced because the approved physical `text` contract defines none.

## S8 / S10 Boundary

Task 8.2 maps Money Account identity, catalog metadata, and lifecycle storage
only. The existing `ledger.v_money_account_balances` remains a security-invoker
view derived from `ledger.money_movements`; it is inspected only as boundary
evidence and is not mapped or consumed here. Money movements, authoritative
balance projection, transfers, opening balances, and owner funding remain S10.

S8.3 reads and S8.4 mutation/lifecycle workflows are not started by this Task.
