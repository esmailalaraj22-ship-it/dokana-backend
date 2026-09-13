import { randomUUID } from 'node:crypto';

import {
  assertCustomerReceivableCursorScope,
  assertSaleReadCursorScope,
  CUSTOMER_RECEIVABLE_CURSOR_MAX_ENCODED_LENGTH,
  customerReceivableCursorScopeHash,
  decodeCustomerReceivableCursor,
  decodeSaleReadCursor,
  encodeCustomerReceivableCursor,
  encodeSaleReadCursor,
  SALE_READ_CURSOR_MAX_ENCODED_LENGTH,
  saleReadCursorScopeHash,
} from './sale-read-cursor';
import { SaleReadQueryError } from './sale-read-query-error';

describe('Sale operational read cursors', () => {
  it('round-trips a canonical Sale anchor and verifies its scope', () => {
    const anchor = { id: randomUUID(), version: 9_223_372_036_854_775_807n };
    const encoded = encodeSaleReadCursor({ scopeHash: saleReadCursorScopeHash(), anchor });

    expect(encoded.length).toBeLessThanOrEqual(SALE_READ_CURSOR_MAX_ENCODED_LENGTH);
    const decoded = decodeSaleReadCursor(encoded);
    expect(decoded).toEqual({ scopeHash: saleReadCursorScopeHash(), anchor });
    expect(() => assertSaleReadCursorScope(decoded)).not.toThrow();
  });

  it.each(['', '*', 'a'.repeat(SALE_READ_CURSOR_MAX_ENCODED_LENGTH + 1)])(
    'rejects malformed or over-bound Sale cursor %p',
    (encoded) => {
      expect(() => decodeSaleReadCursor(encoded)).toThrow(SaleReadQueryError);
    },
  );

  it('rejects a noncanonical Sale UUID and an invalid version', () => {
    const id = randomUUID();
    const scope = saleReadCursorScopeHash();
    const uppercase = Buffer.from(JSON.stringify([1, scope, id.toUpperCase(), '1'])).toString(
      'base64url',
    );
    const zeroVersion = Buffer.from(JSON.stringify([1, scope, id, '0'])).toString('base64url');

    expect(() => decodeSaleReadCursor(uppercase)).toThrow(SaleReadQueryError);
    expect(() => decodeSaleReadCursor(zeroVersion)).toThrow(SaleReadQueryError);
  });

  it('rejects a Sale cursor from an unexpected order scope', () => {
    const decoded = decodeSaleReadCursor(
      encodeSaleReadCursor({
        scopeHash: customerReceivableCursorScopeHash(randomUUID()),
        anchor: { id: randomUUID(), version: 1n },
      }),
    );

    expect(() => assertSaleReadCursorScope(decoded)).toThrow(SaleReadQueryError);
  });

  it('round-trips a Customer Receivable anchor and binds it to the Customer', () => {
    const customerId = randomUUID();
    const anchor = { id: randomUUID() };
    const encoded = encodeCustomerReceivableCursor({
      scopeHash: customerReceivableCursorScopeHash(customerId),
      anchor,
    });

    expect(encoded.length).toBeLessThanOrEqual(CUSTOMER_RECEIVABLE_CURSOR_MAX_ENCODED_LENGTH);
    const decoded = decodeCustomerReceivableCursor(encoded);
    expect(decoded).toEqual({
      scopeHash: customerReceivableCursorScopeHash(customerId),
      anchor,
    });
    expect(() => assertCustomerReceivableCursorScope(decoded, customerId)).not.toThrow();
    expect(() => assertCustomerReceivableCursorScope(decoded, randomUUID())).toThrow(
      SaleReadQueryError,
    );
  });

  it.each(['', '=', 'a'.repeat(CUSTOMER_RECEIVABLE_CURSOR_MAX_ENCODED_LENGTH + 1)])(
    'rejects malformed or over-bound Customer Receivable cursor %p',
    (encoded) => {
      expect(() => decodeCustomerReceivableCursor(encoded)).toThrow(SaleReadQueryError);
    },
  );
});
