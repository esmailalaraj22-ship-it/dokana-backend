import { BadRequestException } from '@nestjs/common';

import {
  parseSupplierInvoiceCancelCommand,
  parseSupplierInvoiceEditCommand,
  parseSupplierOpeningPayableCancelCommand,
  parseSupplierOpeningPayableEditCommand,
} from './supplier-invoice-correction-command';

const ids = {
  target: 'a2400000-0000-4000-8000-000000000001',
  operation: 'a2400000-0000-4000-8000-000000000002',
  supplier: 'a2400000-0000-4000-8000-000000000003',
  product: 'a2400000-0000-4000-8000-000000000004',
  unit: 'a2400000-0000-4000-8000-000000000005',
};
const occurredAt = '2026-08-05T10:00:00Z';
const replacement = {
  supplierId: ids.supplier,
  invoiceNumber: 'EXT-EDIT-1',
  items: [
    {
      description: 'Corrected item',
      unitName: 'piece',
      quantityMilli: '1000',
      unitCostMinor: '450',
      lineTotalMinor: '450',
    },
  ],
  totalMinor: '450',
};

describe('S12.4 Supplier financial correction commands', () => {
  it('parses user-style invoice cancellation with canonical identity and time', () => {
    const command = parseSupplierInvoiceCancelCommand(ids.target.toUpperCase(), {
      operationId: ids.operation.toUpperCase(),
      occurredAt: '2026-08-05T12:00:00+02:00',
    });

    expect(command).toMatchObject({
      family: 'invoice',
      kind: 'cancel',
      operationId: ids.operation,
      targetOperationId: ids.target,
      occurredAt: new Date(occurredAt),
    });
    expect(command.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps invoice edit to the exact S12.3 replacement arithmetic', () => {
    const command = parseSupplierInvoiceEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement,
    });

    expect(command).toMatchObject({ family: 'invoice', kind: 'edit' });
    expect(command.replacement).toMatchObject({
      operationId: ids.operation,
      supplierId: ids.supplier,
      totalMinor: 450n,
      itemsSubtotalMinor: 450n,
    });
  });

  it('preserves plain-text and complete Product-linked replacement rules', () => {
    const plain = parseSupplierInvoiceEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement,
    });
    const linked = parseSupplierInvoiceEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement: {
        ...replacement,
        items: [
          {
            ...replacement.items[0],
            productId: ids.product,
            productUnitId: ids.unit,
          },
        ],
      },
    });

    expect(plain.replacement.items[0]).toMatchObject({ productId: null, productUnitId: null });
    expect(linked.replacement.items[0]).toMatchObject({
      productId: ids.product,
      productUnitId: ids.unit,
    });
    expect(linked.requestHash).not.toBe(plain.requestHash);
    expect(() =>
      parseSupplierInvoiceEditCommand(ids.target, {
        operationId: ids.operation,
        occurredAt,
        replacement: {
          ...replacement,
          items: [{ ...replacement.items[0], productId: ids.product }],
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('fingerprints target, intent, Supplier, every line, and explicit-zero presence', () => {
    const baseline = parseSupplierInvoiceEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement: {
        supplierId: ids.supplier,
        items: [
          {
            description: 'Corrected item',
            unitName: 'piece',
            quantityMilli: '1000',
            unitCostMinor: '450',
          },
        ],
      },
    });
    const explicitZero = parseSupplierInvoiceEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement: {
        supplierId: ids.supplier,
        invoiceDiscountMinor: '0',
        items: [
          {
            description: 'Corrected item',
            unitName: 'piece',
            quantityMilli: '1000',
            unitCostMinor: '450',
            lineDiscountMinor: '0',
          },
        ],
      },
    });

    expect(explicitZero.requestHash).not.toBe(baseline.requestHash);
    expect(
      parseSupplierInvoiceEditCommand('a2400000-0000-4000-8000-000000000099', {
        operationId: ids.operation,
        occurredAt,
        replacement,
      }).requestHash,
    ).not.toBe(
      parseSupplierInvoiceEditCommand(ids.target, {
        operationId: ids.operation,
        occurredAt,
        replacement,
      }).requestHash,
    );
  });

  it('preserves lossless bigint replacement amounts', () => {
    const command = parseSupplierInvoiceEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement: {
        supplierId: ids.supplier,
        items: [
          {
            description: 'Exact large amount',
            unitName: 'piece',
            quantityMilli: '1000',
            unitCostMinor: '9007199254740993',
          },
        ],
      },
    });

    expect(command.replacement.totalMinor).toBe(9_007_199_254_740_993n);
  });

  it('parses opening payable edit and cancel without invoice semantics', () => {
    const edit = parseSupplierOpeningPayableEditCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
      replacement: { supplierId: ids.supplier, amountMinor: '700', notes: 'Corrected opening' },
    });
    const cancel = parseSupplierOpeningPayableCancelCommand(ids.target, {
      operationId: ids.operation,
      occurredAt,
    });

    expect(edit).toMatchObject({
      family: 'opening_payable',
      kind: 'edit',
      replacement: { supplierId: ids.supplier, amountMinor: 700n },
    });
    expect(cancel).toMatchObject({ family: 'opening_payable', kind: 'cancel' });
  });

  it('rejects nested operation ownership and unsupported client financial fields', () => {
    for (const invalidReplacement of [
      { ...replacement, operationId: ids.operation },
      { ...replacement, occurredAt },
      { ...replacement, moneyAccountId: ids.unit },
      { ...replacement, goodsReceiptId: ids.unit },
    ]) {
      expect(() =>
        parseSupplierInvoiceEditCommand(ids.target, {
          operationId: ids.operation,
          occurredAt,
          replacement: invalidReplacement,
        }),
      ).toThrow(BadRequestException);
    }
  });
});
