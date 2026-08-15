import {
  customerCursorMatchesScope,
  decodeCustomerCursor,
  encodeCustomerCursor,
} from './customer-read-cursor';
import {
  CustomerReadQueryError,
  escapeCustomerNamePrefix,
  prepareCustomerSearchScope,
} from './customer-read-query';
import { CustomerNormalizationError } from './customer-normalization';

const position = {
  normalizedName: 'ahmad',
  id: '10000000-0000-4000-8000-000000000001',
};

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Customer read search', () => {
  it.each([undefined, '', '   ', '\u00a0\u2003'])('treats %p as no search', (search) => {
    expect(prepareCustomerSearchScope(search)).toBeNull();
  });

  it('uses Customer normalization v1 for canonical Arabic and Latin name prefixes', () => {
    expect(prepareCustomerSearchScope('  أحمــد  ')).toEqual({
      normalizedNamePrefix: 'احمد',
      canonicalPhone: null,
    });
    expect(prepareCustomerSearchScope('ALIce')).toEqual({
      normalizedNamePrefix: 'alice',
      canonicalPhone: null,
    });
  });

  it('escapes SQL wildcard characters for literal prefix matching', () => {
    expect(escapeCustomerNamePrefix('ali%_\\shop')).toBe('ali\\%\\_\\\\shop');
  });

  it('uses exact canonical phone scope and converges equivalent accepted formats', () => {
    const formatted = prepareCustomerSearchScope('0599 123 456');
    const canonical = prepareCustomerSearchScope('+970599123456');
    const arabicDigits = prepareCustomerSearchScope('٠٥٩٩ ١٢٣ ٤٥٦');

    expect(formatted).toEqual({
      normalizedNamePrefix: '+970599123456',
      canonicalPhone: '+970599123456',
    });
    expect(canonical).toEqual(formatted);
    expect(arabicDigits).toEqual(formatted);
  });

  it('falls back to name search only for expected invalid-phone validation', () => {
    expect(prepareCustomerSearchScope('Alice')).toEqual({
      normalizedNamePrefix: 'alice',
      canonicalPhone: null,
    });
    expect(
      prepareCustomerSearchScope('Alice', () => {
        throw new CustomerNormalizationError('CUSTOMER_PHONE_INVALID');
      }),
    ).toEqual({ normalizedNamePrefix: 'alice', canonicalPhone: null });
  });

  it('does not swallow unexpected phone-normalizer failures', () => {
    const unexpected = new Error('phone metadata unavailable');

    expect(() =>
      prepareCustomerSearchScope('Alice', () => {
        throw unexpected;
      }),
    ).toThrow(unexpected);
  });

  it('rejects a non-whitespace search that has no canonical name', () => {
    try {
      prepareCustomerSearchScope('ـً');
    } catch (error) {
      expect(error).toBeInstanceOf(CustomerReadQueryError);
      expect(error).toMatchObject({ field: 'search', constraint: 'customerSearch' });
      return;
    }

    throw new Error('Expected a Customer search validation error.');
  });
});

describe('Customer read cursor v1', () => {
  const search = {
    normalizedNamePrefix: 'احمد',
    canonicalPhone: null,
  };

  it('round-trips the bounded versioned status, canonical scope, and keyset position', () => {
    const encoded = encodeCustomerCursor({ status: 'active', search, position });

    expect(decodeCustomerCursor(encoded)).toEqual({ status: 'active', search, position });
  });

  it.each([
    ['nil', '00000000-0000-0000-0000-000000000000'],
    ['maximum', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['uppercase', 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'],
  ])('round-trips accepted %s Customer IDs canonically', (_category, id) => {
    const encoded = encodeCustomerCursor({
      status: 'active',
      search,
      position: { ...position, id },
    });

    expect(decodeCustomerCursor(encoded).position.id).toBe(id.toLowerCase());
  });

  it('rejects malformed, oversized, and non-canonical base64url cursors', () => {
    for (const cursor of ['', 'not valid!', 'A'.repeat(2_049), 'e30=']) {
      expect(() => decodeCustomerCursor(cursor)).toThrow(CustomerReadQueryError);
    }
  });

  it('rejects unsupported versions and unexpected cursor fields', () => {
    const base = {
      v: 1,
      status: 'active',
      searchName: null,
      searchPhone: null,
      lastName: 'ahmad',
      lastId: position.id,
    };

    expect(() => decodeCustomerCursor(encodedPayload({ ...base, v: 2 }))).toThrow(
      CustomerReadQueryError,
    );
    expect(() => decodeCustomerCursor(encodedPayload({ ...base, storeId: position.id }))).toThrow(
      CustomerReadQueryError,
    );
  });

  it.each([
    'not-a-uuid',
    '10000000-0000-0000-8000-000000000001',
    '10000000-0000-4000-7000-000000000001',
  ])('rejects a cursor with an unsupported Customer ID value %s', (lastId) => {
    expect(() =>
      decodeCustomerCursor(
        encodedPayload({
          v: 1,
          status: 'active',
          searchName: null,
          searchPhone: null,
          lastName: 'ahmad',
          lastId,
        }),
      ),
    ).toThrow(CustomerReadQueryError);
  });

  it('binds continuation to status and canonical search scope without tenant data', () => {
    const decoded = decodeCustomerCursor(
      encodeCustomerCursor({ status: 'active', search, position }),
    );

    expect(customerCursorMatchesScope(decoded, 'active', search)).toBe(true);
    expect(customerCursorMatchesScope(decoded, 'archived', search)).toBe(false);
    expect(
      customerCursorMatchesScope(decoded, 'active', {
        normalizedNamePrefix: 'محمد',
        canonicalPhone: null,
      }),
    ).toBe(false);
    expect(Buffer.from(encodeCustomerCursor(decoded), 'base64url').toString('utf8')).not.toContain(
      'storeId',
    );
  });
});
