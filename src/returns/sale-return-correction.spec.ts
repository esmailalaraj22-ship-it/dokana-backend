import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { OperationalTimeService } from '../settings/operational-time.service';
import {
  parseSaleReturnCancelCommand,
  parseSaleReturnReplaceCommand,
} from './sale-return-correction-command';
import {
  assertNonExpansiveReplacementLines,
  assertNonExpansiveReplacementTotal,
} from './sale-return-correction-policy';
import type { SaleReturnCorrectionRepository } from './sale-return-correction.repository';
import { parseStoredSaleReturnCorrectionResponse } from './sale-return-correction-response';
import { SaleReturnCorrectionService } from './sale-return-correction.service';
import type { SaleReturnCorrectionResponse } from './sale-return-correction.types';

const storeId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const requestId = randomUUID();
const targetReturnId = randomUUID();
const operationId = randomUUID();
const occurredAt = '2026-09-28T10:30:00.000Z';
const periodId = randomUUID();
const principal = {
  membershipRole: 'owner',
  storeId,
  userId,
  deviceId,
} as Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;
const context: TenantTransactionContext = { storeId, userId, deviceId, requestId };

function cancelBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { operationId, occurredAt, reason: 'Correct duplicated return', ...overrides };
}

function replacementBody(
  lines: { saleItemId: string; quantityMilli: string; disposition: string }[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...cancelBody(),
    replacement: {
      reason: 'Corrected merchandise return',
      lines,
      residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
    },
    ...overrides,
  };
}

function cancelResponse(): SaleReturnCorrectionResponse {
  return {
    operationId,
    transactionGroupId: operationId,
    targetReturnId,
    intent: 'cancel',
    correctionReason: 'Correct duplicated return',
    occurredAt,
    businessDate: '2026-09-28',
    postingDate: '2026-09-28',
    accountingPeriodId: periodId,
    outcome: {
      targetReturnId,
      status: 'cancelled',
      cancelledAt: occurredAt,
      version: '3',
      activeReturnId: null,
    },
    reversal: { customerLedgerEffects: [], moneyMovements: [], inventoryMovements: [] },
    replacement: null,
  };
}

