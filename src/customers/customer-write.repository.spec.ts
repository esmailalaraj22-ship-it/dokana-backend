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
}

function createHarness(): RepositoryHarness {
  const execute = jest.fn();
  const returningInsert = jest.fn().mockResolvedValue([row]);
  const onConflictDoNothing = jest.fn(() => ({ returning: returningInsert }));
  const insertValues = jest.fn(() => ({ onConflictDoNothing }));
  const insert = jest.fn(() => ({ values: insertValues }));
  const returningUpdate = jest.fn().mockResolvedValue([{ ...row, version: 2n }]);
  const whereUpdate = jest.fn(() => ({ returning: returningUpdate }));
  const updateSet = jest.fn(() => ({ where: whereUpdate }));
  const update = jest.fn(() => ({ set: updateSet }));
  const transaction = {
    execute,
    insert,
    update,
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
});
