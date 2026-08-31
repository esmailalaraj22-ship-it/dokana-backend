import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type { MoneyAccountReadRepository } from './money-account-read.repository';
import { MoneyAccountReadService } from './money-account-read.service';
import type { MoneyAccountReadRow } from './money-account-read.types';

const context: TenantTransactionContext = {
  storeId: '81000000-0000-4000-8000-000000000001',
  userId: '81000000-0000-4000-8000-000000000002',
  deviceId: '81000000-0000-4000-8000-000000000003',
  requestId: '81000000-0000-4000-8000-000000000004',
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
const cashRow: MoneyAccountReadRow = {
  id: '82000000-0000-4000-8000-000000000001',
  name: 'الصندوق',
  accountType: 'cash',
  isDefault: true,
  status: 'active',
  archivedAt: null,
  createdAt: new Date('2026-08-30T08:00:00.000Z'),
  updatedAt: new Date('2026-08-31T09:00:00.000Z'),
  version: 9_007_199_254_740_993n,
};
const archivedTransferRow: MoneyAccountReadRow = {
  ...cashRow,
  id: '82000000-0000-4000-8000-000000000002',
  name: 'Bank Account',
  accountType: 'transfer',
  isDefault: false,
  status: 'archived',
  archivedAt: new Date('2026-09-01T10:00:00.000Z'),
  version: 4n,
};

describe('MoneyAccountReadService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
  } as jest.Mocked<Pick<MoneyAccountReadRepository, 'list' | 'findById'>>;
  const service = new MoneyAccountReadService(repository as unknown as MoneyAccountReadRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults lists to active and emits only the lossless public projection', async () => {
    repository.list.mockResolvedValue([cashRow]);

    const response = await service.list(principal, context, {});
    expect(response).toEqual({
      items: [
        {
          id: cashRow.id,
          name: 'الصندوق',
          accountType: 'cash',
          isDefault: true,
          status: 'active',
          archivedAt: null,
          createdAt: '2026-08-30T08:00:00.000Z',
          updatedAt: '2026-08-31T09:00:00.000Z',
          version: '9007199254740993',
        },
      ],
    });
    expect(repository.list).toHaveBeenCalledWith(context, { status: 'active' });
    expect(Object.keys(response.items[0] ?? {}).sort()).toEqual([
      'accountType',
      'archivedAt',
      'createdAt',
      'id',
      'isDefault',
      'name',
      'status',
      'updatedAt',
      'version',
    ]);
  });

  it('supports archived listing and same-store archived detail', async () => {
    repository.list.mockResolvedValue([archivedTransferRow]);
    repository.findById.mockResolvedValue(archivedTransferRow);

    await expect(service.list(principal, context, { status: 'archived' })).resolves.toMatchObject({
      items: [{ id: archivedTransferRow.id, status: 'archived' }],
    });
    await expect(
      service.getById(principal, context, archivedTransferRow.id.toUpperCase()),
    ).resolves.toEqual({
      id: archivedTransferRow.id,
      name: 'Bank Account',
      accountType: 'transfer',
      isDefault: false,
      status: 'archived',
      archivedAt: '2026-09-01T10:00:00.000Z',
      createdAt: '2026-08-30T08:00:00.000Z',
      updatedAt: '2026-08-31T09:00:00.000Z',
      version: '4',
    });
    expect(repository.list).toHaveBeenCalledWith(context, { status: 'archived' });
    expect(repository.findById).toHaveBeenCalledWith(context, archivedTransferRow.id);
  });

  it.each<MembershipRole>(['manager', 'viewer', 'support'])(
    'rejects the %s role before repository access',
    async (membershipRole) => {
      await expect(
        service.list({ ...principal, membershipRole }, context, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it.each(['storeId', 'userId', 'deviceId'] as const)(
    'rejects a mismatched trusted %s before repository access',
    async (field) => {
      await expect(
        service.list(
          { ...principal, [field]: '81000000-0000-4000-8000-000000000099' },
          context,
          {},
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it('uses one stable not-found result for every unavailable detail', async () => {
    repository.findById.mockResolvedValue(undefined);

    await expect(service.getById(principal, context, cashRow.id)).rejects.toMatchObject({
      status: 404,
      response: {
        code: 'MONEY_ACCOUNT_NOT_FOUND',
        message: 'Money Account not found.',
      },
    });
    await expect(service.getById(principal, context, cashRow.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
