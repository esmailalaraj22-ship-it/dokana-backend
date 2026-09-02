import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { AccountingPeriodReadRepository } from './accounting-period-read.repository';
import { AccountingPeriodReadService } from './accounting-period-read.service';
import type { AccountingPeriodReadRow } from './accounting-period-read.types';

const context: TenantTransactionContext = {
  storeId: '91000000-0000-4000-8000-000000000001',
  userId: '91000000-0000-4000-8000-000000000002',
  deviceId: '91000000-0000-4000-8000-000000000003',
  requestId: '91000000-0000-4000-8000-000000000004',
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
const openRow: AccountingPeriodReadRow = {
  id: '92000000-0000-4000-8000-000000000001',
  periodYear: 2026,
  periodMonth: 9,
  startsAt: new Date('2026-08-31T21:00:00.000Z'),
  endsAt: new Date('2026-09-30T21:00:00.000Z'),
  status: 'open',
  closedAt: null,
  createdAt: new Date('2026-08-30T08:00:00.000Z'),
  updatedAt: new Date('2026-08-31T09:00:00.000Z'),
  version: 9_007_199_254_740_993n,
};
const closedRow: AccountingPeriodReadRow = {
  ...openRow,
  id: '92000000-0000-4000-8000-000000000002',
  periodMonth: 8,
  startsAt: new Date('2026-07-31T21:00:00.000Z'),
  endsAt: new Date('2026-08-31T21:00:00.000Z'),
  status: 'closed',
  closedAt: new Date('2026-09-01T10:00:00.000Z'),
  version: 4n,
};

describe('AccountingPeriodReadService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
  } as jest.Mocked<Pick<AccountingPeriodReadRepository, 'list' | 'findById'>>;
  const service = new AccountingPeriodReadService(
    repository as unknown as AccountingPeriodReadRepository,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the repository order with the minimal UTC and lossless projection', async () => {
    repository.list.mockResolvedValue([openRow, closedRow]);

    const response = await service.list(principal, context);

    expect(response).toEqual({
      items: [
        {
          id: openRow.id,
          periodYear: 2026,
          periodMonth: 9,
          startsAt: '2026-08-31T21:00:00.000Z',
          endsAt: '2026-09-30T21:00:00.000Z',
          status: 'open',
          closedAt: null,
          createdAt: '2026-08-30T08:00:00.000Z',
          updatedAt: '2026-08-31T09:00:00.000Z',
          version: '9007199254740993',
        },
        {
          id: closedRow.id,
          periodYear: 2026,
          periodMonth: 8,
          startsAt: '2026-07-31T21:00:00.000Z',
          endsAt: '2026-08-31T21:00:00.000Z',
          status: 'closed',
          closedAt: '2026-09-01T10:00:00.000Z',
          createdAt: '2026-08-30T08:00:00.000Z',
          updatedAt: '2026-08-31T09:00:00.000Z',
          version: '4',
        },
      ],
    });
    expect(repository.list).toHaveBeenCalledWith(context);
    expect(Object.keys(response.items[0] ?? {}).sort()).toEqual([
      'closedAt',
      'createdAt',
      'endsAt',
      'id',
      'periodMonth',
      'periodYear',
      'startsAt',
      'status',
      'updatedAt',
      'version',
    ]);
  });

  it('canonicalizes detail UUIDs and returns the same public projection', async () => {
    repository.findById.mockResolvedValue(closedRow);

    await expect(service.getById(principal, context, closedRow.id.toUpperCase())).resolves.toEqual({
      id: closedRow.id,
      periodYear: 2026,
      periodMonth: 8,
      startsAt: '2026-07-31T21:00:00.000Z',
      endsAt: '2026-08-31T21:00:00.000Z',
      status: 'closed',
      closedAt: '2026-09-01T10:00:00.000Z',
      createdAt: '2026-08-30T08:00:00.000Z',
      updatedAt: '2026-08-31T09:00:00.000Z',
      version: '4',
    });
    expect(repository.findById).toHaveBeenCalledWith(context, closedRow.id);
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before repository access',
    async (membershipRole) => {
      await expect(service.list({ ...principal, membershipRole }, context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects a mismatched trusted %s before repository access',
    async (field) => {
      await expect(
        service.list({ ...principal, [field]: '91000000-0000-4000-8000-000000000099' }, context),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it('uses one stable not-found result for absent and tenant-hidden detail', async () => {
    repository.findById.mockResolvedValue(undefined);

    await expect(service.getById(principal, context, openRow.id)).rejects.toMatchObject({
      status: 404,
      response: {
        code: 'ACCOUNTING_PERIOD_NOT_FOUND',
        message: 'Accounting Period not found.',
      },
    });
    await expect(service.getById(principal, context, openRow.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
