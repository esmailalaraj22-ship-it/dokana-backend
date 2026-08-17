import {
  assertProductCursorScope,
  decodeProductCursor,
  encodeProductCursor,
  PRODUCT_CURSOR_MAX_DECODED_BYTES,
  PRODUCT_CURSOR_MAX_ENCODED_LENGTH,
  productCursorScopeHash,
} from './product-read-cursor';
import { ProductReadQueryError } from './product-read-query-error';
import type { ProductSearchScope } from './product-read.types';

const maximumProductId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const search: ProductSearchScope = {
  normalizedNamePrefix: 'زيت',
  canonicalSku: 'Oil-001',
  canonicalBarcode: '001234',
};

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Product read cursor', () => {
  it('encodes deterministically and round-trips the fixed cursor state', () => {
    const input = {
      scopeHash: productCursorScopeHash('active', search),
      anchor: { id: maximumProductId, version: 42n },
    };
    const first = encodeProductCursor(input);
    const second = encodeProductCursor(input);

    expect(first).toBe(second);
    expect(decodeProductCursor(first)).toEqual(input);
  });

  it('proves the independently derived maximum envelope', () => {
    const encoded = encodeProductCursor({
      scopeHash: productCursorScopeHash('archived', search),
      anchor: { id: maximumProductId, version: 9_223_372_036_854_775_807n },
    });

    expect(Buffer.from(encoded, 'base64url')).toHaveLength(PRODUCT_CURSOR_MAX_DECODED_BYTES);
    expect(encoded).toHaveLength(PRODUCT_CURSOR_MAX_ENCODED_LENGTH);
  });

  it('binds status, canonical search, and ordering version into query scope', () => {
    const cursor = decodeProductCursor(
      encodeProductCursor({
        scopeHash: productCursorScopeHash('active', search),
        anchor: { id: maximumProductId, version: 1n },
      }),
    );

    expect(() => assertProductCursorScope(cursor, 'active', search)).not.toThrow();
    expect(() => assertProductCursorScope(cursor, 'archived', search)).toThrow(
      ProductReadQueryError,
    );
    expect(() =>
      assertProductCursorScope(cursor, 'active', { ...search, canonicalSku: 'oil-001' }),
    ).toThrow(ProductReadQueryError);
  });

  it.each([
    '',
    'not+base64url',
    'a'.repeat(PRODUCT_CURSOR_MAX_ENCODED_LENGTH + 1),
    Buffer.from([0xff]).toString('base64url'),
    encodedPayload({ v: 1 }),
    encodedPayload([2, 'x'.repeat(43), maximumProductId, '1']),
    encodedPayload([1, 'short', maximumProductId, '1']),
    encodedPayload([1, 'x'.repeat(43), maximumProductId.toUpperCase(), '1']),
    encodedPayload([1, 'x'.repeat(43), maximumProductId, '01']),
    encodedPayload([1, 'x'.repeat(43), maximumProductId, '9223372036854775808']),
    encodedPayload([1, 'x'.repeat(43), maximumProductId, '1', 'extra']),
  ])('rejects malformed or ambiguous cursor %#', (encoded) => {
    expect(() => decodeProductCursor(encoded)).toThrow(ProductReadQueryError);
  });

  it('rejects invalid encoder state rather than producing an ambiguous cursor', () => {
    expect(() =>
      encodeProductCursor({
        scopeHash: 'invalid',
        anchor: { id: maximumProductId, version: 1n },
      }),
    ).toThrow(TypeError);
    expect(() =>
      encodeProductCursor({
        scopeHash: productCursorScopeHash('active', null),
        anchor: { id: maximumProductId, version: 0n },
      }),
    ).toThrow(ProductReadQueryError);
  });
});
