# Customer Normalization Contract v1

`CUSTOMER_NORMALIZATION_VERSION` is `1`. The implementation is the pure,
framework-independent utility in `src/customers/customer-normalization.ts`.
The normative cross-platform examples are the static JSON vectors in
`docs/contracts/customer-normalization-v1.json`.

## Whitespace

Version 1 recognizes exactly these whitespace code points:

```text
U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680,
U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000
```

Zero-width characters such as ZWJ and ZWNJ are not whitespace in this
contract.

## Names

The display name trims outer v1 whitespace and collapses internal runs to one
ASCII space. It otherwise preserves spelling, punctuation, case, tashkeel, and
tatweel.

The canonical search name applies these operations in order:

1. NFKC using the Node/ECMAScript runtime.
2. V1 whitespace trimming and collapsing.
3. Locale-independent ECMAScript `toLowerCase()`.
4. Removal of U+0640 Arabic tatweel.
5. Removal of U+064B..U+065F and U+0670 only.
6. Folding of `أ`, `إ`, `آ`, and `ٱ` to `ا`.

The letters `ة`, `ى`, `ؤ`, and `ئ`, punctuation, symbols, and combining marks
outside the closed removal set remain unchanged. Canonical names are not
unique Customer identities.

## Phones

The display phone trims only outer v1 whitespace and preserves all internal
formatting and digit forms. Canonical parsing first maps U+0660..U+0669 and
U+06F0..U+06F9 to ASCII digits. Other digit systems are not mapped.

Canonical phone parsing uses `libphonenumber-js/max` with `PS` as the default
region and `extract: false`. The complete value must parse and pass `isValid()`;
mobile and fixed-line numbers are both allowed. Explicit international calling
codes are respected, `+970` and `+972` are never rewritten into each other, and
accepted output is the library-produced E.164 value. Extensions are rejected.
The v1 vectors record that the library accepts the PS international dialing
prefix `00` for the covered case without custom rewriting.

The mobile implementation must reproduce this order, the closed code-point
sets, and every static vector. Phone metadata and Unicode behavior can change
between dependency/runtime versions, so upgrades must keep the vectors passing
or receive an explicit normalization-contract review. This repository does not
implement Dart/mobile normalization in Task 4.3.1.

## Validation Errors

Expected input failures use `CustomerNormalizationError` with one of these
stable machine-readable codes:

```text
CUSTOMER_DISPLAY_NAME_EMPTY
CUSTOMER_NORMALIZED_NAME_EMPTY
CUSTOMER_DISPLAY_PHONE_EMPTY
CUSTOMER_PHONE_EMPTY
CUSTOMER_PHONE_INVALID
CUSTOMER_PHONE_EXTENSION_UNSUPPORTED
```

These are domain-local validation categories. They do not define HTTP status
codes or response envelopes.
