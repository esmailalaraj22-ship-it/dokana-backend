import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { AccountingCorrectionPostingRepository } from './accounting-correction-posting.repository';
import { AccountingCorrectionWriteService } from './accounting-correction-write.service';
import type {
  AccountingCorrectionMutationResponse,
  AccountingCorrectionMutationResult,
} from './accounting-correction.types';

const ids = {
  store: '10000000-0000-4000-8000-000000000001',
  user: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  request: '10000000-0000-4000-8000-000000000004',
  target: '10000000-0000-4000-8000-000000000005',
  operation: '10000000-0000-4000-8000-000000000006',
  account: '10000000-0000-4000-8000-000000000007',
  destination: '10000000-0000-4000-8000-000000000008',
  period: '10000000-0000-4000-8000-000000000009',
  source: '10000000-0000-4000-8000-00000000000a',
};

const principal: Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
> = {
  membershipRole: 'owner',
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
};

const context: TenantTransactionContext = {
  storeId: ids.store,
  userId: ids.user,
  deviceId: ids.device,
  requestId: ids.request,
};

const response: AccountingCorrectionMutationResponse = {
  operationId: ids.operation,
  targetOperationId: ids.target,
  domain: 'owner_contribution',
  correctionKind: 'replacement',
  postingDate: '2026-02-01',
  accountingPeriodId: ids.period,
  movements: [],
  ownerEntries: [],
  replacementTransfer: null,
};

describe('AccountingCorrectionWriteService', () => {
  const repository = {
    correct: jest.fn<
      Promise<AccountingCorrectionMutationResult>,
      Parameters<AccountingCorrectionPostingRepository['correct']>
    >(),
  };
  const service = new AccountingCorrectionWriteService(
    repository as unknown as AccountingCorrectionPostingRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.correct.mockReset();
    repository.correct.mockResolvedValue({ ok: true, response });
  });

  it('canonicalizes a reversal target and derives its correction posting date', async () => {
    await service.reverse(principal, context, ids.target.toUpperCase(), 'owner_contribution', {
      operationId: ids.operation.toUpperCase(),
      occurredAt: '2026-01-31T22:30:00.000Z',
    });

    expect(repository.correct).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        operationId: ids.operation,
        targetOperationId: ids.target,
        domain: 'owner_contribution',
        kind: 'reversal',
        postingDate: '2026-02-01',
      }),
    );
  });

  it('binds allowed owner replacement fields into a canonical request hash', async () => {
    const dto = {
      operationId: ids.operation,
      moneyAccountId: ids.account.toUpperCase(),
      amountMinor: '150',
      occurredAt: '2026-01-15T12:00:00+02:00',
    };
    await service.replaceOwnerEvent(principal, context, ids.target, 'owner_loan', dto);
    await service.replaceOwnerEvent(principal, context, ids.target, 'owner_loan', {
      ...dto,
      occurredAt: '2026-01-15T10:00:00Z',
    });

    const first = repository.correct.mock.calls[0]?.[1];
    const second = repository.correct.mock.calls[1]?.[1];
    expect(first).toMatchObject({
      replacement: { amountMinor: 150n, moneyAccountId: ids.account },
    });
    expect(first?.requestHash).toBe(second?.requestHash);
  });

  it('permits destination, amount, and an optional source as transfer replacement input', async () => {
    await service.replaceTransfer(principal, context, ids.target, {
      operationId: ids.operation,
      destinationAccountId: ids.destination,
      amountMinor: '25',
      occurredAt: '2026-01-15T10:00:00Z',
    });

    expect(repository.correct.mock.calls[0]?.[1]).toMatchObject({
      domain: 'internal_transfer',
      replacement: { destinationAccountId: ids.destination, amountMinor: 25n },
    });
    expect(repository.correct.mock.calls[0]?.[1].replacement).not.toHaveProperty('sourceAccountId');

    await service.replaceTransfer(principal, context, ids.target, {
      operationId: ids.operation,
      sourceAccountId: ids.source.toUpperCase(),
      destinationAccountId: ids.destination,
      amountMinor: '25',
      occurredAt: '2026-01-15T10:00:00Z',
    });

    expect(repository.correct.mock.calls[1]?.[1]).toMatchObject({
      domain: 'internal_transfer',
      replacement: {
        sourceAccountId: ids.source,
        destinationAccountId: ids.destination,
        amountMinor: 25n,
      },
    });
  });

  it('folds the replacement source into the canonical request hash', async () => {
    const base = {
      operationId: ids.operation,
      destinationAccountId: ids.destination,
      amountMinor: '25',
      occurredAt: '2026-01-15T10:00:00Z',
    };
    await service.replaceTransfer(principal, context, ids.target, base);
    await service.replaceTransfer(principal, context, ids.target, {
      ...base,
      sourceAccountId: ids.source,
    });
    await service.replaceTransfer(principal, context, ids.target, {
      ...base,
      sourceAccountId: ids.account,
    });

    const withoutSource = repository.correct.mock.calls[0]?.[1].requestHash;
    const withSource = repository.correct.mock.calls[1]?.[1].requestHash;
    const withOtherSource = repository.correct.mock.calls[2]?.[1].requestHash;
    expect(withSource).not.toBe(withoutSource);
    expect(withSource).not.toBe(withOtherSource);
  });

  it.each([
    ['0', 'replaceOpeningBalance'],
    ['-9223372036854775808', 'replaceOpeningBalance'],
    ['0', 'replaceOwnerEvent'],
    ['9223372036854775808', 'replaceOwnerEvent'],
  ] as const)('rejects invalid replacement amount %s', async (amountMinor, method) => {
    await expect(async () => {
      if (method === 'replaceOpeningBalance') {
        await service.replaceOpeningBalance(principal, context, ids.target, {
          operationId: ids.operation,
          amountMinor,
          occurredAt: '2026-01-15T10:00:00Z',
        });
        return;
      }
      await service.replaceOwnerEvent(principal, context, ids.target, 'owner_contribution', {
        operationId: ids.operation,
        moneyAccountId: ids.account,
        amountMinor,
        occurredAt: '2026-01-15T10:00:00Z',
      });
    }).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.correct).not.toHaveBeenCalled();
  });

  it('rejects non-owner and mismatched trusted context before persistence', async () => {
    await expect(
      service.reverse(
        { ...principal, membershipRole: 'manager' },
        context,
        ids.target,
        'opening_balance',
        { operationId: ids.operation, occurredAt: '2026-01-15T10:00:00Z' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.correct).not.toHaveBeenCalled();
  });

  it('preserves stable repository rejection codes', async () => {
    repository.correct.mockResolvedValue({
      ok: false,
      error: {
        code: 'ACCOUNTING_CORRECTION_TARGET_NOT_ACTIVE',
        message: 'The target is not the active correctable event.',
        statusCode: 409,
      },
    });

    await expect(
      service.reverse(principal, context, ids.target, 'opening_balance', {
        operationId: ids.operation,
        occurredAt: '2026-01-15T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
