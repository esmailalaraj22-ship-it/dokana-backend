import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { parseCustomerCollectionPostingCommand } from './customer-payment-posting-command';

const ids = {
  customer: '15330000-0000-4000-8000-000000000001',
  operation: '15330000-0000-4000-8000-000000000002',
  cash: '15330000-0000-4000-8000-000000000003',
  bank: '15330000-0000-4000-8000-000000000004',
  sale: '15330000-0000-4000-8000-000000000005',
  opening: '15330000-0000-4000-8000-000000000006',
};

function fifo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: ids.operation,
    occurredAt: '2026-09-14T10:00:00Z',
    allocationMode: 'fifo',
    tenders: [
      {
        moneyAccountId: ids.cash,
        amountMinor: '300',
        senderAccountName: null,
        externalReference: 'COLLECTION-1',
        notes: 'Installment',
      },
    ],
    ...overrides,
  };
}

function custom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: ids.operation,
    occurredAt: '2026-09-14T10:00:00Z',
    allocationMode: 'custom',
    tenders: [
      { moneyAccountId: ids.cash, amountMinor: '100' },
      { moneyAccountId: ids.bank, amountMinor: '200' },
    ],
    allocations: [
      { targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '250' },
      { targetType: 'opening_receivable', targetId: ids.opening, amountMinor: '50' },
    ],
    ...overrides,
  };
}

