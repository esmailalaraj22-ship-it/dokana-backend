# Supplier Validation and Normalization Contract v1

## 1. Scope

This contract freezes Station 6 / Task 6.2 Supplier field validity, canonicalization, text
safety, persistent-identifier syntax, and validation boundaries. It defines no Supplier API,
read model, search, mutation transaction, lifecycle workflow, accounting operation, inventory
operation, or synchronization workflow.

Task 6.3 owns reads, search, pagination, cursors, and query privacy. Task 6.4 owns create/update
transaction behavior, PATCH omission, optimistic concurrency, operation claims, replay, request
hashes, duplicate-phone conflicts, and legacy null-phone update policy. Task 6.5 owns archive,
restore, and legacy null-phone restore policy.

## 2. Authority

This contract follows, in order:

1. current backend-owner decisions and root `AGENTS.md`;
2. `docs/product/Dokana_PRD_v1.1_APPROVED.md`;
3. `docs/contracts/supplier-database-contract.md`;
4. `docs/customer-normalization-v1.md` and its normative vectors in
   `docs/contracts/customer-normalization-v1.json`;
5. the applied PostgreSQL contract, approved SQLite reference, and reviewed implementation where
   consistent with the higher sources.

Customer normalization-v1 behavior is normative for equivalent Supplier fields. Customer-domain
error names are not part of Supplier behavior and MUST NOT leak through Supplier validation.

## 3. Field Matrix

| Field             | Valid field domain                                                                | Canonical result                                 | Boundary                                       |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `id`              | Established Dokana persistent UUID domain                                         | Lowercase UUID text with the same semantic value | Durable Supplier identity                      |
| `name`            | Required PostgreSQL-safe string whose display and normalized results are nonempty | Clean display name                               | Descriptive, not unique                        |
| `normalizedName`  | Derived and not trusted as authoritative backend input                            | Supplier name normalization-v1 output            | Descriptive search value, not identity         |
| `phone`           | Required non-null valid phone string for every supported new Supplier             | Outer-v1-trimmed display phone                   | Contact and tenant-scoped uniqueness attribute |
| `normalizedPhone` | Derived and not trusted as authoritative backend input                            | Approved Customer phone-v1 E.164 output          | Non-null values are unique per store           |
| `notes`           | Optional PostgreSQL-safe string or explicit `null`                                | Exact supplied string or `null`                  | No normalization                               |
| `operationId`     | Established Dokana operation UUID domain when required by a future mutation       | Lowercase UUID text with the same semantic value | Mutation semantics are deferred to Task 6.4    |

`store_id` and `device_id` are not client-authoritative Supplier fields. Their trusted origin is
defined by the authenticated server context, not by this field matrix.

## 4. Text Safety

Every supplied Supplier text value MUST be a well-formed JavaScript/Unicode string representable
by PostgreSQL `text`. U+0000 and malformed UTF-16, including lone surrogate code units, MUST be
rejected.

Validation MUST NOT silently delete, replace, truncate, or otherwise repair non-representable
text. These safety checks precede persistence and do not change the normalization algorithms
below.

Task 6.2 introduces no field-specific maximum length. Global request-size controls remain a
separate transport concern. Search or cursor representability belongs to Task 6.3 and MUST NOT
silently alter Supplier master data.

## 5. Supplier Display Name

Supplier display-name canonicalization MUST reproduce Customer normalization-v1 exactly:

1. trim outer approved v1 whitespace;
2. collapse each internal run of approved v1 whitespace to one ASCII U+0020 space;
3. preserve every other display character.

The approved v1 whitespace set is exactly:

```text
U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680,
U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000
```

Zero-width characters are not members of this set and MUST NOT be removed as whitespace. Display
canonicalization MUST preserve case, spelling, punctuation, Arabic letter distinctions, Arabic
vocalization, tatweel, digits, and mixed Arabic/Latin content. It MUST NOT apply NFKC.

The canonical display name MUST be nonempty. There is no numeric minimum and no Supplier-specific
maximum. `name` and `normalized_name` MUST NOT be treated as unique Supplier identity.

## 6. Supplier `normalized_name` v1

The normalized name MUST be derived by this ordered pipeline:

1. apply ECMAScript NFKC;
2. trim and collapse the exact v1 whitespace set;
3. apply locale-independent ECMAScript `toLowerCase()`;
4. remove U+0640 ARABIC TATWEEL;
5. remove only U+064B..U+065F and U+0670;
6. fold U+0623, U+0625, U+0622, and U+0671 to U+0627.

The implementation MUST NOT additionally fold U+0629, U+0649, U+0624, or U+0626. It MUST NOT
transliterate Arabic, strip punctuation or digits, remove arbitrary combining marks, remove
zero-width characters, or apply locale-specific case conversion. Punctuation and symbols remain
except where NFKC itself performs a compatibility transformation.

The final normalized value MUST be nonempty. The order above is normative.

## 7. Supplier Phone Requiredness

