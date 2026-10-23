import { randomUUID } from 'node:crypto';

import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { OfflineLicenseAdminService } from './offline-license-admin.service';
import type { OfflineLicenseRepository } from './offline-license.repository';

const transaction = {} as DatabaseTransaction;

describe('OfflineLicenseAdminService recovery write authority', () => {
  const context: TenantTransactionContext = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  let assertPlatformWriteAuthority: jest.Mock;
  let repository: jest.Mocked<Pick<OfflineLicenseRepository, 'revoke'>>;
  let service: OfflineLicenseAdminService;

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
      revoke: jest.fn().mockResolvedValue({
        licenseId: randomUUID(),
        revokedAt: new Date('2026-10-24T00:00:00.000Z'),
        revokeReason: 'Compromised device',
        replayed: false,
      }),
    };
    service = new OfflineLicenseAdminService(
      database,
      repository as unknown as OfflineLicenseRepository,
    );
  });

  it('holds recovery write authority on the revocation transaction', async () => {
    await service.revoke(context, context.storeId, randomUUID(), {
      operationId: randomUUID(),
      reason: 'Compromised device',
    });

    expect(assertPlatformWriteAuthority).toHaveBeenCalledWith(transaction);
    expect(assertPlatformWriteAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      repository.revoke.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('leaves license state unchanged when recovery authority rejects', async () => {
    assertPlatformWriteAuthority.mockRejectedValue(new Error('platform fenced'));

    await expect(
      service.revoke(context, context.storeId, randomUUID(), {
        operationId: randomUUID(),
        reason: 'Compromised device',
      }),
    ).rejects.toThrow('platform fenced');

    expect(repository.revoke).not.toHaveBeenCalled();
  });
});
