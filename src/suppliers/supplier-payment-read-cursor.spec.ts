import {
  assertSupplierPaymentCursorScope,
  decodeSupplierPaymentCursor,
  encodeSupplierPaymentCursor,
  SUPPLIER_PAYMENT_CURSOR_MAX_DECODED_BYTES,
  SUPPLIER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH,
  supplierPaymentCursorScopeHash,
} from './supplier-payment-read-cursor';
import type { SupplierPaymentTargetFilter } from './supplier-payment-read.types';
import { SupplierReadQueryError } from './supplier-read-query-error';

const supplierId = '81000000-0000-4000-8000-000000000001';
const paymentId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const invoiceTarget: SupplierPaymentTargetFilter = {
  type: 'purchase_invoice',
  id: '81000000-0000-4000-8000-000000000002',
};

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Supplier Payment read cursor', () => {
  it('round-trips fixed state and binds scope to Supplier and target filter', () => {
    const input = {
      scopeHash: supplierPaymentCursorScopeHash(supplierId, invoiceTarget),
      anchor: { id: paymentId, version: 42n },
    };
    const encoded = encodeSupplierPaymentCursor(input);

    expect(decodeSupplierPaymentCursor(encoded)).toEqual(input);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain(supplierId);
    expect(() =>
      assertSupplierPaymentCursorScope(decodeSupplierPaymentCursor(encoded), supplierId, null),
    ).toThrow(SupplierReadQueryError);
    expect(() =>
      assertSupplierPaymentCursorScope(
        decodeSupplierPaymentCursor(encoded),
        supplierId,
        invoiceTarget,
      ),
    ).not.toThrow();
  });

  it('proves the fixed cursor bounds with PostgreSQL bigint maximum state', () => {
    const encoded = encodeSupplierPaymentCursor({
      scopeHash: supplierPaymentCursorScopeHash(supplierId, null),
      anchor: { id: paymentId, version: 9_223_372_036_854_775_807n },
    });

    expect(Buffer.from(encoded, 'base64url')).toHaveLength(
      SUPPLIER_PAYMENT_CURSOR_MAX_DECODED_BYTES,
    );
    expect(encoded).toHaveLength(SUPPLIER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH);
  });

  it.each([
    '',
    'not+base64url',
    'a'.repeat(SUPPLIER_PAYMENT_CURSOR_MAX_ENCODED_LENGTH + 1),
    Buffer.from([0xff]).toString('base64url'),
    encodedPayload({ v: 1 }),
    encodedPayload([2, 'x'.repeat(43), paymentId, '1']),
    encodedPayload([1, 'short', paymentId, '1']),
    encodedPayload([1, 'x'.repeat(43), paymentId.toUpperCase(), '1']),
    encodedPayload([1, 'x'.repeat(43), paymentId, '01']),
    encodedPayload([1, 'x'.repeat(43), paymentId, '9223372036854775808']),
    encodedPayload([1, 'x'.repeat(43), paymentId, '1', 'extra']),
  ])('rejects malformed or ambiguous cursor %#', (encoded) => {
    expect(() => decodeSupplierPaymentCursor(encoded)).toThrow(SupplierReadQueryError);
  });
});
