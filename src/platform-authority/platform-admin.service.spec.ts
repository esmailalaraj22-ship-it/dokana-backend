import { randomUUID } from 'node:crypto';

import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import type { StoreProvisioningService } from './store-provisioning.service';
import type { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import type { PlatformAdminRepository } from './platform-admin.repository';
import { PlatformAdminService } from './platform-admin.service';

const transaction = {} as DatabaseTransaction;

describe('PlatformAdminService recovery write authority', () => {
  const context: TenantTransactionContext = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  let assertPlatformWriteAuthority: jest.Mock;
  let repository: jest.Mocked<Pick<PlatformAdminRepository, 'mutateStoreLifecycle'>>;
  let provisioning: jest.Mocked<Pick<StoreProvisioningService, 'provision'>>;
  let service: PlatformAdminService;

  beforeEach(() => {
    assertPlatformWriteAuthority = jest.fn().mockResolvedValue(undefined);
    const database = {
      withTenantTransaction: jest.fn(
        async (
          _context: TenantTransactionContext,
          work: (value: DatabaseTransaction) => Promise<unknown>,
        ) => work(transaction),
      ),
      assertPlatformWriteAuthority,
    } as unknown as DatabaseService;
    repository = {
      mutateStoreLifecycle: jest.fn().mockResolvedValue({
        storeId: context.storeId,
        status: 'suspended',
        version: 2n,
        action: 'suspend',
        changedAt: new Date('2026-10-24T00:00:00.000Z'),
        replayed: false,
      }),
    };
    provisioning = { provision: jest.fn() };
    service = new PlatformAdminService(
      database,
      repository as unknown as PlatformAdminRepository,
      {} as SubscriptionLifecycleService,
      provisioning as unknown as StoreProvisioningService,
    );
  });

  it.each([randomUUID(), randomUUID(), undefined])(
    'forwards provisioning authority unchanged, including stale or missing generation %s',
    async (recoveryGenerationId) => {
      const rejection = new Error('Provisioning authority rejected');
      provisioning.provision.mockRejectedValue(rejection);
      const operationId = randomUUID();
      await expect(
        service.provisionStore(
          { ...context, recoveryGenerationId },
          {
            operationId,
            ownerUserId: randomUUID(),
            name: 'Recovery provisioning',
            reason: 'Approved provisioning',
            activateSubscription: false,
            settings: {
              dailyReportTimeMinutes: 1200,
              defaultCreditPolicy: 'warn',
              defaultCreditLimitMinor: null,
              allowNegativeStock: false,
              lowStockAlertEnabled: true,
              debtAgeAlertDays: 30,
              backupEnabled: true,
              backupIntervalHours: 24,
            },
          },
        ),
      ).rejects.toBe(rejection);

      expect(provisioning.provision).toHaveBeenCalledTimes(1);
      expect(provisioning.provision).toHaveBeenCalledWith(
        {
          userId: context.userId,
          deviceId: context.deviceId,
          requestId: context.requestId,
          recoveryGenerationId,
        },
        expect.objectContaining({ operationId }),
      );
    },
  );

  it('holds recovery write authority on the Store lifecycle mutation transaction', async () => {
    await expect(
      service.mutateStoreLifecycle(context, context.storeId, 'suspend', {
        operationId: randomUUID(),
        expectedVersion: '1',
        reason: 'Approved suspension',
      }),
    ).resolves.toMatchObject({ status: 'suspended', version: '2' });

    expect(assertPlatformWriteAuthority).toHaveBeenCalledWith(transaction);
    expect(assertPlatformWriteAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      repository.mutateStoreLifecycle.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('leaves Store lifecycle state unchanged when recovery authority rejects', async () => {
    assertPlatformWriteAuthority.mockRejectedValue(new Error('platform fenced'));

    await expect(
      service.mutateStoreLifecycle(context, context.storeId, 'suspend', {
        operationId: randomUUID(),
        expectedVersion: '1',
        reason: 'Approved suspension',
      }),
    ).rejects.toThrow('platform fenced');

    expect(repository.mutateStoreLifecycle).not.toHaveBeenCalled();
  });
});
