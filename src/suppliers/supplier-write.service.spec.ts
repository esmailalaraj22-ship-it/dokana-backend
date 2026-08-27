import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import type { CreateSupplierDto } from './dto/create-supplier.dto';
import type { UpdateSupplierDto } from './dto/update-supplier.dto';
import type { SupplierWriteRepository } from './supplier-write.repository';
import { SupplierWriteService } from './supplier-write.service';
import type {
  PreparedSupplierCreate,
  PreparedSupplierUpdate,
  SupplierMutationResponse,
} from './supplier-write.types';

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

const createDto: CreateSupplierDto = {
  id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  operationId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  name: '  AHMAD   Trading  ',
  phone: ' (0599) 123 456 ',
  notes: '  exact notes  ',
};

function buildService(): {
  service: SupplierWriteService;
  repository: { create: jest.Mock; update: jest.Mock };
} {
  const response = {} as SupplierMutationResponse;
  const repository = {
    create: jest.fn().mockResolvedValue({ ok: true, response }),
    update: jest.fn().mockResolvedValue({ ok: true, response }),
  };
  return {
    service: new SupplierWriteService(repository as unknown as SupplierWriteRepository),
    repository,
  };
}

function preparedArg(mock: jest.Mock, index: number): unknown {
  const calls = mock.mock.calls as unknown[][];
  return calls[index]?.[1];
}

describe('SupplierWriteService', () => {
  it('rejects non-owner and mismatched trusted context before repository access', async () => {
    const { service, repository } = buildService();
    await expect(
      service.create({ ...ownerPrincipal, membershipRole: 'viewer' }, context, createDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(
        { ...ownerPrincipal, deviceId: '99999999-9999-4999-8999-999999999999' },
        context,
        createDto,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('canonicalizes create fields, preserves UUIDs, and preserves notes exactly', async () => {
    const { service, repository } = buildService();
    await service.create(ownerPrincipal, context, createDto);
    const input = preparedArg(repository.create, 0) as PreparedSupplierCreate;

    expect(input).toMatchObject({
      supplierId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'AHMAD Trading',
      normalizedName: 'ahmad trading',
      phone: '(0599) 123 456',
      normalizedPhone: '+970599123456',
      notes: '  exact notes  ',
    });
    expect(input.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the fixed create projection independent of DTO property order and operation ID', async () => {
    const { service, repository } = buildService();
    const reordered: CreateSupplierDto = {
      notes: createDto.notes,
      phone: createDto.phone,
      name: createDto.name,
      operationId: createDto.operationId,
      id: createDto.id,
    };
    const anotherClaim: CreateSupplierDto = {
      id: createDto.id,
      operationId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
      name: createDto.name,
      phone: createDto.phone,
      notes: createDto.notes,
    };

    await service.create(ownerPrincipal, context, createDto);
    await service.create(ownerPrincipal, context, reordered);
    await service.create(ownerPrincipal, context, anotherClaim);

    const inputs = (repository.create.mock.calls as unknown[][]).map(
      (call) => call[1] as PreparedSupplierCreate,
    );
    expect(inputs[0]?.requestHash).toBe(inputs[1]?.requestHash);
    expect(inputs[0]?.requestHash).toBe(inputs[2]?.requestHash);
  });

  it('treats omitted and null create notes as the same canonical request', async () => {
    const { service, repository } = buildService();
    const omitted: CreateSupplierDto = {
      id: createDto.id,
      operationId: createDto.operationId,
      name: createDto.name,
      phone: createDto.phone,
    };
    const explicitNull: CreateSupplierDto = {
      id: createDto.id,
      operationId: createDto.operationId,
      name: createDto.name,
      phone: createDto.phone,
      notes: null,
    };
    await service.create(ownerPrincipal, context, omitted);
    await service.create(ownerPrincipal, context, explicitNull);

    const first = preparedArg(repository.create, 0) as PreparedSupplierCreate;
    const second = preparedArg(repository.create, 1) as PreparedSupplierCreate;
    expect(first.notes).toBeNull();
    expect(second.notes).toBeNull();
    expect(first.requestHash).toBe(second.requestHash);
  });

  it('requires a mutable PATCH field and lossless PostgreSQL bigint version', async () => {
    const { service } = buildService();
    await expect(
      service.update(ownerPrincipal, context, createDto.id, {
        operationId: createDto.operationId,
        expectedVersion: '1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(ownerPrincipal, context, createDto.id, {
        operationId: createDto.operationId,
        expectedVersion: '9223372036854775808',
        name: 'Updated',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps PATCH omission, explicit null notes, and expectedVersion distinct', async () => {
    const { service, repository } = buildService();
    const omitted: UpdateSupplierDto = {
      operationId: createDto.operationId,
      expectedVersion: '9007199254740993',
      name: 'Updated',
    };
    const cleared: UpdateSupplierDto = {
      operationId: createDto.operationId,
      expectedVersion: '9007199254740993',
      name: 'Updated',
      notes: null,
    };
    const changedVersion: UpdateSupplierDto = {
      operationId: createDto.operationId,
      expectedVersion: '9007199254740994',
      name: 'Updated',
    };

    await service.update(ownerPrincipal, context, createDto.id, omitted);
    await service.update(ownerPrincipal, context, createDto.id, cleared);
    await service.update(ownerPrincipal, context, createDto.id, changedVersion);

    const inputs = (repository.update.mock.calls as unknown[][]).map(
      (call) => call[1] as PreparedSupplierUpdate,
    );
    expect(inputs[0]?.expectedVersion).toBe(9007199254740993n);
    expect(inputs[0]?.notes).toBeUndefined();
    expect(inputs[1]?.notes).toBeNull();
    expect(new Set(inputs.map((input) => input.requestHash)).size).toBe(3);
  });

  it('canonicalizes supplied PATCH fields in fixed order without operation ID in the hash', async () => {
    const { service, repository } = buildService();
    const first: UpdateSupplierDto = {
      operationId: createDto.operationId,
      expectedVersion: '7',
      notes: ' exact ',
      phone: '+970 599 123 456',
      name: '  Updated   Name ',
    };
    const second: UpdateSupplierDto = {
      name: first.name,
      phone: first.phone,
      notes: first.notes,
      expectedVersion: first.expectedVersion,
      operationId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
    };

    await service.update(ownerPrincipal, context, createDto.id, first);
    await service.update(ownerPrincipal, context, createDto.id, second);

    const one = preparedArg(repository.update, 0) as PreparedSupplierUpdate;
    const two = preparedArg(repository.update, 1) as PreparedSupplierUpdate;
    expect(one).toMatchObject({
      name: 'Updated Name',
      normalizedName: 'updated name',
      phone: '+970 599 123 456',
      normalizedPhone: '+970599123456',
      notes: ' exact ',
    });
    expect(one.requestHash).toBe(two.requestHash);
  });

  it('binds the update fingerprint to Supplier target and action semantics', async () => {
    const { service, repository } = buildService();
    const dto: UpdateSupplierDto = {
      operationId: createDto.operationId,
      expectedVersion: '1',
      name: 'Updated',
    };
    await service.update(ownerPrincipal, context, createDto.id, dto);
    await service.update(ownerPrincipal, context, 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD', dto);

    const one = preparedArg(repository.update, 0) as PreparedSupplierUpdate;
    const two = preparedArg(repository.update, 1) as PreparedSupplierUpdate;
    expect(one.requestHash).not.toBe(two.requestHash);
  });
});
