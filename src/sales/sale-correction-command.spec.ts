import { BadRequestException } from '@nestjs/common';

import { parseSaleCancelCommand, parseSaleEditCommand } from './sale-correction-command';

const targetOperationId = '9f97bb10-b68a-4474-888e-7244fc581bcb';
const correctionOperationId = 'a417fabd-b3c8-409c-9db3-2d62fdce21fd';
const accountA = '18dcbf0a-acde-48d6-88ed-cd1b078ddf41';
const accountB = '59e90f52-05aa-4bf4-af84-242686f712a8';
const occurredAt = '2026-08-15T10:00:00+00:00';

function replacement(payments: Record<string, unknown>[]): Record<string, unknown> {
  return {
    items: [
      {
        isManualLine: true,
        description: 'Corrected service',
        quantityMilli: '1000',
        unitPriceMinor: '500',
        lineTotalMinor: '500',
      },
    ],
    payments,
    totalMinor: '500',
  };
}

describe('Sale correction command', () => {
  it('canonicalizes cancel identity and instant', () => {
    const command = parseSaleCancelCommand(targetOperationId.toUpperCase(), {
      operationId: correctionOperationId.toUpperCase(),
      occurredAt,
    });

    expect(command).toMatchObject({
      kind: 'cancel',
      operationId: correctionOperationId,
      targetOperationId,
      occurredAt: new Date('2026-08-15T10:00:00.000Z'),
    });
    expect(command.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps edit identity stable across canonical tender order', () => {
    const first = parseSaleEditCommand(targetOperationId, {
      operationId: correctionOperationId,
      occurredAt,
      replacement: replacement([
        { moneyAccountId: accountB, amountMinor: '300' },
        { moneyAccountId: accountA, amountMinor: '200' },
      ]),
    });
    const second = parseSaleEditCommand(targetOperationId, {
      operationId: correctionOperationId,
      occurredAt: '2026-08-15T10:00:00Z',
      replacement: replacement([
        { moneyAccountId: accountA, amountMinor: '200' },
        { moneyAccountId: accountB, amountMinor: '300' },
      ]),
    });

    expect(first.requestHash).toBe(second.requestHash);
    expect(first.replacement.operationId).toBe(correctionOperationId);
    expect(first.replacement.occurredAt).toEqual(new Date('2026-08-15T10:00:00.000Z'));
  });

  it('changes identity when the correction meaning changes', () => {
    const cancelledAtFirst = parseSaleCancelCommand(targetOperationId, {
      operationId: correctionOperationId,
      occurredAt,
    });
    const cancelledLater = parseSaleCancelCommand(targetOperationId, {
      operationId: correctionOperationId,
      occurredAt: '2026-08-15T10:00:01Z',
    });
    const edited = parseSaleEditCommand(targetOperationId, {
      operationId: correctionOperationId,
      occurredAt,
      replacement: replacement([{ moneyAccountId: accountA, amountMinor: '500' }]),
    });

    expect(cancelledAtFirst.requestHash).not.toBe(cancelledLater.requestHash);
    expect(cancelledAtFirst.requestHash).not.toBe(edited.requestHash);
  });

  it.each([
    { operationId: correctionOperationId, occurredAt, extra: true },
    { operationId: correctionOperationId },
    { operationId: 'not-a-uuid', occurredAt },
  ])('rejects invalid cancel requests', (body) => {
    expect(() => parseSaleCancelCommand(targetOperationId, body)).toThrow(BadRequestException);
  });

  it.each([{ operationId: targetOperationId }, { occurredAt }])(
    'rejects correction-owned fields inside the replacement',
    (ownedField) => {
      expect(() =>
        parseSaleEditCommand(targetOperationId, {
          operationId: correctionOperationId,
          occurredAt,
          replacement: {
            ...replacement([{ moneyAccountId: accountA, amountMinor: '500' }]),
            ...ownedField,
          },
        }),
      ).toThrow(BadRequestException);
    },
  );
});
