import { ForbiddenException } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import { BackupStatusService } from './backup-status.service';
import type { RecoveryHealthService } from './recovery-health.service';

const context: TenantTransactionContext = {
  storeId: '44000000-0000-4000-8000-000000000001',
  userId: '44000000-0000-4000-8000-000000000002',
  deviceId: '44000000-0000-4000-8000-000000000003',
  requestId: '44000000-0000-4000-8000-000000000004',
};

describe('BackupStatusService', () => {
  const health = {
    evaluate: jest.fn(),
  } as jest.Mocked<Pick<RecoveryHealthService, 'evaluate'>>;
  const service = new BackupStatusService(health as unknown as RecoveryHealthService);

  beforeEach(() => {
    jest.clearAllMocks();
    health.evaluate.mockResolvedValue({
      protectionStatus: 'protected',
      logicalBackupStatus: 'healthy',
      pitrStatus: 'unverified',
      lastVerifiedRecoveryPointAt: new Date('2026-10-19T00:00:00.000Z'),
      attentionRequired: false,
    });
  });

  it('returns only safe high-level status to the matching Store Owner', async () => {
    await expect(
      service.get(
        {
          membershipRole: 'owner',
          storeId: context.storeId,
          userId: context.userId,
          deviceId: context.deviceId,
        },
        context,
      ),
    ).resolves.toEqual({
      protectionStatus: 'protected',
      logicalBackupStatus: 'healthy',
      pitrStatus: 'unverified',
      lastVerifiedRecoveryPointAt: '2026-10-19T00:00:00.000Z',
      attentionRequired: false,
    });
  });

  it.each(['manager', 'viewer', 'support'] as const)('blocks %s access', async (membershipRole) => {
    await expect(
      service.get(
        {
          membershipRole,
          storeId: context.storeId,
          userId: context.userId,
          deviceId: context.deviceId,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(health.evaluate).not.toHaveBeenCalled();
  });
});
