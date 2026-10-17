import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { decodeNotificationCursor, notificationCursorScopeHash } from './notification-cursor';
import type { NotificationReconcilerService } from './notification-reconciler.service';
import type { NotificationRepository } from './notification.repository';
import type { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationService } from './notification.service';
import type { NotificationListRow } from './notification.types';

const context: TenantTransactionContext = {
  storeId: '21000000-0000-4000-8000-000000000001',
  userId: '21000000-0000-4000-8000-000000000002',
  deviceId: '21000000-0000-4000-8000-000000000003',
  requestId: '21000000-0000-4000-8000-000000000004',
};

const principal: Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId' | 'sessionExpiresAt'
> = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
  sessionExpiresAt: new Date('2026-10-17T10:00:00.000Z'),
};

const first: NotificationListRow = {
  id: '22000000-0000-4000-8000-000000000002',
  type: 'customer_debt_amount',
  severity: 'warning',
  title: 'Debt threshold reached',
  body: 'A customer balance requires attention.',
  entityType: 'customer',
  entityId: '22000000-0000-4000-8000-000000000011',
  resolvedAt: null,
  readAt: new Date('2026-10-16T09:00:00.000Z'),
  createdAt: new Date('2026-10-16T08:00:00.000Z'),
  updatedAt: new Date('2026-10-16T09:00:00.000Z'),
};

const second: NotificationListRow = {
  ...first,
  id: '22000000-0000-4000-8000-000000000001',
  type: 'supplier_due',
  entityType: 'supplier_invoice',
  entityId: '22000000-0000-4000-8000-000000000012',
  readAt: null,
  createdAt: new Date('2026-10-15T08:00:00.000Z'),
};

describe('NotificationService', () => {
  const repository = {
    list: jest.fn(),
    setReadState: jest.fn(),
  } as jest.Mocked<Pick<NotificationRepository, 'list' | 'setReadState'>>;
  const reconciler = {
    reconcile: jest.fn(),
  } as jest.Mocked<Pick<NotificationReconcilerService, 'reconcile'>>;
  const scheduler = {
    track: jest.fn(),
  } as jest.Mocked<Pick<NotificationSchedulerService, 'track'>>;
  const service = new NotificationService(
    repository as unknown as NotificationRepository,
    reconciler as unknown as NotificationReconcilerService,
    scheduler as unknown as NotificationSchedulerService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    reconciler.reconcile.mockResolvedValue();
  });

  it('reconciles, maps user presentation state, and emits a scope-bound next cursor', async () => {
    repository.list.mockResolvedValue([first, second]);

    const result = await service.list(principal, context, {
      lifecycle: 'active',
      read: 'true',
      type: 'customer_debt_amount',
      limit: 1,
    });

    expect(reconciler.reconcile).toHaveBeenCalledWith(context);
    expect(scheduler.track).toHaveBeenCalledWith(context, principal.sessionExpiresAt);
    expect(repository.list).toHaveBeenCalledWith(context, {
      lifecycle: 'active',
      read: true,
      type: 'customer_debt_amount',
      limit: 1,
      anchor: null,
    });
    expect(result.items).toEqual([
      {
        id: first.id,
        type: first.type,
        severity: first.severity,
        title: first.title,
        body: first.body,
        subject: { type: 'customer', id: first.entityId },
        lifecycle: 'active',
        read: true,
        readAt: '2026-10-16T09:00:00.000Z',
        resolvedAt: null,
        createdAt: '2026-10-16T08:00:00.000Z',
        updatedAt: '2026-10-16T09:00:00.000Z',
      },
    ]);
    const cursor = result.nextCursor;
    expect(cursor).not.toBeNull();
    expect(
      decodeNotificationCursor(
        cursor ?? '',
        notificationCursorScopeHash('active', true, 'customer_debt_amount'),
      ),
    ).toEqual({ createdAt: first.createdAt, id: first.id });
  });

  it('still serves committed notification state when reconciliation fails', async () => {
    reconciler.reconcile.mockRejectedValueOnce(new Error('reconciliation unavailable'));
    repository.list.mockResolvedValue([second]);

    await expect(service.list(principal, context, {})).resolves.toMatchObject({
      items: [{ id: second.id }],
      nextCursor: null,
    });
    expect(repository.list).toHaveBeenCalled();
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before reconciliation or persistence',
    async (membershipRole) => {
      await expect(
        service.list({ ...principal, membershipRole }, context, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reconciler.reconcile).not.toHaveBeenCalled();
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects mismatched trusted %s context',
    async (field) => {
      await expect(
        service.list(
          { ...principal, [field]: '21000000-0000-4000-8000-000000000099' },
          context,
          {},
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('sets only user presentation state and canonicalizes the notification UUID', async () => {
    repository.setReadState.mockResolvedValue(new Date('2026-10-16T10:00:00.000Z'));
    const uppercaseId = first.id.toUpperCase();

    await expect(service.setReadState(principal, context, uppercaseId, true)).resolves.toEqual({
      id: first.id,
      read: true,
      readAt: '2026-10-16T10:00:00.000Z',
    });
    expect(repository.setReadState).toHaveBeenCalledWith(context, first.id, true);
  });

  it('returns the same not-found boundary for invalid and absent notification identifiers', async () => {
    await expect(
      service.setReadState(principal, context, 'not-a-uuid', true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.setReadState).not.toHaveBeenCalled();

    repository.setReadState.mockResolvedValue(undefined);
    await expect(service.setReadState(principal, context, first.id, true)).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOTIFICATION_NOT_FOUND' },
    });
  });
});
