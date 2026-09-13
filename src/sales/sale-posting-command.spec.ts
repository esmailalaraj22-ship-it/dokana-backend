import { BadRequestException } from '@nestjs/common';

import {
  parseCustomerOpeningReceivableCommand,
  parseSalePostingCommand,
} from './sale-posting-command';

const operationId = '9f97bb10-b68a-4474-888e-7244fc581bcb';
const customerId = 'a417fabd-b3c8-409c-9db3-2d62fdce21fd';
const accountA = '18dcbf0a-acde-48d6-88ed-cd1b078ddf41';
const accountB = '59e90f52-05aa-4bf4-af84-242686f712a8';
const productId = '2fba5797-fc62-4dfc-8959-311d0f33d070';
const unitId = 'd40396b7-6b78-412d-a2da-5734e23aa51d';
const occurredAt = '2026-08-15T10:00:00Z';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId,
    occurredAt,
    items: [
      {
        isManualLine: false,
        productId,
        productUnitId: unitId,
        quantityMilli: '2500',
        unitPriceMinor: '201',
        lineDiscountMinor: '2',
        lineTotalMinor: '501',
      },
    ],
    payments: [{ moneyAccountId: accountA, amountMinor: '501' }],
    totalMinor: '501',
    ...overrides,
  };
}

describe('Sale posting command', () => {
  it('derives an anonymous fully-paid Sale with exact bigint arithmetic', () => {
    const command = parseSalePostingCommand(body());
    expect(command).toMatchObject({
      customerId: null,
      itemsSubtotalMinor: 503n,
      lineDiscountTotalMinor: 2n,
      totalMinor: 501n,
      paidTotalMinor: 501n,
      creditTotalMinor: 0n,
      paymentStatus: 'paid',
    });
  });

  it('derives partial and full-credit Customer Sales', () => {
    const partial = parseSalePostingCommand(
      body({ customerId, payments: [{ moneyAccountId: accountA, amountMinor: '200' }] }),
    );
    const credit = parseSalePostingCommand(body({ customerId, payments: [] }));
    expect(partial).toMatchObject({
      paidTotalMinor: 200n,
      creditTotalMinor: 301n,
      paymentStatus: 'partial',
    });
    expect(credit).toMatchObject({
      paidTotalMinor: 0n,
      creditTotalMinor: 501n,
      paymentStatus: 'credit',
    });
  });

  it('canonicalizes split tenders without changing request identity', () => {
    const first = parseSalePostingCommand(
      body({
        payments: [
          { moneyAccountId: accountB, amountMinor: '300' },
          { moneyAccountId: accountA, amountMinor: '201' },
        ],
      }),
    );
    const second = parseSalePostingCommand(
      body({
        payments: [
          { moneyAccountId: accountA, amountMinor: '201' },
          { moneyAccountId: accountB, amountMinor: '300' },
        ],
      }),
    );
    expect(first.payments.map((payment) => payment.moneyAccountId)).toEqual([accountA, accountB]);
    expect(first.requestHash).toBe(second.requestHash);
  });

  it.each([
    body({ payments: [] }),
    body({ payments: [{ moneyAccountId: accountA, amountMinor: '502' }] }),
    body({
      payments: [
        { moneyAccountId: accountA, amountMinor: '200' },
        { moneyAccountId: accountA, amountMinor: '301' },
      ],
    }),
  ])('rejects missing-Customer debt, overpayment, and duplicate tender accounts', (input) => {
    expect(() => parseSalePostingCommand(input)).toThrow(BadRequestException);
  });

  it('applies only the approved discounts and rejects a zero final total', () => {
    const command = parseSalePostingCommand(
      body({
        customerId,
        invoiceDiscountMinor: '100',
        roundingMinor: '-1',
        totalMinor: '400',
        payments: [],
      }),
    );
    expect(command.totalMinor).toBe(400n);
    expect(() =>
      parseSalePostingCommand(
        body({
          items: [
            {
              isManualLine: true,
              description: 'Free line',
              quantityMilli: '1000',
              unitPriceMinor: '0',
            },
          ],
          payments: [],
          totalMinor: '0',
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('distinguishes missing required money from explicit zero and preserves large bigint', () => {
    expect(() =>
      parseSalePostingCommand(
        body({
          items: [
            {
              isManualLine: true,
              description: 'Missing price',
              quantityMilli: '1000',
            },
          ],
        }),
      ),
    ).toThrow(BadRequestException);
    const command = parseSalePostingCommand(
      body({
        customerId,
        items: [
          {
            isManualLine: true,
            description: 'Large exact value',
            quantityMilli: '1000',
            unitPriceMinor: '9007199254740993',
          },
        ],
        payments: [],
        totalMinor: '9007199254740993',
      }),
    );
    expect(command.totalMinor).toBe(9_007_199_254_740_993n);
  });

  it('parses an independent positive Customer opening receivable', () => {
    const command = parseCustomerOpeningReceivableCommand(customerId.toUpperCase(), {
      operationId,
      amountMinor: '9007199254740993',
      occurredAt,
      notes: 'Imported opening debt',
    });
    expect(command).toMatchObject({
      customerId,
      operationId,
      amountMinor: 9_007_199_254_740_993n,
      notes: 'Imported opening debt',
    });
  });
});
