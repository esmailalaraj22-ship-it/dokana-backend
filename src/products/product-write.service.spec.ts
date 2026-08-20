import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import { ProductWriteService } from './product-write.service';
import type { ProductWriteRepository } from './product-write.repository';
import type {
  PreparedProductCreate,
  PreparedProductUnitCreate,
  PreparedProductUpdate,
  ProductMutationResponse,
  ProductUnitMutationResponse,
} from './product-write.types';
import type { CreateProductDto } from './dto/create-product.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { CreateProductUnitDto } from './dto/create-product-unit.dto';
import type { UpdateProductUnitDto } from './dto/update-product-unit.dto';

const context: TenantTransactionContext = {
  storeId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333',
  requestId: '44444444-4444-4444-8444-444444444444',
};

const ownerPrincipal = {
  membershipRole: 'owner' as const,
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
};

function buildService(): {
  service: ProductWriteService;
  repository: {
    createProduct: jest.Mock;
    updateProduct: jest.Mock;
    createUnit: jest.Mock;
    updateUnit: jest.Mock;
  };
} {
  const okProduct = { ok: true, response: {} as ProductMutationResponse };
  const okUnit = { ok: true, response: {} as ProductUnitMutationResponse };
  const repository = {
    createProduct: jest.fn().mockResolvedValue(okProduct),
    updateProduct: jest.fn().mockResolvedValue(okProduct),
    createUnit: jest.fn().mockResolvedValue(okUnit),
    updateUnit: jest.fn().mockResolvedValue(okUnit),
  };
  const service = new ProductWriteService(repository as unknown as ProductWriteRepository);
  return { service, repository };
}

function preparedArg(mock: jest.Mock, index: number): unknown {
  const calls = mock.mock.calls as unknown[][];
  const call = calls[index] ?? [];
  return call[1];
}

const baseCreateDto: CreateProductDto = {
  id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  name: '  Olive   Oil  ',
  sku: '  SKU-1 ',
  barcode: ' 001234 ',
  description: null,
  measurementType: 'count',
  trackInventory: true,
  allowNegativeStockOverride: null,
  lowStockThresholdMilli: '1000',
  isPinned: false,
  initialBaseUnit: {
    id: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
    unitName: '  Piece  ',
    unitCode: null,
    salePriceMinor: '9007199254740993',
    purchasePriceMinor: null,
  },
};

describe('ProductWriteService', () => {
  it('rejects non-owner and cross-context principals with 403', async () => {
    const { service } = buildService();
    await expect(
      service.create({ ...ownerPrincipal, membershipRole: 'viewer' }, context, baseCreateDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(
        { ...ownerPrincipal, storeId: '99999999-9999-4999-8999-999999999999' },
        context,
        baseCreateDto,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('canonicalizes create values, preserves client UUIDs, and derives normalized name', async () => {
    const { service, repository } = buildService();
    await service.create(ownerPrincipal, context, baseCreateDto);
    const input = preparedArg(repository.createProduct, 0) as PreparedProductCreate;

    expect(input.productId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(input.operationId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(input.baseUnit.unitId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(input.name).toBe('Olive Oil');
    expect(input.normalizedName).toBe('olive oil');
    expect(input.sku).toBe('SKU-1');
    expect(input.barcode).toBe('001234');
    expect(input.lowStockThresholdMilli).toBe(1000n);
    expect(input.baseUnit.unitName).toBe('Piece');
    expect(input.baseUnit.salePriceMinor).toBe(9007199254740993n);
    expect(input.baseUnit.purchasePriceMinor).toBeNull();
  });

  it('produces an order-independent, deterministic create request hash', async () => {
    const { service, repository } = buildService();
    await service.create(ownerPrincipal, context, baseCreateDto);
    const reordered: CreateProductDto = {
      initialBaseUnit: baseCreateDto.initialBaseUnit,
      isPinned: baseCreateDto.isPinned,
      lowStockThresholdMilli: baseCreateDto.lowStockThresholdMilli,
      measurementType: baseCreateDto.measurementType,
      trackInventory: baseCreateDto.trackInventory,
      allowNegativeStockOverride: baseCreateDto.allowNegativeStockOverride,
      description: baseCreateDto.description,
      barcode: baseCreateDto.barcode,
      sku: baseCreateDto.sku,
      name: baseCreateDto.name,
      operationId: baseCreateDto.operationId,
      id: baseCreateDto.id,
    };
    await service.create(ownerPrincipal, context, reordered);

    const first = preparedArg(repository.createProduct, 0) as PreparedProductCreate;
    const second = preparedArg(repository.createProduct, 1) as PreparedProductCreate;
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires at least one mutable field on product update', async () => {
    const { service } = buildService();
    const dto: UpdateProductDto = {
      operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      expectedVersion: '1',
    };
    await expect(
      service.update(ownerPrincipal, context, baseCreateDto.id, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps omitted, null, and expectedVersion distinct in the update request hash', async () => {
    const { service, repository } = buildService();
    const omitted: UpdateProductDto = {
      operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      expectedVersion: '3',
      isPinned: true,
    };
    const cleared: UpdateProductDto = {
      operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      expectedVersion: '3',
      isPinned: true,
      sku: null,
    };
    const otherVersion: UpdateProductDto = {
      operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      expectedVersion: '4',
      isPinned: true,
    };
    await service.update(ownerPrincipal, context, baseCreateDto.id, omitted);
    await service.update(ownerPrincipal, context, baseCreateDto.id, cleared);
    await service.update(ownerPrincipal, context, baseCreateDto.id, otherVersion);

    const hashes = (repository.updateProduct.mock.calls as unknown[][]).map(
      (call) => (call[1] as PreparedProductUpdate).requestHash,
    );
    expect(new Set(hashes).size).toBe(3);
    const clearedInput = preparedArg(repository.updateProduct, 1) as PreparedProductUpdate;
    expect(clearedInput.sku).toBeNull();
    const omittedInput = preparedArg(repository.updateProduct, 0) as PreparedProductUpdate;
    expect(omittedInput.sku).toBeUndefined();
  });

  it('validates the non-base unit ratio and canonical prices on unit create', async () => {
    const { service, repository } = buildService();
    const dto: CreateProductUnitDto = {
      id: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
      operationId: 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE',
      productId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      unitName: '  Carton ',
      unitCode: ' C12 ',
      factorNum: 12,
      factorDen: 1,
      salePriceMinor: '0',
      purchasePriceMinor: null,
    };
    await service.createUnit(ownerPrincipal, context, dto);
    const input = preparedArg(repository.createUnit, 0) as PreparedProductUnitCreate;
    expect(input.factorNum).toBe(12);
    expect(input.factorDen).toBe(1);
    expect(input.unitName).toBe('Carton');
    expect(input.unitCode).toBe('C12');
    expect(input.salePriceMinor).toBe(0n);
    expect(input.purchasePriceMinor).toBeNull();
  });

  it('rejects out-of-range int4 factors on unit create', async () => {
    const { service } = buildService();
    const dto: CreateProductUnitDto = {
      id: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
      operationId: 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE',
      productId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      unitName: 'Carton',
      factorNum: 2_147_483_648,
      factorDen: 1,
    };
    await expect(service.createUnit(ownerPrincipal, context, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires at least one mutable field on unit update', async () => {
    const { service } = buildService();
    const dto: UpdateProductUnitDto = {
      operationId: 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE',
      expectedVersion: '1',
    };
    await expect(
      service.updateUnit(ownerPrincipal, context, baseCreateDto.initialBaseUnit.id, dto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