For every supported new Supplier creation through Dokana, `phone` is REQUIRED by the application
and domain layer. A supported new creation MUST reject an omitted phone, explicit `null`, an empty
string, an approved-v1-whitespace-only string, a malformed phone, and a phone containing an
extension.

Explicit `null` is not a valid supplied phone value. This is field validity, not PATCH policy.
Whether an update may omit phone and preserve an existing or legacy value is DEFERRED to Task 6.4.

## 8. Supplier Phone Normalization-v1

A supplied phone value MUST be a string. Its display value MUST trim only outer approved v1
whitespace and MUST preserve internal formatting and digit forms.

The normalized phone MUST be derived as follows:

1. trim outer approved v1 whitespace;
2. map U+0660..U+0669 to ASCII `0`..`9`;
3. map U+06F0..U+06F9 to ASCII `0`..`9`;
4. leave every other digit system unchanged;
5. parse the complete value with Customer-v1-equivalent behavior using default country `PS` and
   extraction disabled;
6. require successful parsing and valid phone metadata;
7. reject extensions;
8. return the approved parser behavior's E.164 value.

Internal whitespace and separators such as spaces, hyphens, and parentheses MAY be accepted only
when the complete-value parser accepts them. Implementations MUST NOT strip formatting to convert
an otherwise invalid value into a valid one. An explicit international `+` prefix and the approved
`00`-prefix vectors MUST retain Customer-v1 behavior. A Palestinian national leading zero MUST
NOT be removed by custom logic. Explicit country calling codes MUST be respected, and `+970` and
`+972` MUST NOT be rewritten into each other.

There is no Supplier-specific phone-length threshold. Validity is determined by the normative v1
behavior and approved metadata outcomes.

## 9. Normative Customer-v1 Reuse

Supplier name and phone behavior MUST remain semantically equivalent to
`docs/customer-normalization-v1.md` and applicable vectors in
`docs/contracts/customer-normalization-v1.json`.

The current library, helper, and module layout are implementation mechanics, not permanent product
policy. A future implementation MAY wrap existing Customer helpers, use an approved shared helper,
or provide another repository-consistent implementation only when Supplier behavior remains
v1-compatible and Customer behavior remains unchanged.

Phone metadata, Unicode data, runtime, or dependency upgrades MUST pass the normative vectors.
Any canonical-output change requires explicit normalization-contract review and versioning; it
MUST NOT occur as an invisible dependency upgrade.

Supplier validation MUST use Supplier-domain validation categories. Required value, invalid type,
non-representable text, empty display value, empty normalized value, invalid phone, unsupported
extension, and invalid UUID are distinct validation conditions where applicable. Exact HTTP status
codes and response envelopes are not defined here. `CUSTOMER_*` error codes MUST NOT be exposed as
Supplier-domain errors.

## 10. Notes

`notes` is optional at field-value level and MAY be an explicit `null`. A supplied valid string,
including an empty or whitespace-only string, MUST be preserved exactly.

Supplier notes MUST NOT be trimmed, whitespace-collapsed, NFKC-normalized, case-transformed, or
converted from an empty string to `null`. U+0000, malformed UTF-16, and other text not
representable by PostgreSQL MUST be rejected. No Supplier-specific maximum length is introduced.

The meaning of an omitted `notes` field during create or update is DEFERRED to Task 6.4.

## 11. Supplier UUID

Supplier `id` is the durable, client-preservable Supplier identity. Accepted text MUST satisfy the
established Dokana Customer/Product persistent-UUID domain; Task 6.2 introduces no narrower
Supplier-specific UUID subset.

Canonical UUID text MUST be lowercase while preserving the UUID's semantic value. Current
established compatibility includes UUID versions 1 through 8 and the nil and maximum UUID forms;
ordinary version-zero values, malformed values, and unsupported variant forms are invalid.

Phone changes MUST NOT replace the Supplier row or UUID. Phone is not a primary key, foreign-key
identity, accounting identity, payable identity, inventory identity, or historical identity.

## 12. `operationId`

A supplied `operationId` MUST satisfy the established Dokana operation/persistent UUID domain and
MUST canonicalize to lowercase text without changing its semantic value.

Task 6.2 defines syntax only. Operation ownership, tenant-scoped uniqueness handling, claim order,
request hashing, replay, changed-payload conflicts, completed-operation responses, and
`expectedVersion` interaction are DEFERRED to Task 6.4.

## 13. Validation vs Authorization

Validation is not authorization. UUID syntax does not establish membership. Normalization does
not resolve a tenant. A client-supplied `store_id` MUST NOT establish Supplier ownership or
database tenant context.

Authoritative store identity MUST continue to come from trusted authenticated membership and be
installed through the approved transaction-local tenant context. Authoritative device identity
MUST continue to come from the authenticated/session context. Task 6.2 MUST NOT weaken forced RLS,
fail-closed tenant behavior, least-privilege runtime access, or business-write authorization.

## 14. Storage Nullable vs Application Required