describe('S17.5 immutable Sale Return correction contracts', () => {
  it('requires a distinct non-empty correction reason and strict client input', () => {
    for (const reason of [undefined, null, '', '   ']) {
      const body = cancelBody();
      if (reason === undefined) delete body.reason;
      else body.reason = reason;
      expect(() => parseSaleReturnCancelCommand(targetReturnId, body)).toThrow(BadRequestException);
    }
    expect(() =>
      parseSaleReturnCancelCommand(targetReturnId, { ...cancelBody(), reversalAmount: '500' }),
    ).toThrow(BadRequestException);
  });

  it('canonicalizes UUIDs and produces stable cancel request identity', () => {
    const upperTarget = targetReturnId.toUpperCase();
    const upperOperation = operationId.toUpperCase();
    const first = parseSaleReturnCancelCommand(upperTarget, {
      ...cancelBody(),
      operationId: upperOperation,
    });
    const duplicate = parseSaleReturnCancelCommand(targetReturnId, cancelBody());
    const changed = parseSaleReturnCancelCommand(
      targetReturnId,
      cancelBody({ reason: 'Different correction reason' }),
    );
    expect(first).toMatchObject({ targetReturnId, operationId, kind: 'cancel' });
    expect(first.requestHash).toBe(duplicate.requestHash);
    expect(changed.requestHash).not.toBe(first.requestHash);
  });

  it('canonicalizes replacement line order and binds all material replacement fields', () => {
    const lineA = randomUUID();
    const lineB = randomUUID();
    const first = parseSaleReturnReplaceCommand(
      targetReturnId,
      replacementBody([
        { saleItemId: lineB, quantityMilli: '2000', disposition: 'DAMAGED_NO_RESTOCK' },
        { saleItemId: lineA, quantityMilli: '1000', disposition: 'RESTOCK_SALEABLE' },
      ]),
    );
    const reordered = parseSaleReturnReplaceCommand(
      targetReturnId,
      replacementBody([
        { saleItemId: lineA, quantityMilli: '1000', disposition: 'RESTOCK_SALEABLE' },
        { saleItemId: lineB, quantityMilli: '2000', disposition: 'DAMAGED_NO_RESTOCK' },
      ]),
    );
    const changedQuantity = parseSaleReturnReplaceCommand(
      targetReturnId,
      replacementBody([
        { saleItemId: lineA, quantityMilli: '999', disposition: 'RESTOCK_SALEABLE' },
        { saleItemId: lineB, quantityMilli: '2000', disposition: 'DAMAGED_NO_RESTOCK' },
      ]),
    );
    expect(first.requestHash).toBe(reordered.requestHash);
    expect(changedQuantity.requestHash).not.toBe(first.requestHash);
    expect(first.replacement.lines.map((line) => line.saleItemId)).toEqual([lineA, lineB].sort());
    expect(() =>
      parseSaleReturnReplaceCommand(
        targetReturnId,
        replacementBody([
          { saleItemId: lineA, quantityMilli: '1000', disposition: 'RESTOCK_SALEABLE' },
          { saleItemId: lineA, quantityMilli: '1000', disposition: 'DAMAGED_NO_RESTOCK' },
        ]),
      ),
    ).toThrow(BadRequestException);
  });

  it('permits only non-expansive line and value scope after expiry', () => {
    const lineA = randomUUID();
    const lineB = randomUUID();
    expect(() =>
      assertNonExpansiveReplacementLines(
        [
          { saleItemId: lineA, quantityMilli: 2_000n },
          { saleItemId: lineB, quantityMilli: 1_000n },
        ],
        [{ saleItemId: lineA, quantityMilli: 1_000n, disposition: 'DAMAGED_NO_RESTOCK' }],
      ),
    ).not.toThrow();
    expect(() =>
      assertNonExpansiveReplacementLines(
        [{ saleItemId: lineA, quantityMilli: 2_000n }],
        [{ saleItemId: lineA, quantityMilli: 2_001n, disposition: 'RESTOCK_SALEABLE' }],
      ),
    ).toThrow('SALE_RETURN_CORRECTION_SCOPE_EXPANDED');
    expect(() =>
      assertNonExpansiveReplacementLines(
        [{ saleItemId: lineA, quantityMilli: 2_000n }],
        [{ saleItemId: lineB, quantityMilli: 1n, disposition: 'DAMAGED_NO_RESTOCK' }],
      ),
    ).toThrow('SALE_RETURN_CORRECTION_SCOPE_EXPANDED');
    expect(() => assertNonExpansiveReplacementTotal(500n, 500n)).not.toThrow();
    expect(() => assertNonExpansiveReplacementTotal(500n, 501n)).toThrow(
      'SALE_RETURN_CORRECTION_SCOPE_EXPANDED',
    );
  });

  it('accepts only internally consistent stored cancellation responses', () => {
    expect(parseStoredSaleReturnCorrectionResponse(cancelResponse())).toEqual(cancelResponse());
    expect(() =>
      parseStoredSaleReturnCorrectionResponse({
        ...cancelResponse(),
        outcome: { ...cancelResponse().outcome, activeReturnId: randomUUID() },
      }),
    ).toThrow('Stored Sale Return correction response is inconsistent.');
    expect(() =>
      parseStoredSaleReturnCorrectionResponse({
        ...cancelResponse(),
        transactionGroupId: randomUUID(),
      }),
    ).toThrow('Stored Sale Return correction response is inconsistent.');
  });

  it('enforces owner-only correction authority before repository access', async () => {
    const repository = {
      correct: jest.fn(),
    } as unknown as jest.Mocked<SaleReturnCorrectionRepository>;
    const operationalTime = {
      resolve: jest.fn().mockReturnValue({ businessDate: '2026-09-28' }),
    } as unknown as OperationalTimeService;
    const service = new SaleReturnCorrectionService(repository, operationalTime);
    await expect(
      service.cancel(
        { ...principal, membershipRole: 'manager' },
        context,
        targetReturnId,
        cancelBody(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.correct).not.toHaveBeenCalled();
  });

  it('uses operational business time and maps durable correction failures', async () => {
    const repository = {
      correct: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, response: cancelResponse() })
        .mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY',
            message: 'Available Customer Credit is insufficient to reverse this Return.',
            statusCode: 409,
          },
        }),
    } as unknown as jest.Mocked<SaleReturnCorrectionRepository>;
    const operationalTime = {
      resolve: jest.fn().mockReturnValue({ businessDate: '2026-09-28' }),
    } as unknown as OperationalTimeService;
    const service = new SaleReturnCorrectionService(repository, operationalTime);
    await expect(service.cancel(principal, context, targetReturnId, cancelBody())).resolves.toEqual(
      cancelResponse(),
    );
    expect(repository.correct).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ targetReturnId, correctionReason: 'Correct duplicated return' }),
      '2026-09-28',
    );
    await expect(
      service.cancel(principal, context, targetReturnId, cancelBody()),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY' },
    });
  });
});
