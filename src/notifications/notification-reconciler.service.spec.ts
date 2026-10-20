import type { TenantTransactionContext } from '../database/database.types';
import type { RecoveryHealthService } from '../recovery/recovery-health.service';
import { NotificationReconcilerService } from './notification-reconciler.service';
import type { NotificationRepository } from './notification.repository';

const context: TenantTransactionContext = {
  storeId: '45000000-0000-4000-8000-000000000001',
  userId: '45000000-0000-4000-8000-000000000002',
  deviceId: '45000000-0000-4000-8000-000000000003',
  requestId: '45000000-0000-4000-8000-000000000004',
};

describe('NotificationReconcilerService recovery integration', () => {
  const repository = { reconcile: jest.fn() } as jest.Mocked<
    Pick<NotificationRepository, 'reconcile'>
  >;
  const health = { notificationCause: jest.fn() } as jest.Mocked<
    Pick<RecoveryHealthService, 'notificationCause'>
  >;
  const service = new NotificationReconcilerService(
    repository as unknown as NotificationRepository,
    health as unknown as RecoveryHealthService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.reconcile.mockResolvedValue();
  });

  it('evaluates external protection before opening the tenant notification transaction', async () => {
    const cause = {
      key: `s21:v1:backup_failure:backup_protection:${context.storeId}`,
      type: 'backup_failure' as const,
      severity: 'critical' as const,
      title: 'Backup protection needs attention',
      body: 'There is a problem protecting your Store data backup.',
      entityType: 'backup_protection',
      entityId: context.storeId,
    };
    health.notificationCause.mockResolvedValue(cause);
    await service.reconcile(context);
    expect(health.notificationCause).toHaveBeenCalledWith(context.storeId);
    expect(repository.reconcile).toHaveBeenCalledWith(context, [cause]);
    expect(health.notificationCause.mock.invocationCallOrder[0]).toBeLessThan(
      repository.reconcile.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('passes no backup cause while verified protection remains acceptable', async () => {
    health.notificationCause.mockResolvedValue(null);
    await service.reconcile(context);
    expect(repository.reconcile).toHaveBeenCalledWith(context, []);
  });
});
