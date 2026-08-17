import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import { encodeProductCursor, productCursorScopeHash } from './product-read-cursor';
import { ProductReadQueryError } from './product-read-query-error';
import type { ProductReadRepository } from './product-read.repository';
import { ProductReadService } from './product-read.service';
import type { ProductDetailRecord, ProductListRow } from './product-read.types';

const context: TenantTransactionContext = {
  storeId: '51000000-0000-4000-8000-000000000001',
  userId: '51000000-0000-4000-8000-000000000002',
  deviceId: '51000000-0000-4000-8000-000000000003',
  requestId: '51000000-0000-4000-8000-000000000004',
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
const firstRow: ProductListRow = {
  id: '52000000-0000-4000-8000-000000000001',
  name: 'زيت زيتون',
  normalizedName: 'زيت زيتون',
  sku: 'Oil-001',
  barcode: '001234',
  measurementType: 'volume',
  trackInventory: true,
  allowNegativeStockOverride: null,
  lowStockThresholdMilli: 9_007_199_254_740_993n,
  isPinned: true,
  status: 'active',
  archivedAt: null,
  updatedAt: new Date('2026-08-17T08:00:00.000Z'),
  version: 5n,
};
const secondRow: ProductListRow = {
  ...firstRow,
  id: '52000000-0000-4000-8000-000000000002',
  name: 'زيت نباتي',
  normalizedName: 'زيت نباتي',
  version: 6n,
};

describe('ProductReadService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
  } as jest.Mocked<Pick<ProductReadRepository, 'list' | 'findById'>>;
  const service = new ProductReadService(repository as unknown as ProductReadRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to the active owner list and serializes bigint fields losslessly', async () => {
    repository.list.mockResolvedValue([firstRow]);

    await expect(service.list(principal, context, {})).resolves.toEqual({
      items: [
        {
          id: firstRow.id,
          name: firstRow.name,
          sku: 'Oil-001',
          barcode: '001234',
          measurementType: 'volume',
          trackInventory: true,
          allowNegativeStockOverride: null,
          lowStockThresholdMilli: '9007199254740993',
          isPinned: true,
          status: 'active',
          archivedAt: null,
          updatedAt: '2026-08-17T08:00:00.000Z',
          version: '5',
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

  it('creates a scope-bound cursor from the final returned row', async () => {
    repository.list.mockResolvedValue([firstRow, secondRow]);

    const result = await service.list(principal, context, { search: ' زيت ', limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();
    expect(repository.list).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: 'active',
        search: {
          normalizedNamePrefix: 'زيت',
          canonicalSku: 'زيت',
          canonicalBarcode: 'زيت',
        },
        limit: 1,
      }),
    );
  });

  it('rejects non-owner and mismatched trusted principals before database access', async () => {
    await expect(
      service.list({ ...principal, membershipRole: 'viewer' }, context, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.list({ ...principal, storeId: '51000000-0000-4000-8000-000000000099' }, context, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('rejects cursor scope mismatch and invalid anchors as validation errors', async () => {
    const cursor = encodeProductCursor({
      scopeHash: productCursorScopeHash('active', null),
      anchor: { id: firstRow.id, version: firstRow.version },
    });
    await expect(
      service.list(principal, context, { status: 'archived', cursor }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'cursor', constraints: ['productCursorScope'] }],
      },
    });

    repository.list.mockRejectedValue(new ProductReadQueryError('cursor', 'productCursorAnchor'));
    await expect(service.list(principal, context, { cursor })).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'cursor', constraints: ['productCursorAnchor'] }],
      },
    });
  });

  it('maps archived Product detail with active and archived Units exactly', async () => {
    const detail: ProductDetailRecord = {
      product: {
        ...firstRow,
        description: 'Historical Product',
        status: 'archived',
        archivedAt: new Date('2026-08-16T10:00:00.000Z'),
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
      },
      units: [
        {
          id: '53000000-0000-4000-8000-000000000001',
          measurementType: 'volume',
          unitName: 'عبوة',
          unitCode: null,
          isBase: false,
          factorNum: 2,
          factorDen: 4,
          salePriceMinor: null,
          purchasePriceMinor: 0n,
          status: 'archived',
          createdAt: new Date('2026-08-01T10:00:00.000Z'),
          updatedAt: new Date('2026-08-16T10:00:00.000Z'),
          version: 3n,
        },
      ],
    };
    repository.findById.mockResolvedValue(detail);

    const result = await service.getById(principal, context, firstRow.id.toUpperCase());
    expect(repository.findById).toHaveBeenCalledWith(context, firstRow.id);
    expect(result).toMatchObject({
      status: 'archived',
      description: 'Historical Product',
      units: [
        {
          factorNum: 2,
          factorDen: 4,
          salePriceMinor: null,
          purchasePriceMinor: '0',
          status: 'archived',
        },
      ],
    });
  });

  it('uses one non-disclosing not-found result for an absent Product', async () => {
    repository.findById.mockResolvedValue(undefined);

    await expect(service.getById(principal, context, firstRow.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