describe('S15.3 Customer collection command', () => {
  it('parses FIFO with lossless bigint money and normalized metadata', () => {
    const command = parseCustomerCollectionPostingCommand(ids.customer, fifo());
    expect(command).toMatchObject({
      operationId: ids.operation,
      customerId: ids.customer,
      allocationMode: 'fifo',
      amountMinor: 300n,
      occurredAt: new Date('2026-09-14T10:00:00.000Z'),
      allocations: [],
    });
  });

  it('preserves the S15.3 canonical hash for an unchanged legacy request', () => {
    const body = fifo();
    const command = parseCustomerCollectionPostingCommand(ids.customer, body);
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          v: 1,
          action: 'customer_collections.post',
          customerId: ids.customer,
          occurredAt: '2026-09-14T10:00:00.000Z',
          allocationMode: 'fifo',
          amountMinor: '300',
          tenders: [
            {
              moneyAccountId: ids.cash,
              amountMinor: '300',
              senderAccountName: null,
              externalReference: 'COLLECTION-1',
              notes: 'Installment',
            },
          ],
          allocations: [],
        }),
        'utf8',
      )
      .digest('hex');
    expect(command.requestHash).toBe(expected);
  });

  it('canonicalizes tender and CUSTOM target order before hashing', () => {
    const first = parseCustomerCollectionPostingCommand(ids.customer, custom());
    const second = parseCustomerCollectionPostingCommand(
      ids.customer.toUpperCase(),
      custom({
        operationId: ids.operation.toUpperCase(),
        tenders: [
          { moneyAccountId: ids.bank.toUpperCase(), amountMinor: '200' },
          { moneyAccountId: ids.cash.toUpperCase(), amountMinor: '100' },
        ],
        allocations: [
          {
            targetType: 'opening_receivable',
            targetId: ids.opening.toUpperCase(),
            amountMinor: '50',
          },
          { targetType: 'sale_receivable', targetId: ids.sale.toUpperCase(), amountMinor: '250' },
        ],
      }),
    );
    expect(second.requestHash).toBe(first.requestHash);
    expect(second.tenders.map((item) => item.moneyAccountId)).toEqual([ids.cash, ids.bank]);
    expect(second.allocations.map((item) => item.targetType)).toEqual([
      'opening_receivable',
      'sale_receivable',
    ]);
  });

  it('preserves amounts above the JavaScript safe integer range', () => {
    const amount = '9007199254740993';
    const command = parseCustomerCollectionPostingCommand(
      ids.customer,
      custom({
        tenders: [{ moneyAccountId: ids.cash, amountMinor: amount }],
        allocations: [{ targetType: 'sale_receivable', targetId: ids.sale, amountMinor: amount }],
      }),
    );
    expect(command.amountMinor).toBe(9_007_199_254_740_993n);
  });

  it.each([
    ['zero tender', fifo({ tenders: [{ moneyAccountId: ids.cash, amountMinor: '0' }] })],
    ['negative tender', fifo({ tenders: [{ moneyAccountId: ids.cash, amountMinor: '-1' }] })],
    [
      'overflow',
      fifo({ tenders: [{ moneyAccountId: ids.cash, amountMinor: '9223372036854775808' }] }),
    ],
    [
      'duplicate account',
      fifo({
        tenders: [
          { moneyAccountId: ids.cash, amountMinor: '100' },
          { moneyAccountId: ids.cash, amountMinor: '200' },
        ],
      }),
    ],
    [
      'duplicate custom target',
      custom({
        allocations: [
          { targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '100' },
          { targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '200' },
        ],
      }),
    ],
    [
      'custom under-allocation',
      custom({
        allocations: [{ targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '299' }],
      }),
    ],
    [
      'custom over-allocation',
      custom({
        allocations: [{ targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '301' }],
      }),
    ],
    ['FIFO allocations supplied', fifo({ allocations: [] })],
    ['CUSTOM allocations omitted', { ...custom(), allocations: undefined }],
  ])('rejects %s', (_name, body) => {
    expect(() => parseCustomerCollectionPostingCommand(ids.customer, body)).toThrow(
      BadRequestException,
    );
  });

  it('binds all material tender and allocation fields into the semantic hash', () => {
    const original = parseCustomerCollectionPostingCommand(ids.customer, custom());
    const changed = [
      custom({ occurredAt: '2026-09-14T10:01:00Z' }),
      custom({
        tenders: [{ moneyAccountId: ids.cash, amountMinor: '300' }],
        allocations: [{ targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '300' }],
      }),
      fifo(),
      custom({
        tenders: [
          { moneyAccountId: ids.cash, amountMinor: '100', notes: 'changed' },
          { moneyAccountId: ids.bank, amountMinor: '200' },
        ],
      }),
    ];
    for (const body of changed) {
      expect(parseCustomerCollectionPostingCommand(ids.customer, body).requestHash).not.toBe(
        original.requestHash,
      );
    }
  });

  it('parses explicit retained and refunded overpayment choices', () => {
    const retained = parseCustomerCollectionPostingCommand(
      ids.customer,
      fifo({ overpaymentHandling: 'keep_as_customer_credit' }),
    );
    const refunded = parseCustomerCollectionPostingCommand(
      ids.customer,
      fifo({
        overpaymentHandling: 'refund_excess',
        refundMoneyAccountId: ids.bank,
      }),
    );
    expect(retained).toMatchObject({
      intent: 'collect_receivable',
      overpaymentHandling: 'keep_as_customer_credit',
      refundMoneyAccountId: null,
    });
    expect(refunded).toMatchObject({
      intent: 'collect_receivable',
      overpaymentHandling: 'refund_excess',
      refundMoneyAccountId: ids.bank,
    });
    expect(refunded.requestHash).not.toBe(retained.requestHash);
  });

  it('parses a distinct zero-debt Customer Advance intent', () => {
    const command = parseCustomerCollectionPostingCommand(ids.customer, {
      operationId: ids.operation,
      occurredAt: '2026-09-14T10:00:00Z',
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: ids.cash, amountMinor: '200' }],
    });
    expect(command).toMatchObject({
      intent: 'customer_advance',
      allocationMode: 'fifo',
      amountMinor: 200n,
      allocations: [],
      overpaymentHandling: null,
    });
  });

  it('allows CUSTOM debt allocation below tender total only with explicit handling', () => {
    const command = parseCustomerCollectionPostingCommand(
      ids.customer,
      custom({
        overpaymentHandling: 'keep_as_customer_credit',
        allocations: [{ targetType: 'sale_receivable', targetId: ids.sale, amountMinor: '250' }],
      }),
    );
    expect(command.amountMinor).toBe(300n);
    expect(command.allocations[0]?.amountMinor).toBe(250n);
  });

  it.each([
    ['refund choice without account', fifo({ overpaymentHandling: 'refund_excess' })],
    ['refund account without refund choice', fifo({ refundMoneyAccountId: ids.bank })],
    [
      'advance with collection fields',
      {
        operationId: ids.operation,
        occurredAt: '2026-09-14T10:00:00Z',
        intent: 'customer_advance',
        allocationMode: 'fifo',
        tenders: [{ moneyAccountId: ids.cash, amountMinor: '200' }],
      },
    ],
  ])('rejects %s', (_name, body) => {
    expect(() => parseCustomerCollectionPostingCommand(ids.customer, body)).toThrow(
      BadRequestException,
    );
  });
});
