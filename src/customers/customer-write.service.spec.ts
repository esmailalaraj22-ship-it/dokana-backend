import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import type { CustomerWriteRepository } from './customer-write.repository';
import { CustomerWriteService } from './customer-write.service';
import type {
  CustomerMutationFailureCode,
  CustomerMutationResponse,
  CustomerMutationResult,
} from './customer-write.types';

const context: TenantTransactionContext = {
  storeId: '44000000-0000-4000-8000-000000000001',
  userId: '44100000-0000-4000-8000-000000000001',
  deviceId: '44200000-0000-4000-8000-000000000001',
  requestId: '44300000-0000-4000-8000-000000000001',
};
const customerId = '44400000-0000-4000-8000-000000000001';
const operationId = '44500000-0000-4000-8000-000000000001';
const response: CustomerMutationResponse = {
  id: customerId,
  name: 'أحمد محمد',
  phone: '0599 123 456',
  status: 'active',
  archivedAt: null,
  updatedAt: '2026-08-14T08:01:00.000Z',
  notes: null,
  createdAt: '2026-08-14T08:00:00.000Z',
  version: '1',
  operationId,
};

function rejected(code: CustomerMutationFailureCode): CustomerMutationResult {
  const definitions = {
    CONFLICT: ['The request conflicts with existing state.', 409],
    CUSTOMER_ARCHIVED: ['Archived Customer cannot be updated.', 409],
    CUSTOMER_NOT_FOUND: ['Customer not found.', 404],
    CUSTOMER_PHONE_CONFLICT: ['A Customer with this phone already exists.', 409],
    CUSTOMER_VERSION_CONFLICT: ['Customer version conflict.', 409],
    OPERATION_ID_CONFLICT: ['Operation ID was reused with a different request.', 409],
    OPERATION_IN_PROGRESS: ['The operation is still being processed.', 409],
  } as const;
  const [message, statusCode] = definitions[code];
  return { ok: false, error: { code, message, statusCode } };
}

