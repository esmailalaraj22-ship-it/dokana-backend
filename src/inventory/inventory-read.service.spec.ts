import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';

import { InventoryReadRepository } from './inventory-read.repository';
import { InventoryReadService } from './inventory-read.service';
import type { InventoryReadPrincipal, InventoryStockRecord } from './inventory-read.types';

describe('Inventory read contract', () => {
  const context = {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
  };
  const principal: InventoryReadPrincipal = { ...context, membershipRole: 'owner' };
  const productId = randomUUID();
  const findStock = jest.fn<
    ReturnType<InventoryReadRepository['findStock']>,
    Parameters<InventoryReadRepository['findStock']>
  >();
  const findOperation = jest.fn<
    ReturnType<InventoryReadRepository['findOperation']>,
    Parameters<InventoryReadRepository['findOperation']>
  >();
  let service: InventoryReadService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        InventoryReadService,
        { provide: InventoryReadRepository, useValue: { findStock, findOperation } },
      ],
    }).compile();
    service = module.get(InventoryReadService);
  });

  function record(tracked: boolean, quantity: bigint | null): InventoryStockRecord {
    return {
      product: { id: productId, trackInventory: tracked, measurementType: 'count' },
      units: [],
      balance:
        quantity === null
          ? null
          : {
              storeId: context.storeId,
              productId,
              quantityMilli: quantity,
              inventoryValueMinor: 0n,
              averageUnitCostMinor: 0n,
              costState: quantity < 0n ? 'pending' : 'known',
              hasPendingCost: quantity < 0n,
              lastMovementId: null,
              version: 9007199254740993n,
              updatedAt: new Date('2026-01-01T00:00:00Z'),
            },
    };
  }

  it.each([1000n, 0n, -1000n])(
    'preserves tracked quantity %s without clamping',
    async (quantity) => {
      findStock.mockResolvedValue(record(true, quantity));
      const response = await service.stock(principal, context, productId);
      expect(response.stock?.baseQuantityMilli).toBe(quantity.toString());
      expect(response.stock?.version).toBe('9007199254740993');
      expect(response.trackingState).toBe('TRACKED');
      expect(response.projectionState).toBe('PRESENT');
    },
  );

  it.each([null, 1000n])(
    'does not expose quantity or valuation when tracking is off',
    async (quantity) => {
      findStock.mockResolvedValue(record(false, quantity));
      expect(await service.stock(principal, context, productId)).toMatchObject({
        trackingState: 'NOT_TRACKED',
        projectionState: 'NOT_TRACKED',
        stock: null,
      });
    },
  );

  it('reports a missing tracked projection without inventing a zero or a version', async () => {
    findStock.mockResolvedValue(record(true, null));
    expect(await service.stock(principal, context, productId)).toMatchObject({
      trackingState: 'TRACKED',
      projectionState: 'MISSING',
      stock: null,
    });
  });

  it.each(['manager', 'viewer', 'support'] as const)(
    'rejects non-MVP actor %s before reading',
    async (membershipRole) => {
      await expect(
        service.stock({ ...principal, membershipRole }, context, productId),
      ).rejects.toMatchObject({ status: 403 });
      expect(findStock).not.toHaveBeenCalled();
    },
  );

  it('rejects mismatched server context and malformed identifiers', async () => {
    await expect(
      service.stock(principal, { ...context, storeId: randomUUID() }, productId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.operation(principal, context, 'invalid')).rejects.toMatchObject({
      status: 400,
    });
    expect(findOperation).not.toHaveBeenCalled();
  });

  it('canonicalizes UUIDs and returns stable non-disclosing not-found errors', async () => {
    findStock.mockResolvedValue(undefined);
    await expect(service.stock(principal, context, productId.toUpperCase())).rejects.toMatchObject({
      response: { code: 'INVENTORY_PRODUCT_NOT_FOUND' },
    });
    expect(findStock).toHaveBeenCalledWith(context, productId);
    findOperation.mockResolvedValue(undefined);
    await expect(service.operation(principal, context, randomUUID())).rejects.toMatchObject({
      response: { code: 'INVENTORY_OPERATION_NOT_FOUND' },
    });
  });
});
