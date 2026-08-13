import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { TenantTransactionContext } from '../database/database.types';
import { decodeCustomerCursor, encodeCustomerCursor } from './customer-read-cursor';
import type { CustomerReadRepository } from './customer-read.repository';
import { CustomerReadService } from './customer-read.service';
import type { CustomerDetailRow, CustomerListRow } from './customer-read.types';

const context: TenantTransactionContext = {
  storeId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  deviceId: '10000000-0000-4000-8000-000000000003',
  requestId: '10000000-0000-4000-8000-000000000004',
};
const firstRow: CustomerListRow = {
  id: '20000000-0000-4000-8000-000000000001',
  name: 'أحمد',
  normalizedName: 'احمد',
  phone: '0599 123 456',
  status: 'active',
  archivedAt: null,
  updatedAt: new Date('2026-08-10T08:00:00.000Z'),
};
const secondRow: CustomerListRow = {
  ...firstRow,
  id: '20000000-0000-4000-8000-000000000002',
  name: 'أحمــد',
  updatedAt: new Date('2026-08-11T08:00:00.000Z'),
};
const extraRow: CustomerListRow = {
  ...firstRow,
  id: '20000000-0000-4000-8000-000000000003',
  name: 'Alice',
  normalizedName: 'alice',
};

describe('CustomerReadService', () => {
  const repository = {
    list: jest.fn(),
    findById: jest.fn(),
  } as jest.Mocked<Pick<CustomerReadRepository, 'list' | 'findById'>>;
  const service = new CustomerReadService(repository as unknown as CustomerReadRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults list reads to active status, no search, and limit 50', async () => {
    repository.list.mockResolvedValue([firstRow]);

    await expect(service.list(context, {})).resolves.toEqual({
      items: [
        {
          id: firstRow.id,
          name: firstRow.name,
          phone: firstRow.phone,
          status: 'active',
          archivedAt: null,
          updatedAt: '2026-08-10T08:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(repository.list).toHaveBeenCalledWith(context, {
      status: 'active',
      search: null,
      position: null,
      limit: 50,
    });
  });

  it('passes explicit archived status and empty search as an unfiltered status scope', async () => {
    repository.list.mockResolvedValue([]);

    await service.list(context, { status: 'archived', search: '\u00a0 ' });

    expect(repository.list).toHaveBeenCalledWith(context, {
      status: 'archived',
      search: null,
      position: null,
      limit: 50,
    });
  });

  it('uses limit plus one results to return a bounded page and keyset cursor', async () => {
    repository.list.mockResolvedValue([firstRow, secondRow, extraRow]);

    const result = await service.list(context, { limit: 2, search: 'أحمــد' });

    expect(result.items.map((item) => item.id)).toEqual([firstRow.id, secondRow.id]);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCustomerCursor(result.nextCursor ?? '')).toEqual({
      status: 'active',
      search: { normalizedNamePrefix: 'احمد', canonicalPhone: null },
      position: { normalizedName: secondRow.normalizedName, id: secondRow.id },
    });
    expect(repository.list).toHaveBeenCalledWith(context, expect.objectContaining({ limit: 2 }));
  });

  it('rejects a cursor used with a different status or canonical search scope', async () => {
    const cursor = encodeCustomerCursor({
      status: 'active',
      search: { normalizedNamePrefix: 'ahmad', canonicalPhone: null },
      position: { normalizedName: 'ahmad', id: firstRow.id },
    });

    await expect(
      service.list(context, { status: 'archived', search: 'Mohamed', cursor }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'cursor', constraints: ['customerCursorScope'] }],
      },
    });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('maps detail explicitly and serializes bigint version losslessly', async () => {
    const detail: CustomerDetailRow = {
      ...firstRow,
      notes: 'Preferred morning delivery',
      createdAt: new Date('2026-08-01T08:00:00.000Z'),
      version: 9_007_199_254_740_993n,
    };
    repository.findById.mockResolvedValue(detail);

    const result = await service.getById(context, detail.id);

    expect(result).toEqual({
      id: detail.id,
      name: detail.name,
      phone: detail.phone,
      status: detail.status,
      archivedAt: null,
      updatedAt: '2026-08-10T08:00:00.000Z',
      notes: detail.notes,
      createdAt: '2026-08-01T08:00:00.000Z',
      version: '9007199254740993',
    });
    expect(result).not.toHaveProperty('normalizedName');
    expect(result).not.toHaveProperty('normalizedPhone');
    expect(result).not.toHaveProperty('storeId');
    expect(result).not.toHaveProperty('operationId');
  });

  it('translates absent and foreign-filtered rows to the same stable not-found exception', async () => {
    repository.findById.mockResolvedValue(undefined);

    await expect(service.getById(context, firstRow.id)).rejects.toMatchObject({
      status: 404,
      response: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' },
    });
  });

  it('preserves expected exception classes and does not mask repository failures', async () => {
    repository.list.mockRejectedValueOnce(new BadRequestException('database boundary test'));
    await expect(service.list(context, {})).rejects.toBeInstanceOf(BadRequestException);

    repository.findById.mockRejectedValueOnce(new NotFoundException('boundary test'));
    await expect(service.getById(context, firstRow.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
