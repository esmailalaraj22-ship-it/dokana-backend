import { BadRequestException } from '@nestjs/common';

import {
  parseApplyCustomerCreditCommand,
  parseRefundCustomerCreditCommand,
  parseSettleCustomerReceivableCommand,
} from './customer-credit-command';

const ids = {
  customer: '15440000-0000-4000-8000-000000000001',
  operation: '15440000-0000-4000-8000-000000000002',
  account: '15440000-0000-4000-8000-000000000003',
  sale: '15440000-0000-4000-8000-000000000004',
  opening: '15440000-0000-4000-8000-000000000005',
};

describe('S15.4 Customer Credit and settlement commands', () => {
  it('parses FIFO Customer Credit application with exact bigint money', () => {
    expect(
      parseApplyCustomerCreditCommand(ids.customer, {
        operationId: ids.operation,
        occurredAt: '2026-09-15T10:00:00Z',
        amountMinor: '9007199254740993',
        allocationMode: 'fifo',
      }),
    ).toMatchObject({
      action: 'apply_customer_credit',
      amountMinor: 9_007_199_254_740_993n,
      allocationMode: 'fifo',
      allocations: [],
    });
  });

  it('canonicalizes CUSTOM target order and hashes material target identity', () => {
    const first = parseApplyCustomerCreditCommand(ids.customer, {
      operationId: ids.operation,
      occurredAt: '2026-09-15T10:00:00Z',
      amountMinor: '300',
      allocationMode: 'custom',
      allocations: [
        { targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '200' },
        { targetType: 'opening_receivable', targetId: ids.opening, amountMinor: '100' },
      ],
    });
    const second = parseApplyCustomerCreditCommand(ids.customer.toUpperCase(), {
      operationId: ids.operation.toUpperCase(),
      occurredAt: '2026-09-15T10:00:00.000Z',
      amountMinor: '300',
      allocationMode: 'custom',
      allocations: [
        {
          targetType: 'opening_receivable',
          targetId: ids.opening.toUpperCase(),
          amountMinor: '100',
        },
        { targetType: 'sale_receivable', targetId: ids.sale.toUpperCase(), amountMinor: '200' },
      ],
    });
    expect(second.requestHash).toBe(first.requestHash);
  });

  it('requires an explicit settlement reason', () => {
    expect(() =>
      parseSettleCustomerReceivableCommand(ids.customer, {
        operationId: ids.operation,
        occurredAt: '2026-09-15T10:00:00Z',
        amountMinor: '50',
        allocationMode: 'fifo',
      }),
    ).toThrow(BadRequestException);
    expect(
      parseSettleCustomerReceivableCommand(ids.customer, {
        operationId: ids.operation,
        occurredAt: '2026-09-15T10:00:00Z',
        amountMinor: '50',
        allocationMode: 'fifo',
        reason: 'commercial settlement',
      }),
    ).toMatchObject({ action: 'settle_receivable', reason: 'commercial settlement' });
  });

  it('parses an explicit Money Account Customer Credit refund', () => {
    expect(
      parseRefundCustomerCreditCommand(ids.customer, {
        operationId: ids.operation,
        occurredAt: '2026-09-15T10:00:00Z',
        amountMinor: '70',
        moneyAccountId: ids.account,
        notes: 'requested refund',
      }),
    ).toMatchObject({
      action: 'refund_customer_credit',
      amountMinor: 70n,
      moneyAccountId: ids.account,
      reason: 'requested refund',
    });
  });

  it('rejects duplicate targets and target totals that differ from the request', () => {
    for (const allocations of [
      [
        { targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '50' },
        { targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '50' },
      ],
      [{ targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '99' }],
    ]) {
      expect(() =>
        parseApplyCustomerCreditCommand(ids.customer, {
          operationId: ids.operation,
          occurredAt: '2026-09-15T10:00:00Z',
          amountMinor: '100',
          allocationMode: 'custom',
          allocations,
        }),
      ).toThrow(BadRequestException);
    }
  });
});