The application-required new-Supplier phone rule MUST NOT change storage nullability:

| Layer                           | `phone`              | `normalized_phone`           |
| ------------------------------- | -------------------- | ---------------------------- |
| Application/domain new creation | Required valid phone | Required derived E.164 value |
| PostgreSQL                      | Nullable `text`      | Nullable `text`              |
| Drizzle                         | Nullable             | Nullable                     |
| SQLite                          | Nullable `TEXT`      | Nullable `TEXT`              |

No PostgreSQL `NOT NULL`, SQLite `NOT NULL`, Drizzle non-null assertion, schema rewrite, or baseline
rewrite is authorized by this contract.

## 15. Omitted vs Null vs Empty

Omitted, explicit `null`, empty string, whitespace-only string, and valid value are distinct states.

- A supplied `name` MUST be a non-null string and MUST remain nonempty after both display and
  normalized-name processing.
- New-Supplier phone omission and a supplied null, empty, whitespace-only, malformed, or
  extension-bearing phone are invalid.
- Explicit null, empty, and whitespace-only `notes` are valid and remain distinct.

PATCH omission semantics, mutable-field policy, clear operations, and semantic no-op behavior are
DEFERRED to Task 6.4.

## 16. Legacy NULL-Phone Boundary

Existing rows with null `phone` and/or `normalized_phone` remain storage-permitted legacy states.
They do not authorize null phone for new Supplier creation.

Task 6.2 performs no automatic repair, backfill, fabricated phone, merge, archive, delete, or UUID
rewrite. Legacy null-phone update behavior is DEFERRED to Task 6.4. Legacy null-phone restore
behavior is DEFERRED to Task 6.5. This contract does not require phone repair before an unrelated
update and does not authorize restore without phone.

## 17. Duplicate-Phone Mutation Deferral

One non-null normalized Supplier phone may belong to at most one Supplier row in a store. The same
normalized phone MAY exist in another store. An archived Supplier continues reserving its non-null
normalized phone. There is no global uniqueness, release period, warning-based duplicate,
duplicate override, or automatic reassignment rule.

Database lookup timing, lock and transaction ordering, operation-claim order, duplicate exception
mapping, replay interaction, and transport response are DEFERRED to Task 6.4.

## 18. Lifecycle Deferral

Supplier lifecycle remains `active <-> archived`, preserving the same row and Supplier UUID.
Archive and restore request behavior, optimistic concurrency, lifecycle idempotency, archived
workflow eligibility, and legacy null-phone restore policy are DEFERRED to Task 6.5.

## 19. Offline Determinism

For the same supported logical input, normalization MUST produce the same canonical output
independent of process locale, server locale, timezone, HTTP path, or device. A future offline
implementation MUST reproduce the same ordered rules and normative vectors.

This parity obligation does not modify SQLite, implement Flutter or Drift, define Sync conflict
handling, or grant client output authority. The backend MUST derive authoritative canonical values
for central persistence.

## 20. Database Immutability

Task 6.2 requires no PostgreSQL schema change, migration, SQLite change, Drizzle change, reference
package change, or baseline rewrite. PostgreSQL and SQLite storage semantics from Task 6.1 remain
unchanged.

Supplier validation is master-data validation only. It MUST create no Supplier Invoice, payable,
Supplier Payment, expense, journal, money movement, Goods Receipt, inventory movement, stock,
costing, or COGS effect.

## 21. Future Implementation Verification Gates

Future Task 6.2 implementation and tests MUST prove:

1. exact display-name trimming, internal whitespace collapse, and closed whitespace membership;
2. zero-width, case, punctuation, Arabic distinction, diacritic, tatweel, digit, and mixed-script
   preservation in display names;
3. exact ordered NFKC, lowercase, tatweel removal, closed diacritic removal, and Alef folding for
   `normalized_name`, including no additional Arabic folding;
4. empty display and normalized-name rejection and PostgreSQL text-safety rejection;
5. missing, null, blank, whitespace-only, malformed, and extension phone rejection for supported
   new Supplier creation;
6. exact approved digit mapping, `PS` default, complete-value parsing, extraction disabled,
   validity checking, explicit international and approved `00` behavior, no custom `+970`/`+972`
   rewrite, and E.164 output;
7. semantic equivalence with every applicable Customer-v1 normative golden vector while exposing
   only Supplier-domain validation errors;
8. notes nullability and exact preservation of empty, whitespace-only, and other valid text;
9. U+0000 and malformed UTF-16 rejection for relevant Supplier text;
10. Supplier UUID and `operationId` validation and lowercase canonical text without changing
    semantic values;
11. validation remaining separate from authorization and trusted tenant/device derivation;
12. PostgreSQL, SQLite, Drizzle, Customer normalization, migrations, and reference packages
    remaining unchanged;
13. no Task 6.3 read/search behavior, Task 6.4 mutation behavior, or Task 6.5 lifecycle behavior;
14. no accounting, payable, payment, inventory, receipt, stock, or costing side effects.
