import { BadRequestException } from '@nestjs/common';

import {
  parseSupplierPaymentCancelCommand,
  parseSupplierPaymentEditCommand,
} from './supplier-payment-correction-command';

const ids = {
  target: 'd1350000-0000-4000-8000-000000000001',
  operation: 'd1350000-0000-4000-8000-000000000002',
  supplier: 'd1350000-0000-4000-8000-000000000003',
  invoice: 'd1350000-0000-4000-8000-000000000004',
  opening: 'd1350000-0000-4000-8000-000000000005',
  account: 'd1350000-0000-4000-8000-000000000006',
};

function editBody(allocations: unknown[]) {
  return {
    operationId: ids.operation,
    occurredAt: '2026-09-20T10:00:00+03:00',
    replacement: {
      supplierId: ids.supplier,
      paymentSource: 'money_account',
      moneyAccountId: ids.account,
      amountMinor: '500',
      occurredAt: '2026-10-01T11:00:00+03:00',
      notes: 'Corrected payment',
      allocations,
    },
  };
}

describe('S13.5 Supplier Payment correction command', () => {
  it('canonicalizes cancellation identity and correction time', () => {
    const command = parseSupplierPaymentCancelCommand(ids.target.toUpperCase(), {
      operationId: ids.operation.toUpperCase(),
      occurredAt: '2026-09-20T10:00:00+03:00',
    });

    expect(command).toMatchObject({
      kind: 'cancel',
      operationId: ids.operation,
      targetOperationId: ids.target,
    });
    expect(command.occurredAt.toISOString()).toBe('2026-09-20T07:00:00.000Z');
  });

  it('uses the posting parser and canonical allocation ordering for replacement identity', () => {
    const invoice = { targetType: 'purchase_invoice', targetId: ids.invoice, amountMinor: '300' };
    const opening = { targetType: 'opening_payable', targetId: ids.opening, amountMinor: '200' };
    const first = parseSupplierPaymentEditCommand(ids.target, editBody([invoice, opening]));
    const second = parseSupplierPaymentEditCommand(ids.target, editBody([opening, invoice]));

    expect(first.requestHash).toBe(second.requestHash);
    expect(first.replacement.allocations.map((allocation) => allocation.targetType)).toEqual([
      'opening_payable',
      'purchase_invoice',
    ]);
    expect(first.replacement.occurredAt.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(first.occurredAt.toISOString()).toBe('2026-09-20T07:00:00.000Z');
  });

  it('fingerprints material correction and replacement changes', () => {
    const allocation = {
      targetType: 'purchase_invoice',
      targetId: ids.invoice,
      amountMinor: '500',
    };
    const original = parseSupplierPaymentEditCommand(ids.target, editBody([allocation]));
    const changed = parseSupplierPaymentEditCommand(ids.target, {
      ...editBody([allocation]),
      occurredAt: '2026-09-21T10:00:00+03:00',
    });
    const changedReplacement = parseSupplierPaymentEditCommand(ids.target, {
      ...editBody([allocation]),
      replacement: { ...editBody([allocation]).replacement, notes: 'Different' },
    });

    expect(changed.requestHash).not.toBe(original.requestHash);
    expect(changedReplacement.requestHash).not.toBe(original.requestHash);
  });

  it('rejects malformed bodies, embedded operation IDs, and invalid allocation totals', () => {
    expect(() =>
      parseSupplierPaymentCancelCommand(ids.target, {
        operationId: ids.operation,
        occurredAt: '2026-09-20T10:00:00Z',
        replacement: {},
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSupplierPaymentEditCommand(ids.target, {
        ...editBody([]),
        replacement: { ...editBody([]).replacement, operationId: ids.operation },
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSupplierPaymentEditCommand(
        ids.target,
        editBody([{ targetType: 'purchase_invoice', targetId: ids.invoice, amountMinor: '499' }]),
      ),
    ).toThrow(BadRequestException);
  });
});
