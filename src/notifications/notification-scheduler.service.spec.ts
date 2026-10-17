import type { TenantTransactionContext } from '../database/database.types';
import type { NotificationReconcilerService } from './notification-reconciler.service';
import { NotificationSchedulerService } from './notification-scheduler.service';

const context: TenantTransactionContext = {
  storeId: '25000000-0000-4000-8000-000000000001',
  userId: '25000000-0000-4000-8000-000000000002',
  deviceId: '25000000-0000-4000-8000-000000000003',
  requestId: '25000000-0000-4000-8000-000000000004',
};

describe('NotificationSchedulerService', () => {
  const reconciler = {
    reconcile: jest.fn(),
  } as jest.Mocked<Pick<NotificationReconcilerService, 'reconcile'>>;
  let service: NotificationSchedulerService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-16T10:00:00.000Z') });
    jest.clearAllMocks();
    reconciler.reconcile.mockResolvedValue();
    service = new NotificationSchedulerService(
      reconciler as unknown as NotificationReconcilerService,
    );
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('runs one bounded deferred repair with a fresh server request identity', async () => {
    service.track(context, new Date('2026-10-16T10:05:00.000Z'));

    await jest.advanceTimersByTimeAsync(30_000);

    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
    const reconciliationContext = reconciler.reconcile.mock.calls[0]?.[0];
    expect(reconciliationContext).toMatchObject({
      storeId: context.storeId,
      userId: context.userId,
      deviceId: context.deviceId,
    });
    expect(reconciliationContext?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
  });

  it('drops expired contexts and contains reconciliation failures', async () => {
    service.track(context, new Date('2026-10-16T10:00:01.000Z'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(reconciler.reconcile).not.toHaveBeenCalled();

    reconciler.reconcile.mockRejectedValueOnce(new Error('temporary failure'));
    service.track(context, new Date('2026-10-16T10:05:00.000Z'));
    await expect(jest.advanceTimersByTimeAsync(30_000)).resolves.toBeUndefined();
  });
});
