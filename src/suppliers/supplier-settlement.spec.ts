import { deriveSupplierSettlement } from './supplier-settlement';

describe('Supplier settlement derivation', () => {
  it.each([
    [500n, 0n, 0n, 500n, 'UNPAID'],
    [500n, 200n, 200n, 300n, 'PARTIALLY_PAID'],
    [500n, 500n, 500n, 0n, 'PAID'],
    [0n, 0n, 0n, 0n, null],
    [9_223_372_036_854_775_807n, 1n, 1n, 9_223_372_036_854_775_806n, 'PARTIALLY_PAID'],
  ] as const)(
    'derives obligation %s with active allocation %s',
    (obligation, allocated, paid, outstanding, state) => {
      expect(deriveSupplierSettlement(obligation, allocated)).toEqual({
        paidAmountMinor: paid,
        outstandingMinor: outstanding,
        settlementState: state,
      });
    },
  );

  it.each([
    [-1n, 0n],
    [1n, -1n],
    [1n, 2n],
  ])('rejects inconsistent obligation %s and allocation %s', (obligation, allocated) => {
    expect(() => deriveSupplierSettlement(obligation, allocated)).toThrow(
      'Supplier settlement facts are inconsistent.',
    );
  });
});
