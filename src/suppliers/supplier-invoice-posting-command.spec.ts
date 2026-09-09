import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  parseSupplierInvoicePostingCommand,
  parseSupplierOpeningPayableCommand,
} from './supplier-invoice-posting-command';

const supplierId = randomUUID();
const request = {
  operationId: randomUUID(),
  invoiceNumber: 'EXT-123',
  occurredAt: '2026-07-03T10:00:00Z',
  items: [
    {
      description: 'Sugar',
      unitName: 'kg',
      quantityMilli: '2500',
      unitCostMinor: '101',
      lineDiscountMinor: '2',
      roundingMinor: '0',
      lineTotalMinor: '251',
    },
    {
      description: 'Transport',
      unitName: 'service',
      quantityMilli: '1000',
      unitCostMinor: '249',
      lineTotalMinor: '249',
    },
  ],
  totalMinor: '500',
};

describe('S12.3 Supplier Invoice command and exact arithmetic', () => {
  it('derives line and invoice totals with exact half-up bigint arithmetic', () => {
    const command = parseSupplierInvoicePostingCommand(supplierId, request);
    expect(command).toMatchObject({
      supplierId,
      itemsSubtotalMinor: 502n,
      lineDiscountTotalMinor: 2n,
      invoiceDiscountMinor: 0n,
      roundingMinor: 0n,
      totalMinor: 500n,
    });
    expect(command.items.map((item) => item.lineGrossMinor)).toEqual([253n, 249n]);
    expect(command.items.map((item) => item.lineTotalMinor)).toEqual([251n, 249n]);
  });

  it('supports plain-text and complete optional Product links', () => {
    const productId = randomUUID();
    const productUnitId = randomUUID();
    const plain = parseSupplierInvoicePostingCommand(supplierId, request);
    const linked = parseSupplierInvoicePostingCommand(supplierId, {
      ...request,
      items: [{ ...request.items[0], productId, productUnitId }],
      totalMinor: '251',
    });
    expect(plain.items[0]).toMatchObject({ productId: null, productUnitId: null });
    expect(linked.items[0]).toMatchObject({ productId, productUnitId });
    expect(linked.requestHash).not.toBe(plain.requestHash);
  });

  it('rejects either half of the Product link pair', () => {
    for (const link of [{ productId: randomUUID() }, { productUnitId: randomUUID() }]) {
      expect(() =>
        parseSupplierInvoicePostingCommand(supplierId, {
          ...request,
          items: [{ ...request.items[0], ...link }],
          totalMinor: '251',
        }),
      ).toThrow(BadRequestException);
    }
  });

  it('rejects conflicting client line or invoice totals', () => {
    expect(() =>
      parseSupplierInvoicePostingCommand(supplierId, {
        ...request,
        items: [{ ...request.items[0], lineTotalMinor: '250' }],
        totalMinor: '251',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSupplierInvoicePostingCommand(supplierId, { ...request, totalMinor: '499' }),
    ).toThrow(BadRequestException);
  });

  it('rejects aggregate line rounding that the physical invoice contract cannot post', () => {
    expect(() =>
      parseSupplierInvoicePostingCommand(supplierId, {
        ...request,
        items: [{ ...request.items[0], roundingMinor: '1', lineTotalMinor: '252' }],
        totalMinor: '252',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects non-positive totals and PostgreSQL bigint overflow', () => {
    expect(() =>
      parseSupplierInvoicePostingCommand(supplierId, {
        ...request,
        items: [
          {
            description: 'Free line',
            unitName: 'unit',
            quantityMilli: '1000',
            unitCostMinor: '0',
          },
        ],
        totalMinor: '0',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSupplierInvoicePostingCommand(supplierId, {
        ...request,
        items: [
          {
            description: 'Overflow',
            unitName: 'unit',
            quantityMilli: '9223372036854775807',
            unitCostMinor: '9223372036854775807',
          },
        ],
        totalMinor: undefined,
      }),
    ).toThrow(BadRequestException);
  });

  it('preserves lossless money above JavaScript safe integer range', () => {
    const command = parseSupplierInvoicePostingCommand(supplierId, {
      ...request,
      items: [
        {
          description: 'Large exact invoice',
          unitName: 'unit',
          quantityMilli: '1000',
          unitCostMinor: '9007199254740993',
          lineTotalMinor: '9007199254740993',
        },
      ],
      totalMinor: '9007199254740993',
    });
    expect(command.totalMinor).toBe(9_007_199_254_740_993n);
  });

  it('canonicalizes equivalent UUIDs and instants into an exact semantic hash', () => {
    const original = parseSupplierInvoicePostingCommand(supplierId, request);
    const equivalent = parseSupplierInvoicePostingCommand(supplierId.toUpperCase(), {
      ...request,
      operationId: request.operationId.toUpperCase(),
      occurredAt: '2026-07-03T12:00:00+02:00',
      invoiceNumber: ' EXT-123 ',
    });
    expect(equivalent.requestHash).toBe(original.requestHash);
    for (const change of [
      { invoiceNumber: 'EXT-124' },
      { notes: 'Changed' },
      { dueAt: '2026-08-03T10:00:00Z' },
      { invoiceDiscountMinor: '1', totalMinor: '499' },
    ]) {
      expect(
        parseSupplierInvoicePostingCommand(supplierId, { ...request, ...change }).requestHash,
      ).not.toBe(original.requestHash);
    }
  });

  it('rejects client-owned posting, tenant, balance, and financial-effect fields', () => {
    for (const field of [
      'storeId',
      'postingDate',
      'accountingPeriodId',
      'payableDeltaMinor',
      'supplierBalanceMinor',
      'moneyAccountId',
      'goodsReceiptId',
    ]) {
      expect(() =>
        parseSupplierInvoicePostingCommand(supplierId, { ...request, [field]: randomUUID() }),
      ).toThrow(BadRequestException);
    }
  });

  it('parses a positive opening payable and fingerprints all material semantics', () => {
    const opening = {
      operationId: randomUUID(),
      amountMinor: '1200',
      occurredAt: '2026-07-01T10:00:00Z',
      notes: 'Pre-Dokana debt',
    };
    const parsed = parseSupplierOpeningPayableCommand(supplierId, opening);
    expect(parsed.amountMinor).toBe(1200n);
    expect(parsed.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      parseSupplierOpeningPayableCommand(supplierId, { ...opening, amountMinor: '1201' })
        .requestHash,
    ).not.toBe(parsed.requestHash);
    for (const amountMinor of ['0', '-1', '9223372036854775808', '1.1']) {
      expect(() =>
        parseSupplierOpeningPayableCommand(supplierId, { ...opening, amountMinor }),
      ).toThrow(BadRequestException);
    }
  });
});
