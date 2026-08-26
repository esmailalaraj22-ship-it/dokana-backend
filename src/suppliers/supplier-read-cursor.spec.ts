import {
  assertSupplierCursorScope,
  decodeSupplierCursor,
  encodeSupplierCursor,
  SUPPLIER_CURSOR_MAX_DECODED_BYTES,
  SUPPLIER_CURSOR_MAX_ENCODED_LENGTH,
  supplierCursorScopeHash,
} from './supplier-read-cursor';
import { SupplierReadQueryError } from './supplier-read-query-error';
import type { SupplierSearchScope } from './supplier-read.types';

const maximumSupplierId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const search: SupplierSearchScope = {
  normalizedNamePrefix: 'supplier',
  canonicalPhone: '+970599123456',
};

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Supplier read cursor', () => {
  it('encodes deterministically and round-trips fixed privacy-safe state', () => {
    const input = {
      scopeHash: supplierCursorScopeHash('active', search),
      anchor: { id: maximumSupplierId, version: 42n },
    };

    const encoded = encodeSupplierCursor(input);
    expect(encodeSupplierCursor(input)).toBe(encoded);
    expect(decodeSupplierCursor(encoded)).toEqual(input);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain(search.canonicalPhone);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain(
      search.normalizedNamePrefix,
    );
  });

  it('proves the independently derived fixed cursor envelope', () => {
    const encoded = encodeSupplierCursor({
      scopeHash: supplierCursorScopeHash('archived', search),
      anchor: { id: maximumSupplierId, version: 9_223_372_036_854_775_807n },
    });

    expect(Buffer.from(encoded, 'base64url')).toHaveLength(SUPPLIER_CURSOR_MAX_DECODED_BYTES);
    expect(encoded).toHaveLength(SUPPLIER_CURSOR_MAX_ENCODED_LENGTH);
  });

  it('binds status, normalized name, canonical phone, and ordering version to scope', () => {
    const cursor = decodeSupplierCursor(
      encodeSupplierCursor({
        scopeHash: supplierCursorScopeHash('active', search),
        anchor: { id: maximumSupplierId, version: 1n },
      }),
    );

    expect(() => assertSupplierCursorScope(cursor, 'active', search)).not.toThrow();
    expect(() => assertSupplierCursorScope(cursor, 'archived', search)).toThrow(
      SupplierReadQueryError,
    );
    expect(() =>
      assertSupplierCursorScope(cursor, 'active', { ...search, canonicalPhone: null }),
    ).toThrow(SupplierReadQueryError);
    expect(() =>
      assertSupplierCursorScope(cursor, 'active', {
        ...search,
        canonicalPhone: '+972502345678',
      }),
    ).toThrow(SupplierReadQueryError);
    expect(() =>
      assertSupplierCursorScope(cursor, 'active', {
        ...search,
        normalizedNamePrefix: 'other',
      }),
    ).toThrow(SupplierReadQueryError);
  });

  it.each([
    '',
    'not+base64url',
    'a'.repeat(SUPPLIER_CURSOR_MAX_ENCODED_LENGTH + 1),
    Buffer.from([0xff]).toString('base64url'),
    encodedPayload({ v: 1 }),
    encodedPayload([2, 'x'.repeat(43), maximumSupplierId, '1']),
    encodedPayload([1, 'short', maximumSupplierId, '1']),
    encodedPayload([1, 'x'.repeat(43), maximumSupplierId.toUpperCase(), '1']),
    encodedPayload([1, 'x'.repeat(43), maximumSupplierId, '01']),
    encodedPayload([1, 'x'.repeat(43), maximumSupplierId, '9223372036854775808']),
    encodedPayload([1, 'x'.repeat(43), maximumSupplierId, '1', 'extra']),
  ])('rejects malformed or ambiguous cursor %#', (encoded) => {
    expect(() => decodeSupplierCursor(encoded)).toThrow(SupplierReadQueryError);
  });

  it('rejects invalid encoder state', () => {
    expect(() =>
      encodeSupplierCursor({
        scopeHash: 'invalid',
        anchor: { id: maximumSupplierId, version: 1n },
      }),
    ).toThrow(TypeError);
    expect(() =>
      encodeSupplierCursor({
        scopeHash: supplierCursorScopeHash('active', null),
        anchor: { id: maximumSupplierId, version: 0n },
      }),
    ).toThrow(SupplierReadQueryError);
  });
});
