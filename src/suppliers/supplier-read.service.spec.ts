import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal, MembershipRole } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { encodeSupplierCursor, supplierCursorScopeHash } from './supplier-read-cursor';
import { SupplierReadQueryError } from './supplier-read-query-error';
import type { SupplierReadRepository } from './supplier-read.repository';
import { SupplierReadService } from './supplier-read.service';
import type { SupplierDetailRow, SupplierListRow } from './supplier-read.types';

const context: TenantTransactionContext = {
  storeId: '61000000-0000-4000-8000-000000000001',
  userId: '61000000-0000-4000-8000-000000000002',
  deviceId: '61000000-0000-4000-8000-000000000003',
  requestId: '61000000-0000-4000-8000-000000000004',
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
const firstRow: SupplierListRow = {
  id: '62000000-0000-4000-8000-000000000001',
  name: 'First Supplier',
  normalizedName: 'first supplier',
  phone: null,
  status: 'active',
  archivedAt: null,
  updatedAt: new Date('2026-08-20T08:00:00.000Z'),
  version: 9_007_199_254_740_993n,
};
const secondRow: SupplierListRow = {
  ...firstRow,
  id: '62000000-0000-4000-8000-000000000002',
  name: 'Second Supplier',
  normalizedName: 'second supplier',
  phone: '+970 599 123 456',
  version: 6n,
};

describe('SupplierReadService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
  } as jest.Mocked<Pick<SupplierReadRepository, 'list' | 'findById'>>;
  const service = new SupplierReadService(repository as unknown as SupplierReadRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to active, preserves legacy null phone, and serializes bigint losslessly', async () => {
    repository.list.mockResolvedValue([firstRow]);

    await expect(service.list(principal, context, {})).resolves.toEqual({
      items: [
        {
          id: firstRow.id,
          name: firstRow.name,
          phone: null,
          status: 'active',
          archivedAt: null,
          updatedAt: '2026-08-20T08:00:00.000Z',
          version: '9007199254740993',
        },
      ],
      nextCursor: null,
    });
    expect(repository.list).toHaveBeenCalledWith(context, {
      status: 'active',
      search: null,
      anchor: null,
      limit: 50,
    });
  });

  it('creates a scope-bound cursor from the final returned Supplier', async () => {
    repository.list.mockResolvedValue([firstRow, secondRow]);

    const result = await service.list(principal, context, {
      search: '+970 599 123 456',
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();
    expect(repository.list).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: 'active',
        search: {
          normalizedNamePrefix: '+970 599 123 456',
          canonicalPhone: '+970599123456',
        },
        limit: 1,
      }),
    );
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
          { ...principal, [field]: '61000000-0000-4000-8000-000000000099' },
          context,
          {},
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );

  it('maps cursor scope and invalid-anchor failures to stable validation errors', async () => {
    const cursor = encodeSupplierCursor({
      scopeHash: supplierCursorScopeHash('active', null),
      anchor: { id: firstRow.id, version: firstRow.version },
    });
    await expect(
      service.list(principal, context, { status: 'archived', cursor }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'cursor', constraints: ['supplierCursorScope'] }],
      },
    });

    repository.list.mockRejectedValue(new SupplierReadQueryError('cursor', 'supplierCursorAnchor'));
    await expect(service.list(principal, context, { cursor })).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'cursor', constraints: ['supplierCursorAnchor'] }],
      },
    });
  });

  it('returns active or archived detail with notes only in detail', async () => {
    const detail: SupplierDetailRow = {
      ...secondRow,
      notes: 'Private operational note',
      status: 'archived',
      archivedAt: new Date('2026-08-19T10:00:00.000Z'),
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    };
    repository.findById.mockResolvedValue(detail);

    await expect(service.getById(principal, context, secondRow.id.toUpperCase())).resolves.toEqual({
      id: secondRow.id,
      name: secondRow.name,
      phone: secondRow.phone,
      notes: 'Private operational note',
      status: 'archived',
      archivedAt: '2026-08-19T10:00:00.000Z',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-20T08:00:00.000Z',
      version: '6',
    });
    expect(repository.findById).toHaveBeenCalledWith(context, secondRow.id);
  });

  it('uses one non-disclosing not-found result for an absent Supplier', async () => {
    repository.findById.mockResolvedValue(undefined);

    await expect(service.getById(principal, context, firstRow.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
