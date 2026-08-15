import {
  assertCustomerNormalizedNameCursorRepresentable,
  assertCustomerSearchCursorRepresentable,
  CUSTOMER_CURSOR_NORMALIZED_NAME_JSON_BYTE_BUDGET,
  CUSTOMER_CURSOR_SEARCH_NAME_JSON_BYTE_BUDGET,
  CustomerCursorRepresentabilityError,
  customerCursorJsonStringContentByteLength,
} from './customer-cursor-representability';
import {
  CUSTOMER_CURSOR_MAX_DECODED_BYTES,
  CUSTOMER_CURSOR_MAX_ENCODED_LENGTH,
  decodeCustomerCursor,
  encodeCustomerCursor,
} from './customer-read-cursor';
import { normalizeCustomerName } from './customer-normalization';

const maximumCustomerId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maximumCanonicalPhone = '+123456789012345';
const maximumNormalizedName = 'n'.repeat(CUSTOMER_CURSOR_NORMALIZED_NAME_JSON_BYTE_BUDGET);
const maximumSearchName = 's'.repeat(CUSTOMER_CURSOR_SEARCH_NAME_JSON_BYTE_BUDGET);

describe('Customer cursor representability budget', () => {
  it('fills and round-trips the complete production envelope at both exact limits', () => {
    const cursor = encodeCustomerCursor({
      status: 'archived',
      search: {
        normalizedNamePrefix: maximumSearchName,
        canonicalPhone: maximumCanonicalPhone,
      },
      position: { normalizedName: maximumNormalizedName, id: maximumCustomerId },
    });

    expect(Buffer.from(cursor, 'base64url')).toHaveLength(CUSTOMER_CURSOR_MAX_DECODED_BYTES);
    expect(cursor).toHaveLength(CUSTOMER_CURSOR_MAX_ENCODED_LENGTH);
    expect(decodeCustomerCursor(cursor)).toEqual({
      status: 'archived',
      search: {
        normalizedNamePrefix: maximumSearchName,
        canonicalPhone: maximumCanonicalPhone,
      },
      position: { normalizedName: maximumNormalizedName, id: maximumCustomerId },
    });
  });

  it('rejects the nearest one-byte overflow through the production encoder and helpers', () => {
    expect(() =>
      encodeCustomerCursor({
        status: 'archived',
        search: {
          normalizedNamePrefix: maximumSearchName,
          canonicalPhone: maximumCanonicalPhone,
        },
        position: { normalizedName: `${maximumNormalizedName}n`, id: maximumCustomerId },
      }),
    ).toThrow('Customer cursor payload exceeds the supported bound.');
    expect(() =>
      encodeCustomerCursor({
        status: 'archived',
        search: {
          normalizedNamePrefix: `${maximumSearchName}s`,
          canonicalPhone: maximumCanonicalPhone,
        },
        position: { normalizedName: maximumNormalizedName, id: maximumCustomerId },
      }),
    ).toThrow('Customer cursor payload exceeds the supported bound.');
    expect(() =>
      assertCustomerNormalizedNameCursorRepresentable(`${maximumNormalizedName}n`),
    ).toThrow(CustomerCursorRepresentabilityError);
    expect(() =>
      assertCustomerSearchCursorRepresentable({
        normalizedNamePrefix: `${maximumSearchName}s`,
        canonicalPhone: null,
      }),
    ).toThrow(CustomerCursorRepresentabilityError);
  });

  it.each([
    ['ASCII', 'a'.repeat(699)],
    ['Arabic', '\u0639'.repeat(349) + 'a'],
    ['mixed Arabic and Latin', '\u0639'.repeat(200) + 'a'.repeat(299)],
    ['supplementary Unicode', '\u{1f600}'.repeat(174) + 'aaa'],
    ['NFKC expansion', '\ufdfa'.repeat(21) + 'a'.repeat(6)],
    ['JSON quotes', '"'.repeat(349) + 'a'],
    ['JSON backslashes', '\\'.repeat(349) + 'a'],
    ['JSON control escapes', '\u0001'.repeat(116) + 'aaa'],
  ])('accepts an exact-budget normalized %s value using serialized UTF-8 bytes', (_case, raw) => {
    const normalized = normalizeCustomerName(raw);

    expect(customerCursorJsonStringContentByteLength(normalized)).toBe(
      CUSTOMER_CURSOR_NORMALIZED_NAME_JSON_BYTE_BUDGET,
    );
    expect(() => assertCustomerNormalizedNameCursorRepresentable(normalized)).not.toThrow();
  });

  it('validates the exact structured search scope against a maximum Customer position', () => {
    expect(() =>
      assertCustomerSearchCursorRepresentable({
        normalizedNamePrefix: maximumSearchName,
        canonicalPhone: maximumCanonicalPhone,
      }),
    ).not.toThrow();
  });
});
