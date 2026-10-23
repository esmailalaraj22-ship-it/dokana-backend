import { randomUUID } from 'node:crypto';

import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type { SubscriptionLifecycleRepository } from './subscription-lifecycle.repository';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import type { SubscriptionLifecycleResult } from './subscription-lifecycle.types';

const transaction = {} as DatabaseTransaction;

function result(action: SubscriptionLifecycleResult['action']): SubscriptionLifecycleResult {
  return {
    subscriptionId: randomUUID(),
    planId: randomUUID(),
    status: action === 'cancel' ? 'cancelled' : 'active',
    startsAt: new Date('2026-10-03T00:00:00Z'),
    endsAt: new Date('2026-11-02T00:00:00Z'),
    cancelledAt: action === 'cancel' ? new Date('2026-10-04T00:00:00Z') : null,
    version: 1n,
    action,
    changedAt: new Date('2026-10-03T00:00:00Z'),
    replayed: false,
  };
}

describe('SubscriptionLifecycleService', () => {
  const context: TenantTransactionContext = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  let database: DatabaseService;
  let withTenantTransaction: jest.Mock;
  let assertPlatformWriteAuthority: jest.Mock;
  let repository: jest.Mocked<
    Pick<SubscriptionLifecycleRepository, 'mutate' | 'readLifecycle' | 'readHistory'>
  >;
  let service: SubscriptionLifecycleService;

  beforeEach(() => {
    withTenantTransaction = jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (value: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    );
    assertPlatformWriteAuthority = jest.fn().mockResolvedValue(undefined);
    database = {
      withTenantTransaction,
      assertPlatformWriteAuthority,
    } as unknown as DatabaseService;
    repository = {
      mutate: jest.fn(async (_transaction, _storeId, input) => result(input.action)),
      readLifecycle: jest.fn().mockResolvedValue([]),
      readHistory: jest.fn().mockResolvedValue([]),
    };
    service = new SubscriptionLifecycleService(
      database,
      repository as unknown as SubscriptionLifecycleRepository,
    );
  });

  it.each(['activate', 'extend', 'cancel', 'reactivate'] as const)(
    'prepares a canonical %s mutation without accepting client time',
    async (action) => {
      const operationId = randomUUID().toUpperCase();
      const response = await service[action](context, {
        operationId,
        reason: '  Approved lifecycle reason  ',
      });

      expect(response.action).toBe(action);
      expect(assertPlatformWriteAuthority).toHaveBeenCalledWith(transaction);
      expect(repository.mutate).toHaveBeenCalledWith(
        transaction,
        context.storeId,
        expect.objectContaining({
          action,
          operationId: operationId.toLowerCase(),
          reason: 'Approved lifecycle reason',
        }),
      );
      expect(assertPlatformWriteAuthority.mock.invocationCallOrder[0]).toBeLessThan(
        repository.mutate.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
      expect(repository.mutate.mock.calls[0]?.[2].requestHash).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it('rejects missing reasons and invalid identifiers before opening a transaction', async () => {
    expect(() => service.extend(context, { operationId: randomUUID(), reason: '   ' })).toThrow(
      TypeError,
    );
    expect(() =>
      service.cancel(context, { operationId: 'invalid', reason: 'Valid reason' }),
    ).toThrow(TypeError);
    expect(withTenantTransaction).not.toHaveBeenCalled();
  });

  it('uses distinct canonical hashes for distinct lifecycle semantics', async () => {
    const operationId = randomUUID();
    await service.extend(context, { operationId, reason: 'Reason' });
    await service.cancel(context, { operationId, reason: 'Reason' });
    const first = repository.mutate.mock.calls[0]?.[2];
    const second = repository.mutate.mock.calls[1]?.[2];
    expect(first?.requestHash).not.toBe(second?.requestHash);
  });

  it('does not mutate subscription state when recovery write authority rejects', async () => {
    assertPlatformWriteAuthority.mockRejectedValue(new Error('platform fenced'));

    await expect(
      service.activate(context, { operationId: randomUUID(), reason: 'Approved activation' }),
    ).rejects.toThrow('platform fenced');

    expect(repository.mutate).not.toHaveBeenCalled();
  });
});
