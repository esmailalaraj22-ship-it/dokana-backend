import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { CustomerWriteRepository } from './customer-write.repository';
import type { CustomerMutationRow } from './customer-write.types';

const context: TenantTransactionContext = {
  storeId: '44000000-0000-4000-8000-000000000001',
  userId: '44100000-0000-4000-8000-000000000001',
  deviceId: '44200000-0000-4000-8000-000000000001',
  requestId: '44300000-0000-4000-8000-000000000001',
};
const customerId = '44400000-0000-4000-8000-000000000001';
const operationId = '44500000-0000-4000-8000-000000000001';
const row: CustomerMutationRow = {
  id: customerId,
  name: 'Customer Name',
  normalizedName: 'customer name',
  phone: '0599 123 456',
  status: 'active',
  archivedAt: null,
  updatedAt: new Date('2026-08-14T08:01:00.000Z'),
  notes: null,
  createdAt: new Date('2026-08-14T08:00:00.000Z'),
  version: 1n,
  operationId,
};

interface RepositoryHarness {
  repository: CustomerWriteRepository;
  database: jest.Mocked<Pick<DatabaseService, 'withBusinessWriteTransaction'>>;
  transaction: DatabaseTransaction;
  execute: jest.Mock;
  insert: jest.Mock;
  insertValues: jest.Mock;
  update: jest.Mock;
  updateSet: jest.Mock;
  returningUpdate: jest.Mock;
  selectLimit: jest.Mock;
  updateValues: Record<string, unknown>[];
}

