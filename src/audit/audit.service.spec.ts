import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { decodeAuditCursor, auditCursorScopeHash } from './audit-cursor';
import type { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import type { AuditBusinessRow } from './audit.types';

const context: TenantTransactionContext = {
  storeId: 'a3200000-0000-4000-8000-000000000001',
  userId: 'a3200000-0000-4000-8000-000000000002',
  deviceId: 'a3200000-0000-4000-8000-000000000003',
  requestId: 'a3200000-0000-4000-8000-000000000004',
};

const principal: Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
> = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
};

const first: AuditBusinessRow = {
  eventId: 'a3300000-0000-4000-8000-000000000002',
  action: 'SALE_CREATED',
  entityType: 'sale',
  entityId: 'a3300000-0000-4000-8000-000000000010',
  entityReference: 'S-100',
  actorType: 'user',
  actorUserId: context.userId,
  actorDisplayName: 'Store Owner',
  occurredAt: new Date('2026-10-17T10:00:00.000Z'),
  businessDate: '2026-10-17',
  context: { totalMinor: '15000', paidTotalMinor: '15000' },
};

const second: AuditBusinessRow = {
  ...first,
  eventId: 'a3300000-0000-4000-8000-000000000001',
  action: 'STORE_SETTINGS_UPDATED',
  entityType: 'store_settings',
  entityId: context.storeId,
  entityReference: null,
  occurredAt: new Date('2026-10-17T09:00:00.000Z'),
  businessDate: null,
  context: { changes: { debtAgeAlertDays: { previous: 30, current: 45 } } },
};

describe('AuditService', () => {
  const repository = {
    list: jest.fn(),
  } as jest.Mocked<Pick<AuditRepository, 'list'>>;
  const service = new AuditService(repository as unknown as AuditRepository);

  beforeEach(() => jest.clearAllMocks());

  it('maps semantic events and emits a Store/filter-bound next cursor', async () => {
    repository.list.mockResolvedValue([first, second]);
    const query = {
      occurredFrom: '2026-01-01T00:00:00.000Z',
      occurredTo: '2026-12-31T23:59:59.999Z',
      actorUserId: context.userId,
      action: 'SALE_CREATED' as const,
      entityType: 'sale' as const,
      entityId: first.entityId,
      limit: 1,
    };

    const result = await service.list(principal, context, query);

    expect(repository.list).toHaveBeenCalledWith(context, {
      occurredFrom: new Date(query.occurredFrom),
      occurredTo: new Date(query.occurredTo),
      actorUserId: context.userId,
      action: 'SALE_CREATED',
      entityType: 'sale',
      entityId: first.entityId,
      limit: 1,
      anchor: null,
    });
    expect(result.items).toEqual([
      {
        id: first.eventId,
        action: 'SALE_CREATED',
        summary: 'Sale posted',
        entity: { type: 'sale', id: first.entityId, reference: 'S-100' },
        actor: { type: 'user', userId: context.userId, displayName: 'Store Owner' },
        occurredAt: '2026-10-17T10:00:00.000Z',
        businessDate: '2026-10-17',
        context: first.context,
      },
    ]);
    const cursor = result.nextCursor;
    expect(cursor).not.toBeNull();
    expect(
      decodeAuditCursor(
        cursor ?? '',
        auditCursorScopeHash({
          storeId: context.storeId,
          occurredFrom: new Date(query.occurredFrom),
          occurredTo: new Date(query.occurredTo),
          actorUserId: context.userId,
          action: 'SALE_CREATED',
          entityType: 'sale',
          entityId: first.entityId,
        }),
      ),
    ).toEqual({ occurredAt: first.occurredAt, eventId: first.eventId });
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before persistence',
    async (membershipRole) => {
      await expect(
        service.list({ ...principal, membershipRole }, context, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects mismatched trusted %s context',
    async (field) => {
      await expect(
        service.list(
          { ...principal, [field]: 'a3200000-0000-4000-8000-000000000099' },
          context,
          {},
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('rejects an inverted date range before persistence', async () => {
    await expect(
      service.list(principal, context, {
        occurredFrom: '2026-10-18T00:00:00.000Z',
        occurredTo: '2026-10-17T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.list).not.toHaveBeenCalled();
  });
});
