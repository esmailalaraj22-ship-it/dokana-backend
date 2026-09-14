import {
  assertCustomerPaymentCursorScope,
  customerPaymentCursorScopeHash,
  decodeCustomerPaymentCursor,
  encodeCustomerPaymentCursor,
} from './customer-payment-read-cursor';

const customerId = '15330000-0000-4000-8000-000000000001';
const paymentId = 'abcdef00-0000-4000-8000-000000000002';

describe('S15.3 Customer Payment cursor', () => {
  it('round-trips the immutable ID/version anchor', () => {
    const encoded = encodeCustomerPaymentCursor({
      scopeHash: customerPaymentCursorScopeHash(customerId),
      anchor: { id: paymentId, version: 2n },
    });
    expect(decodeCustomerPaymentCursor(encoded)).toEqual({
      scopeHash: customerPaymentCursorScopeHash(customerId),
      anchor: { id: paymentId, version: 2n },
    });
  });

  it('rejects malformed and non-canonical cursors', () => {
    expect(() => decodeCustomerPaymentCursor('not+base64url')).toThrow();
    expect(() =>
      decodeCustomerPaymentCursor(
        Buffer.from(
          JSON.stringify([
            1,
            customerPaymentCursorScopeHash(customerId),
            paymentId.toUpperCase(),
            '2',
          ]),
        ).toString('base64url'),
      ),
    ).toThrow();
  });

  it('binds the cursor to one Customer scope', () => {
    const cursor = decodeCustomerPaymentCursor(
      encodeCustomerPaymentCursor({
        scopeHash: customerPaymentCursorScopeHash(customerId),
        anchor: { id: paymentId, version: 2n },
      }),
    );
    expect(() => assertCustomerPaymentCursorScope(cursor, paymentId)).toThrow();
  });
});