function createHarness(): RepositoryHarness {
  const execute = jest.fn();
  const returningInsert = jest.fn().mockResolvedValue([row]);
  const onConflictDoNothing = jest.fn(() => ({ returning: returningInsert }));
  const insertValues = jest.fn(() => ({ onConflictDoNothing }));
  const insert = jest.fn(() => ({ values: insertValues }));
  const returningUpdate = jest.fn().mockResolvedValue([{ ...row, version: 2n }]);
  const whereUpdate = jest.fn(() => ({ returning: returningUpdate }));
  const updateValues: Record<string, unknown>[] = [];
  const updateSet = jest.fn((values: Record<string, unknown>) => {
    updateValues.push(values);
    return { where: whereUpdate };
  });
  const update = jest.fn(() => ({ set: updateSet }));
  const selectLimit = jest.fn(
    async (): Promise<{ status: 'active' | 'archived'; version: bigint }[]> => [
      { status: 'active', version: 1n },
    ],
  );
  const selectFor = jest.fn((): ReturnType<typeof selectLimit> => selectLimit());
  const selectQuery = {
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => ({ for: selectFor })),
      })),
    })),
  };
  const select = jest.fn(() => selectQuery);
  const transaction = {
    execute,
    insert,
    update,
    select,
  } as unknown as DatabaseTransaction;
  Object.assign(transaction, {
    transaction: jest.fn(async (work: (value: DatabaseTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  });
  const database = {
    withBusinessWriteTransaction: jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (value: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    ),
  } as unknown as jest.Mocked<Pick<DatabaseService, 'withBusinessWriteTransaction'>>;

  return {
    repository: new CustomerWriteRepository(database as unknown as DatabaseService),
    database,
    transaction,
    execute,
    insert,
    insertValues,
    update,
    updateSet,
    returningUpdate,
    selectLimit,
    updateValues,
  };
}

describe('CustomerWriteRepository', () => {
  it('uses the business-write transaction and inserts only explicit trusted/create fields', async () => {
    const harness = createHarness();
    harness.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claimed: true }] })
      .mockResolvedValueOnce({ rows: [{ operationId }] });

    await expect(
      harness.repository.create(context, {
        customerId,
        operationId,
        name: 'Customer Name',
        normalizedName: 'customer name',
        phone: '0599 123 456',
        normalizedPhone: '+970599123456',
        notes: null,
        requestHash: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ ok: true, response: { id: customerId, operationId } });

    expect(harness.database.withBusinessWriteTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(harness.insert).toHaveBeenCalledTimes(1);
    expect(harness.insertValues).toHaveBeenCalledWith({
      id: customerId,
      storeId: context.storeId,
      name: 'Customer Name',
      normalizedName: 'customer name',
      phone: '0599 123 456',
      normalizedPhone: '+970599123456',
      notes: null,
      status: 'active',
      archivedAt: null,
      deviceId: context.deviceId,
      operationId,
    });
  });

  it('updates only approved supplied fields plus trusted mutation provenance', async () => {
    const harness = createHarness();
    harness.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claimed: true }] })
      .mockResolvedValueOnce({ rows: [{ operationId }] });

    await expect(
      harness.repository.update(context, {
        customerId,
        operationId,
        expectedVersion: 1n,
        notes: null,
        requestHash: 'b'.repeat(64),
      }),
    ).resolves.toMatchObject({ ok: true, response: { version: '2' } });

    expect(harness.database.withBusinessWriteTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.updateSet).toHaveBeenCalledWith({
      deviceId: context.deviceId,
      operationId,
      notes: null,
    });
  });

  it('replays a stored applied response without executing another Customer write', async () => {
    const harness = createHarness();
    harness.execute.mockResolvedValueOnce({
      rows: [
        {
          deviceId: context.deviceId,
          aggregateType: 'customers',
          aggregateId: customerId,
          action: 'create',
          requestHash: 'c'.repeat(64),
          status: 'applied',
          responseCode: 201,
          responseBody: {
            id: customerId,
            name: row.name,
            phone: row.phone,
            status: row.status,
            archivedAt: null,
            updatedAt: row.updatedAt.toISOString(),
            notes: null,
            createdAt: row.createdAt.toISOString(),
            version: '1',
            operationId,
          },
          errorCode: null,
        },
      ],
    });

    await expect(
      harness.repository.create(context, {
        customerId,
        operationId,
        name: row.name,
        normalizedName: row.normalizedName,
        phone: row.phone,
        normalizedPhone: '+970599123456',
        notes: null,
        requestHash: 'c'.repeat(64),
      }),
    ).resolves.toMatchObject({ ok: true, response: { id: customerId, version: '1' } });
    expect(harness.insert).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it('archives through the business-write boundary with only lifecycle provenance fields', async () => {
    const harness = createHarness();
    const archivedAt = new Date('2026-08-14T09:00:00.000Z');
    harness.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claimed: true }] })
      .mockResolvedValueOnce({ rows: [{ operationId }] });
    harness.returningUpdate.mockResolvedValueOnce([
      { ...row, status: 'archived', archivedAt, version: 2n },
    ]);

    await expect(
      harness.repository.changeLifecycle(context, {
        customerId,
        operationId,
        expectedVersion: 1n,
        action: 'archive',
        requestHash: 'd'.repeat(64),
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { status: 'archived', archivedAt: archivedAt.toISOString(), version: '2' },
    });

    expect(harness.database.withBusinessWriteTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(harness.selectLimit).toHaveBeenCalledTimes(1);
    const updates = harness.updateValues[0];
    expect(Object.keys(updates ?? {}).sort()).toEqual([
      'archivedAt',
      'deviceId',
      'operationId',
      'status',
    ]);
    expect(updates).toMatchObject({
      status: 'archived',
      deviceId: context.deviceId,
      operationId,
    });
    expect(updates?.archivedAt).not.toBeInstanceOf(Date);
  });

  it('restores the same row without supplying Customer master data', async () => {
    const harness = createHarness();
    harness.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claimed: true }] })
      .mockResolvedValueOnce({ rows: [{ operationId }] });
    harness.selectLimit.mockResolvedValueOnce([{ status: 'archived', version: 1n }]);
    harness.returningUpdate.mockResolvedValueOnce([
      { ...row, status: 'active', archivedAt: null, version: 2n },
    ]);

    await expect(
      harness.repository.changeLifecycle(context, {
        customerId,
        operationId,
        expectedVersion: 1n,
        action: 'restore',
        requestHash: 'e'.repeat(64),
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { id: customerId, status: 'active', archivedAt: null, version: '2' },
    });

    expect(harness.updateSet).toHaveBeenCalledWith({
      status: 'active',
      archivedAt: null,
      deviceId: context.deviceId,
      operationId,
    });
  });

  it.each([
    {
      action: 'archive' as const,
      current: [] as { status: 'active' | 'archived'; version: bigint }[],
      code: 'CUSTOMER_NOT_FOUND',
    },
    {
      action: 'archive' as const,
      current: [{ status: 'archived' as const, version: 1n }],
      code: 'CUSTOMER_ARCHIVED',
    },
    {
      action: 'restore' as const,
      current: [{ status: 'active' as const, version: 1n }],
      code: 'CONFLICT',
    },
    {
      action: 'archive' as const,
      current: [{ status: 'active' as const, version: 2n }],
      code: 'CUSTOMER_VERSION_CONFLICT',
    },
    {
      action: 'restore' as const,
      current: [{ status: 'archived' as const, version: 2n }],
      code: 'CUSTOMER_VERSION_CONFLICT',
    },
  ])('classifies $action lifecycle zero-effect state as $code before UPDATE', async (example) => {
    const harness = createHarness();
    harness.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claimed: true }] })
      .mockResolvedValueOnce({ rows: [{ operationId }] });
    harness.selectLimit.mockResolvedValueOnce(example.current);

    await expect(
      harness.repository.changeLifecycle(context, {
        customerId,
        operationId,
        expectedVersion: 1n,
        action: example.action,
        requestHash: 'f'.repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: example.code } });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it('does not falsely complete an operation after an unexpected lifecycle database failure', async () => {
    const harness = createHarness();
    const unexpected = new Error('unexpected lifecycle database failure');
    harness.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claimed: true }] });
    harness.returningUpdate.mockRejectedValueOnce(unexpected);

    await expect(
      harness.repository.changeLifecycle(context, {
        customerId,
        operationId,
        expectedVersion: 1n,
        action: 'archive',
        requestHash: '1'.repeat(64),
      }),
    ).rejects.toBe(unexpected);
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });
});
