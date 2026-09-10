import { BadRequestException } from '@nestjs/common';

import { parseSupplierPaymentPostingCommand } from './supplier-payment-posting-command';

const ids = {
  supplier: '13330000-0000-4000-8000-000000000001',
  operation: '13330000-0000-4000-8000-000000000002',
  account: '13330000-0000-4000-8000-000000000003',
  invoiceA: '13330000-0000-4000-8000-000000000004',
  invoiceB: '13330000-0000-4000-8000-000000000005',
  opening: '13330000-0000-4000-8000-000000000006',
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: ids.operation,
    paymentSource: 'money_account',
    moneyAccountId: ids.account,
    amountMinor: '500',
    occurredAt: '2026-09-10T10:00:00Z',
    externalReference: 'TRANSFER-1',
    notes: 'Supplier installment',
    allocations: [
      { targetType: 'purchase_invoice', targetId: ids.invoiceA, amountMinor: '300' },
      { targetType: 'opening_payable', targetId: ids.opening, amountMinor: '200' },
    ],
    ...overrides,
  };
}

describe('S13.3 Supplier Payment command', () => {
  it('parses exact bigint money and canonicalizes allocation order', () => {
    const command = parseSupplierPaymentPostingCommand(ids.supplier, request());
    expect(command).toMatchObject({
      operationId: ids.operation,
      supplierId: ids.supplier,
      paymentSource: 'money_account',
      moneyAccountId: ids.account,
      amountMinor: 500n,
      occurredAt: new Date('2026-09-10T10:00:00.000Z'),
    });
    expect(command.allocations).toEqual([
      { targetType: 'opening_payable', targetId: ids.opening, amountMinor: 200n },
      { targetType: 'purchase_invoice', targetId: ids.invoiceA, amountMinor: 300n },
    ]);
  });

  it('hashes semantically identical allocation sets equally regardless of client order', () => {
    const first = parseSupplierPaymentPostingCommand(ids.supplier, request());
    const second = parseSupplierPaymentPostingCommand(
      ids.supplier.toUpperCase(),
      request({
        operationId: ids.operation.toUpperCase(),
        moneyAccountId: ids.account.toUpperCase(),
        allocations: [
          {
            targetType: 'opening_payable',
            targetId: ids.opening.toUpperCase(),
            amountMinor: '200',
          },
          {
            targetType: 'purchase_invoice',
            targetId: ids.invoiceA.toUpperCase(),
            amountMinor: '300',
          },
        ],
      }),
    );
    expect(second.requestHash).toBe(first.requestHash);
  });

  it.each([
    ['under-allocation', { amountMinor: '501' }],
    ['over-allocation', { amountMinor: '499' }],
    [
      'zero payment',
      {
        amountMinor: '0',
        allocations: [{ targetType: 'purchase_invoice', targetId: ids.invoiceA, amountMinor: '1' }],
      },
    ],
    ['negative payment', { amountMinor: '-1' }],
    ['overflow', { amountMinor: '9223372036854775808' }],
    [
      'duplicate target',
      {
        allocations: [
          { targetType: 'purchase_invoice', targetId: ids.invoiceA, amountMinor: '250' },
          { targetType: 'purchase_invoice', targetId: ids.invoiceA, amountMinor: '250' },
        ],
      },
    ],
  ])('rejects %s', (_name, overrides) => {
    expect(() => parseSupplierPaymentPostingCommand(ids.supplier, request(overrides))).toThrow(
      BadRequestException,
    );
  });

  it('requires exactly the source fields authorized by the physical contract', () => {
    expect(() =>
      parseSupplierPaymentPostingCommand(ids.supplier, request({ moneyAccountId: null })),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSupplierPaymentPostingCommand(
        ids.supplier,
        request({ paymentSource: 'owner_pocket', moneyAccountId: ids.account }),
      ),
    ).toThrow(BadRequestException);

    expect(
      parseSupplierPaymentPostingCommand(
        ids.supplier,
        request({ paymentSource: 'owner_pocket', moneyAccountId: null }),
      ),
    ).toMatchObject({ paymentSource: 'owner_pocket', moneyAccountId: null });
  });

  it('preserves exact money above the JavaScript safe integer range', () => {
    const amount = '9007199254740993';
    const command = parseSupplierPaymentPostingCommand(
      ids.supplier,
      request({
        amountMinor: amount,
        allocations: [
          { targetType: 'purchase_invoice', targetId: ids.invoiceB, amountMinor: amount },
        ],
      }),
    );
    expect(command.amountMinor).toBe(9_007_199_254_740_993n);
    expect(command.allocations[0]?.amountMinor).toBe(9_007_199_254_740_993n);
  });
});
