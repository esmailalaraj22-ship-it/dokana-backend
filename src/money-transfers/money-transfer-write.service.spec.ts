import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
} from '../money-movements/money-movement-identity';
import { OperationalTimeService } from '../settings/operational-time.service';
import type { MoneyTransferPostingRepository } from './money-transfer-posting.repository';
import type {
  MoneyTransferMutationResponse,
  MoneyTransferMutationResult,
} from './money-transfer.types';
import { MoneyTransferWriteService } from './money-transfer-write.service';

const ids = {
  store: '10000000-0000-4000-8000-000000000001',
  user: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  request: '10000000-0000-4000-8000-000000000004',
  source: '10000000-0000-4000-8000-000000000005',
  destination: '10000000-0000-4000-8000-000000000006',
  operation: '10000000-0000-4000-8000-000000000007',
  period: '10000000-0000-4000-8000-000000000008',
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

const occurredAt = '2026-01-31T22:30:00.000Z';
const response: MoneyTransferMutationResponse = {
  operationId: ids.operation,
  postingDate: '2026-02-01',
  accountingPeriodId: ids.period,
  transfer: {
    id: deriveMoneyFactId(ids.operation, 'transfer-header'),
    displayNumber: 'T1-2026-000001',
    sourceAccountId: ids.source,
    destinationAccountId: ids.destination,
    amountMinor: '25',
    transferAt: occurredAt,
    sourceMovementId: deriveMoneyFactId(ids.operation, 'transfer-source'),
    destinationMovementId: deriveMoneyFactId(ids.operation, 'transfer-destination'),
    status: 'posted',
    operationId: deriveMoneyFactOperationId(ids.operation, 'transfer-header'),
    createdAt: '2026-02-01T08:00:00.000Z',
    updatedAt: '2026-02-01T08:00:00.000Z',
    version: '1',
  },
  movements: [
    {
      id: deriveMoneyFactId(ids.operation, 'transfer-source'),
      accountId: ids.source,
      accountingPeriodId: ids.period,
      movementType: 'internal_transfer',
      amountDeltaMinor: '-25',
      transactionGroupId: ids.operation,
      operationId: deriveMoneyFactOperationId(ids.operation, 'transfer-source'),
      occurredAt,
      createdAt: '2026-02-01T08:00:00.000Z',
    },
    {
      id: deriveMoneyFactId(ids.operation, 'transfer-destination'),
      accountId: ids.destination,
      accountingPeriodId: ids.period,
      movementType: 'internal_transfer',
      amountDeltaMinor: '25',
      transactionGroupId: ids.operation,
      operationId: deriveMoneyFactOperationId(ids.operation, 'transfer-destination'),
      occurredAt,
      createdAt: '2026-02-01T08:00:00.000Z',
    },
  ],
};

describe('MoneyTransferWriteService', () => {
  const repository = {
    post: jest.fn<
      Promise<MoneyTransferMutationResult>,
      Parameters<MoneyTransferPostingRepository['post']>
    >(),
  };
  const service = new MoneyTransferWriteService(
    repository as unknown as MoneyTransferPostingRepository,
    new OperationalTimeService(),
  );

  beforeEach(() => {
    repository.post.mockReset();
    repository.post.mockResolvedValue({ ok: true, response });
  });

  it('canonicalizes exact intent and derives the Asia/Hebron posting date', async () => {
    await service.create(principal, context, {
      operationId: ids.operation.toUpperCase(),
      sourceAccountId: ids.source.toUpperCase(),
      destinationAccountId: ids.destination.toUpperCase(),
      amountMinor: '25',
      occurredAt,
    });

    const call = repository.post.mock.calls[0];
    expect(call?.[0]).toBe(context);
    expect(call?.[1]).toMatchObject({
      operationId: ids.operation,
      sourceAccountId: ids.source,
      destinationAccountId: ids.destination,
      amountMinor: 25n,
      occurredAt: new Date(occurredAt),
      postingDate: '2026-02-01',
    });
    expect(call?.[1].requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes equivalent instants while preserving transfer direction in request identity', async () => {
    await service.create(principal, context, {
      operationId: ids.operation,
      sourceAccountId: ids.source,
      destinationAccountId: ids.destination,
      amountMinor: '25',
      occurredAt: '2026-01-15T12:00:00+02:00',
    });
    await service.create(principal, context, {
      operationId: ids.operation,
      sourceAccountId: ids.source,
      destinationAccountId: ids.destination,
      amountMinor: '25',
      occurredAt: '2026-01-15T10:00:00Z',
    });
    await service.create(principal, context, {
      operationId: ids.operation,
      sourceAccountId: ids.destination,
      destinationAccountId: ids.source,
      amountMinor: '25',
      occurredAt: '2026-01-15T10:00:00Z',
    });

    const first = repository.post.mock.calls[0]?.[1].requestHash;
    const second = repository.post.mock.calls[1]?.[1].requestHash;
    const reversed = repository.post.mock.calls[2]?.[1].requestHash;
    expect(first).toBe(second);
    expect(reversed).not.toBe(first);
  });

  it('accepts the exact positive PostgreSQL bigint maximum without Number conversion', async () => {
    await service.create(principal, context, {
      operationId: ids.operation,
      sourceAccountId: ids.source,
      destinationAccountId: ids.destination,
      amountMinor: '9223372036854775807',
      occurredAt,
    });

    expect(repository.post.mock.calls[0]?.[1].amountMinor).toBe(9_223_372_036_854_775_807n);
  });

  it.each(['0', '-1', '9223372036854775808', '1.5', '01'])(
    'rejects invalid transfer amount %s before persistence',
    async (amountMinor) => {
      await expect(
        service.create(principal, context, {
          operationId: ids.operation,
          sourceAccountId: ids.source,
          destinationAccountId: ids.destination,
          amountMinor,
          occurredAt,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.post).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed identifiers and non-absolute instants before persistence', async () => {
    await expect(
      service.create(principal, context, {
        operationId: ids.operation,
        sourceAccountId: 'not-a-uuid',
        destinationAccountId: ids.destination,
        amountMinor: '1',
        occurredAt,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(principal, context, {
        operationId: ids.operation,
        sourceAccountId: ids.source,
        destinationAccountId: ids.destination,
        amountMinor: '1',
        occurredAt: '2026-02-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.post).not.toHaveBeenCalled();
  });

  it('rejects non-owner and mismatched trusted context before persistence', async () => {
    await expect(
      service.create({ ...principal, membershipRole: 'viewer' }, context, {
        operationId: ids.operation,
        sourceAccountId: ids.source,
        destinationAccountId: ids.destination,
        amountMinor: '1',
        occurredAt,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(
        principal,
        { ...context, deviceId: ids.request },
        {
          operationId: ids.operation,
          sourceAccountId: ids.source,
          destinationAccountId: ids.destination,
          amountMinor: '1',
          occurredAt,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.post).not.toHaveBeenCalled();
  });

  it('preserves stable stored rejection codes', async () => {
    repository.post.mockResolvedValue({
      ok: false,
      error: {
        code: 'MONEY_TRANSFER_SAME_ACCOUNT',
        message: 'Transfer source and destination must differ.',
        statusCode: 409,
      },
    });

    await expect(
      service.create(principal, context, {
        operationId: ids.operation,
        sourceAccountId: ids.source,
        destinationAccountId: ids.source,
        amountMinor: '1',
        occurredAt,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
