import { BadRequestException } from '@nestjs/common';

import { parseSaleReturnCommand } from './sale-return-command';

const saleId = '10000000-0000-4000-8000-000000000001';
const operationId = '10000000-0000-4000-8000-000000000002';
const lineA = '10000000-0000-4000-8000-000000000003';
const lineB = '10000000-0000-4000-8000-000000000004';
const accountId = '10000000-0000-4000-8000-000000000005';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId,
    occurredAt: '2026-09-26T10:00:00Z',
    reason: 'Customer returned the goods',
    lines: [
      { saleItemId: lineB, quantityMilli: '2000', disposition: 'DAMAGED_NO_RESTOCK' },
      { saleItemId: lineA, quantityMilli: '1000', disposition: 'RESTOCK_SALEABLE' },
    ],
    residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    ...overrides,
  };
}

describe('Sale Return canonical command', () => {
  it('canonicalizes UUIDs, line order, quantities, reason, and one refund account', () => {
    const command = parseSaleReturnCommand(saleId.toUpperCase(), body());
    expect(command).toMatchObject({
      saleId,
      operationId,
      reason: 'Customer returned the goods',
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    expect(command.lines.map((line) => line.saleItemId)).toEqual([lineA, lineB]);
    expect(command.lines.map((line) => line.quantityMilli)).toEqual([1000n, 2000n]);
  });

  it('gives request-order-independent semantic identity', () => {
    const first = parseSaleReturnCommand(saleId, body());
    const second = parseSaleReturnCommand(
      saleId,
      body({ lines: [...(body().lines as object[])].reverse() }),
    );
    expect(first.requestHash).toBe(second.requestHash);
  });

  it('canonicalizes equivalent accepted timestamp and UUID text forms', () => {
    const first = parseSaleReturnCommand(saleId, body());
    const second = parseSaleReturnCommand(
      saleId.toUpperCase(),
      body({
        operationId: operationId.toUpperCase(),
        occurredAt: '2026-09-26T12:00:00+02:00',
        lines: [
          {
            saleItemId: lineB.toUpperCase(),
            quantityMilli: '2000',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
          {
            saleItemId: lineA.toUpperCase(),
            quantityMilli: '1000',
            disposition: 'RESTOCK_SALEABLE',
          },
        ],
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId.toUpperCase() },
      }),
    );
    expect(second.requestHash).toBe(first.requestHash);
  });

  it.each([null, '', '   '])('rejects invalid reason %p', (reason) => {
    expect(() => parseSaleReturnCommand(saleId, body({ reason }))).toThrow(BadRequestException);
  });

  it('rejects duplicate Sale lines before persistence', () => {
    expect(() =>
      parseSaleReturnCommand(
        saleId,
        body({
          lines: [
            { saleItemId: lineA, quantityMilli: '1', disposition: 'RESTOCK_SALEABLE' },
            { saleItemId: lineA, quantityMilli: '2', disposition: 'DAMAGED_NO_RESTOCK' },
          ],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each(['0', '-1', '9223372036854775808'])('rejects invalid quantity %s', (quantityMilli) => {
    expect(() =>
      parseSaleReturnCommand(
        saleId,
        body({
          lines: [{ saleItemId: lineA, quantityMilli, disposition: 'RESTOCK_SALEABLE' }],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects client-authoritative totals and prices', () => {
    expect(() => parseSaleReturnCommand(saleId, body({ totalMinor: '300' }))).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseSaleReturnCommand(
        saleId,
        body({
          lines: [
            {
              saleItemId: lineA,
              quantityMilli: '1',
              disposition: 'RESTOCK_SALEABLE',
              lineRefundMinor: '999',
            },
          ],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('accepts an explicit Customer Credit residual without a Money Account', () => {
    const command = parseSaleReturnCommand(
      saleId,
      body({ residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' } }),
    );
    expect(command.residualSettlement).toEqual({
      choice: 'KEEP_AS_CUSTOMER_CREDIT',
      moneyAccountId: null,
    });
  });

  it('accepts no residual choice when the calculated waterfall will consume all value', () => {
    expect(
      parseSaleReturnCommand(saleId, body({ residualSettlement: null })).residualSettlement,
    ).toBeNull();
  });

  it.each([
    [
      'quantity',
      { lines: [{ saleItemId: lineA, quantityMilli: '2', disposition: 'RESTOCK_SALEABLE' }] },
    ],
    [
      'disposition',
      { lines: [{ saleItemId: lineA, quantityMilli: '1', disposition: 'DAMAGED_NO_RESTOCK' }] },
    ],
    ['choice', { residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' } }],
    ['account', { residualSettlement: { choice: 'REFUND', moneyAccountId: lineA } }],
    ['occurredAt', { occurredAt: '2026-09-26T10:00:01Z' }],
    ['reason', { reason: 'Different reason' }],
  ])('changes request identity when material %s changes', (_field, override) => {
    expect(parseSaleReturnCommand(saleId, body(override)).requestHash).not.toBe(
      parseSaleReturnCommand(saleId, body()).requestHash,
    );
  });
});