describe('CustomerWriteService', () => {
  const repository = {
    create: jest.fn(),
    update: jest.fn(),
    changeLifecycle: jest.fn(),
  } as jest.Mocked<Pick<CustomerWriteRepository, 'create' | 'update' | 'changeLifecycle'>>;
  const service = new CustomerWriteService(repository as unknown as CustomerWriteRepository);

  beforeEach(() => {
    jest.clearAllMocks();
    repository.create.mockResolvedValue({ ok: true, response });
    repository.update.mockResolvedValue({ ok: true, response: { ...response, version: '2' } });
    repository.changeLifecycle.mockResolvedValue({
      ok: true,
      response: { ...response, status: 'archived', version: '2' },
    });
  });

  it('prepares an explicit create with preserved client UUIDs and trusted-context separation', async () => {
    const dto = {
      id: customerId,
      operationId,
      name: '  أحمــد   مُحَمَّد  ',
      phone: ' 0599 123 456 ',
      notes: 'Keep exact notes whitespace ',
      storeId: '99900000-0000-4000-8000-000000000001',
      status: 'archived',
      deviceId: '99900000-0000-4000-8000-000000000002',
      normalizedName: 'forged',
      normalizedPhone: '+111',
    };

    await expect(service.create(context, dto)).resolves.toBe(response);

    expect(repository.create).toHaveBeenCalledTimes(1);
    const prepared = repository.create.mock.calls[0]?.[1];
    expect(prepared).toMatchObject({
      customerId,
      operationId,
      name: 'أحمــد مُحَمَّد',
      normalizedName: 'احمد محمد',
      phone: '0599 123 456',
      normalizedPhone: '+970599123456',
      notes: 'Keep exact notes whitespace ',
    });
    expect(prepared?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(prepared ?? {}).sort()).toEqual([
      'customerId',
      'name',
      'normalizedName',
      'normalizedPhone',
      'notes',
      'operationId',
      'phone',
      'requestHash',
    ]);
  });

  it('canonicalizes omitted and explicit null create notes to the same persisted request', async () => {
    await service.create(context, {
      id: customerId,
      operationId,
      name: 'Alice',
      phone: '0599 123 456',
    });
    const omitted = repository.create.mock.calls[0]?.[1];

    await service.create(context, {
      id: customerId,
      operationId,
      name: 'Alice',
      phone: '0599 123 456',
      notes: null,
    });
    const explicitNull = repository.create.mock.calls[1]?.[1];

    expect(omitted?.notes).toBeNull();
    expect(explicitNull?.notes).toBeNull();
    expect(omitted?.requestHash).toBe(explicitNull?.requestHash);
  });

  it('canonicalizes accepted UUID text forms before persistence and request hashing', async () => {
    const lowercaseCustomerId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const lowercaseOperationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const uppercaseCustomerId = lowercaseCustomerId.toUpperCase();
    const uppercaseOperationId = lowercaseOperationId.toUpperCase();

    await service.create(context, {
      id: uppercaseCustomerId,
      operationId: uppercaseOperationId,
      name: 'Semantic Customer',
      phone: '0599 123 456',
    });
    await service.create(context, {
      id: lowercaseCustomerId,
      operationId: lowercaseOperationId,
      name: 'Semantic Customer',
      phone: '0599 123 456',
    });
    const uppercaseCreate = repository.create.mock.calls[0]?.[1];
    const lowercaseCreate = repository.create.mock.calls[1]?.[1];
    expect(uppercaseCreate).toMatchObject({
      customerId: lowercaseCustomerId,
      operationId: lowercaseOperationId,
    });
    expect(uppercaseCreate?.requestHash).toBe(lowercaseCreate?.requestHash);

    await service.update(context, uppercaseCustomerId, {
      operationId: uppercaseOperationId,
      expectedVersion: '1',
      notes: 'Canonical update',
    });
    await service.update(context, lowercaseCustomerId, {
      operationId: lowercaseOperationId,
      expectedVersion: '1',
      notes: 'Canonical update',
    });
    const uppercaseUpdate = repository.update.mock.calls[0]?.[1];
    const lowercaseUpdate = repository.update.mock.calls[1]?.[1];
    expect(uppercaseUpdate).toMatchObject({
      customerId: lowercaseCustomerId,
      operationId: lowercaseOperationId,
    });
    expect(uppercaseUpdate?.requestHash).toBe(lowercaseUpdate?.requestHash);

    await service.archive(context, uppercaseCustomerId, {
      operationId: uppercaseOperationId,
      expectedVersion: '1',
    });
    await service.archive(context, lowercaseCustomerId, {
      operationId: lowercaseOperationId,
      expectedVersion: '1',
    });
    const uppercaseLifecycle = repository.changeLifecycle.mock.calls[0]?.[1];
    const lowercaseLifecycle = repository.changeLifecycle.mock.calls[1]?.[1];
    expect(uppercaseLifecycle).toMatchObject({
      customerId: lowercaseCustomerId,
      operationId: lowercaseOperationId,
    });
    expect(uppercaseLifecycle?.requestHash).toBe(lowercaseLifecycle?.requestHash);
  });

  it.each([
    { name: '   ', phone: '0599 123 456', field: 'name', code: 'CUSTOMER_DISPLAY_NAME_EMPTY' },
    { name: 'ـً', phone: '0599 123 456', field: 'name', code: 'CUSTOMER_NORMALIZED_NAME_EMPTY' },
    { name: 'Alice', phone: '   ', field: 'phone', code: 'CUSTOMER_DISPLAY_PHONE_EMPTY' },
    { name: 'Alice', phone: '123', field: 'phone', code: 'CUSTOMER_PHONE_INVALID' },
  ])('rejects create normalization failure $code before persistence', async (example) => {
    await expect(
      service.create(context, {
        id: customerId,
        operationId,
        name: example.name,
        phone: example.phone,
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'VALIDATION_ERROR',
        details: [{ field: example.field, constraints: [example.code] }],
      },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects over-budget normalized names before create or update persistence', async () => {
    const overBudgetName = 'a'.repeat(700);

    await expect(
      service.create(context, {
        id: customerId,
        operationId,
        name: overBudgetName,
        phone: '0599 123 456',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'name', constraints: ['customerCursorRepresentability'] }],
      },
    });
    await expect(
      service.update(context, customerId, {
        operationId,
        expectedVersion: '1',
        name: overBudgetName,
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'name', constraints: ['customerCursorRepresentability'] }],
      },
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('prepares only supplied update fields and parses expectedVersion losslessly', async () => {
    await service.update(context, customerId, {
      operationId,
      expectedVersion: '9007199254740993',
      name: '  أحمــد   مُحَمَّد  ',
      notes: null,
    });

    expect(repository.update).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        customerId,
        operationId,
        expectedVersion: 9_007_199_254_740_993n,
        name: 'أحمــد مُحَمَّد',
        normalizedName: 'احمد محمد',
        phone: undefined,
        normalizedPhone: undefined,
        notes: null,
      }),
    );
  });

  it('recomputes only the supplied phone canonical value', async () => {
    await service.update(context, customerId, {
      operationId,
      expectedVersion: '1',
      phone: '٠٥٩٩ ١٢٣ ٤٥٦',
    });

    const prepared = repository.update.mock.calls[0]?.[1];
    expect(prepared).toMatchObject({
      phone: '٠٥٩٩ ١٢٣ ٤٥٦',
      normalizedPhone: '+970599123456',
    });
    expect(prepared).not.toHaveProperty('name', expect.anything());
    expect(prepared).not.toHaveProperty('normalizedName', expect.anything());
  });

  it('preserves exact string notes and distinguishes omitted from null', async () => {
    await service.update(context, customerId, {
      operationId,
      expectedVersion: '1',
      notes: '  exact notes  ',
    });
    expect(repository.update.mock.calls[0]?.[1].notes).toBe('  exact notes  ');

    await service.update(context, customerId, {
      operationId: '44500000-0000-4000-8000-000000000002',
      expectedVersion: '1',
      notes: null,
    });
    expect(repository.update.mock.calls[1]?.[1].notes).toBeNull();
  });

  it('rejects expectedVersion-only and oversized bigint patches before persistence', async () => {
    await expect(
      service.update(context, customerId, { operationId, expectedVersion: '1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(context, customerId, {
        operationId,
        expectedVersion: '9223372036854775808',
        notes: null,
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'expectedVersion', constraints: ['maxPostgreSqlBigint'] }],
      },
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects invalid update normalization without rewriting unrelated fields', async () => {
    await expect(
      service.update(context, customerId, {
        operationId,
        expectedVersion: '1',
        phone: '+970000000000',
        notes: 'unchanged because the request fails',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'phone', constraints: ['CUSTOMER_PHONE_INVALID'] }],
      },
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('prepares archive and restore as distinct lifecycle commands without master data', async () => {
    await service.archive(context, customerId, { operationId, expectedVersion: '1' });
    const archive = repository.changeLifecycle.mock.calls[0]?.[1];

    repository.changeLifecycle.mockResolvedValueOnce({
      ok: true,
      response: { ...response, status: 'active', version: '3' },
    });
    await service.restore(context, customerId, { operationId, expectedVersion: '2' });
    const restore = repository.changeLifecycle.mock.calls[1]?.[1];

    expect(archive).toMatchObject({
      customerId,
      operationId,
      expectedVersion: 1n,
      action: 'archive',
    });
    expect(restore).toMatchObject({
      customerId,
      operationId,
      expectedVersion: 2n,
      action: 'restore',
    });
    expect(Object.keys(archive ?? {}).sort()).toEqual([
      'action',
      'customerId',
      'expectedVersion',
      'operationId',
      'requestHash',
    ]);
    expect(archive?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(restore?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(archive?.requestHash).not.toBe(restore?.requestHash);
  });

  it('rejects an oversized lifecycle version before persistence', async () => {
    await expect(
      service.archive(context, customerId, {
        operationId,
        expectedVersion: '9223372036854775808',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        details: [{ field: 'expectedVersion', constraints: ['maxPostgreSqlBigint'] }],
      },
    });
    expect(repository.changeLifecycle).not.toHaveBeenCalled();
  });

  it('maps lifecycle state and version failures through the established error contract', async () => {
    repository.changeLifecycle.mockResolvedValueOnce(rejected('CUSTOMER_ARCHIVED'));
    await expect(
      service.archive(context, customerId, { operationId, expectedVersion: '1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    repository.changeLifecycle.mockResolvedValueOnce(rejected('CONFLICT'));
    await expect(
      service.restore(context, customerId, { operationId, expectedVersion: '1' }),
    ).rejects.toBeInstanceOf(ConflictException);

    repository.changeLifecycle.mockResolvedValueOnce(rejected('CUSTOMER_VERSION_CONFLICT'));
    await expect(
      service.restore(context, customerId, { operationId, expectedVersion: '1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ['CUSTOMER_NOT_FOUND', NotFoundException],
    ['CUSTOMER_ARCHIVED', ConflictException],
    ['CUSTOMER_PHONE_CONFLICT', ConflictException],
    ['CUSTOMER_VERSION_CONFLICT', ConflictException],
    ['OPERATION_ID_CONFLICT', ConflictException],
  ] as const)('maps repository failure %s to its stable HTTP exception', async (code, type) => {
    repository.update.mockResolvedValueOnce(rejected(code));

    await expect(
      service.update(context, customerId, {
        operationId,
        expectedVersion: '1',
        notes: null,
      }),
    ).rejects.toBeInstanceOf(type);
  });

  it('does not mask unexpected repository failures', async () => {
    const unexpected = new Error('database boundary failure');
    repository.create.mockRejectedValueOnce(unexpected);

    await expect(
      service.create(context, {
        id: customerId,
        operationId,
        name: 'Alice',
        phone: '0599 123 456',
      }),
    ).rejects.toBe(unexpected);
  });
});
