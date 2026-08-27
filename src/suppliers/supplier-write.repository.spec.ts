import type { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import { SupplierWriteRepository } from './supplier-write.repository';
import type {
  PreparedSupplierCreate,
  PreparedSupplierLifecycle,
  PreparedSupplierUpdate,
  SupplierMutationRow,
} from './supplier-write.types';

const context: TenantTransactionContext = {
  storeId: '64000000-0000-4000-8000-000000000001',
  userId: '64100000-0000-4000-8000-000000000001',
  deviceId: '64200000-0000-4000-8000-000000000001',
  requestId: '64300000-0000-4000-8000-000000000001',
};
const supplierId = '64400000-0000-4000-8000-000000000001';
const operationId = '64500000-0000-4000-8000-000000000001';
const supplierPhone = '0599 123 456';
const supplierNormalizedPhone = '+970599123456';
const row: SupplierMutationRow = {
  id: supplierId,
  name: 'Supplier Name',
  normalizedName: 'supplier name',
  phone: supplierPhone,
  normalizedPhone: supplierNormalizedPhone,
  status: 'active',
  archivedAt: null,
  updatedAt: new Date('2026-08-27T08:01:00.000Z'),
  notes: null,
  createdAt: new Date('2026-08-27T08:00:00.000Z'),
  version: 1n,
};

const createInput: PreparedSupplierCreate = {
  supplierId,
  operationId,
  name: row.name,
  normalizedName: row.normalizedName,
  phone: supplierPhone,
  normalizedPhone: supplierNormalizedPhone,
  notes: null,
  requestHash: 'a'.repeat(64),
};

interface RepositoryHarness {
  repository: SupplierWriteRepository;
  database: { withTenantTransaction: jest.Mock };
  execute: jest.Mock;
  insert: jest.Mock;
  insertValues: jest.Mock;
  returningInsert: jest.Mock;
  update: jest.Mock;
  updateSet: jest.Mock;
  returningUpdate: jest.Mock;
  select: jest.Mock;
}

function createHarness(current: SupplierMutationRow = row): RepositoryHarness {
  const execute = jest.fn();
  const returningInsert = jest.fn().mockResolvedValue([row]);
  const insertValues = jest.fn(() => ({ returning: returningInsert }));
  const insert = jest.fn(() => ({ values: insertValues }));
  const returningUpdate = jest.fn().mockResolvedValue([{ ...current, version: 2n }]);
  const whereUpdate = jest.fn(() => ({ returning: returningUpdate }));
  const updateSet = jest.fn(() => ({ where: whereUpdate }));
  const update = jest.fn(() => ({ set: updateSet }));
  const select = jest.fn((selection: Record<string, unknown>) => {
    const selectedRows = Object.keys(selection).length === 1 ? [{ status: 'active' }] : [current];
    return {
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() => ({
            for: jest.fn().mockResolvedValue(selectedRows),
          })),
        })),
      })),
    };
  });
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
    withTenantTransaction: jest.fn(
      async (
        _context: TenantTransactionContext,
        work: (value: DatabaseTransaction) => Promise<unknown>,
      ) => work(transaction),
    ),
  };

  return {
    repository: new SupplierWriteRepository(database as unknown as DatabaseService),
    database,
    execute,
    insert,
    insertValues,
    returningInsert,
    update,
    updateSet,
    returningUpdate,
    select,
  };
}

function arrangeNewOperation(harness: RepositoryHarness): void {
  harness.execute
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ claimed: true }] });
}

describe('SupplierWriteRepository', () => {
  it('uses a tenant transaction and inserts only approved fields plus trusted context', async () => {
    const harness = createHarness();
    arrangeNewOperation(harness);
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });

    await expect(harness.repository.create(context, createInput)).resolves.toMatchObject({
      ok: true,
      response: { id: supplierId, operationId },
    });

    expect(harness.database.withTenantTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(harness.insertValues).toHaveBeenCalledWith({
      id: supplierId,
      storeId: context.storeId,
      name: row.name,
      normalizedName: row.normalizedName,
      phone: row.phone,
      normalizedPhone: row.normalizedPhone,
      notes: null,
      status: 'active',
      archivedAt: null,
      deviceId: context.deviceId,
      operationId,
    });
  });

  it('completes a canonical no-op without a Supplier UPDATE', async () => {
    const harness = createHarness();
    arrangeNewOperation(harness);
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });
    const input: PreparedSupplierUpdate = {
      supplierId,
      operationId,
      expectedVersion: 1n,
      name: row.name,
      normalizedName: row.normalizedName,
      phone: supplierPhone,
      normalizedPhone: supplierNormalizedPhone,
      notes: null,
      requestHash: 'b'.repeat(64),
    };

    await expect(harness.repository.update(context, input)).resolves.toMatchObject({
      ok: true,
      response: { version: '1', operationId },
    });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledTimes(3);
  });

  it('preserves omitted legacy phone fields during unrelated PATCH, including F-1 storage shape', async () => {
    const inconsistent = { ...row, normalizedPhone: null };
    const harness = createHarness(inconsistent);
    arrangeNewOperation(harness);
    harness.returningUpdate.mockResolvedValueOnce([
      { ...inconsistent, name: 'Changed', normalizedName: 'changed', version: 2n },
    ]);
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });

    await harness.repository.update(context, {
      supplierId,
      operationId,
      expectedVersion: 1n,
      name: 'Changed',
      normalizedName: 'changed',
      requestHash: 'c'.repeat(64),
    });

    expect(harness.updateSet).toHaveBeenCalledWith({
      deviceId: context.deviceId,
      operationId,
      name: 'Changed',
      normalizedName: 'changed',
    });
  });

  it('replays a stored applied response before the new-write store gate', async () => {
    const harness = createHarness();
    harness.execute.mockResolvedValueOnce({
      rows: [
        {
          deviceId: context.deviceId,
          aggregateType: 'suppliers',
          aggregateId: supplierId,
          action: 'create',
          requestHash: createInput.requestHash,
          status: 'applied',
          responseBody: {
            id: supplierId,
            name: row.name,
            phone: row.phone,
            status: row.status,
            archivedAt: null,
            updatedAt: row.updatedAt.toISOString(),
            notes: row.notes,
            createdAt: row.createdAt.toISOString(),
            version: '1',
            operationId,
          },
          errorCode: null,
        },
      ],
    });

    await expect(harness.repository.create(context, createInput)).resolves.toMatchObject({
      ok: true,
      response: { version: '1' },
    });
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it('maps only the named phone uniqueness constraint to the stable phone conflict', async () => {
    const harness = createHarness();
    arrangeNewOperation(harness);
    harness.returningInsert.mockRejectedValueOnce({
      code: '23505',
      constraint: 'suppliers_store_id_normalized_phone_key',
    });
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });

    await expect(harness.repository.create(context, createInput)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SUPPLIER_PHONE_CONFLICT' },
    });
  });

  it('does not complete an operation after an unexpected Supplier write failure', async () => {
    const harness = createHarness();
    const unexpected = new Error('unexpected Supplier database failure');
    arrangeNewOperation(harness);
    harness.returningUpdate.mockRejectedValueOnce(unexpected);

    await expect(
      harness.repository.update(context, {
        supplierId,
        operationId,
        expectedVersion: 1n,
        name: 'Changed',
        normalizedName: 'changed',
        requestHash: 'd'.repeat(64),
      }),
    ).rejects.toBe(unexpected);
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it('archives through the existing tenant transaction with database-owned archive time', async () => {
    const harness = createHarness();
    const archivedAt = new Date('2026-08-27T09:00:00.000Z');
    arrangeNewOperation(harness);
    harness.returningUpdate.mockResolvedValueOnce([
      { ...row, status: 'archived', archivedAt, version: 2n },
    ]);
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });

    await expect(
      harness.repository.changeLifecycle(context, {
        supplierId,
        operationId,
        expectedVersion: 1n,
        action: 'archive',
        requestHash: 'e'.repeat(64),
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { status: 'archived', archivedAt: archivedAt.toISOString(), version: '2' },
    });

    expect(harness.database.withTenantTransaction).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'archived',
        deviceId: context.deviceId,
        operationId,
      }),
    );
    const updates = (harness.updateSet.mock.calls as unknown[][])[0]?.[0] as
      Record<string, unknown> | undefined;
    expect(updates?.archivedAt).not.toBeInstanceOf(Date);
  });

  it('completes same-state lifecycle as an applied response without Supplier UPDATE', async () => {
    const harness = createHarness();
    arrangeNewOperation(harness);
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });

    await expect(
      harness.repository.changeLifecycle(context, {
        supplierId,
        operationId,
        expectedVersion: 1n,
        action: 'restore',
        requestHash: 'f'.repeat(64),
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { status: 'active', archivedAt: null, version: '1', operationId },
    });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledTimes(3);
  });

  it('validates lifecycle version before same-state no-op classification', async () => {
    const harness = createHarness();
    arrangeNewOperation(harness);
    harness.execute.mockResolvedValueOnce({ rows: [{ operationId }] });
    const input: PreparedSupplierLifecycle = {
      supplierId,
      operationId,
      expectedVersion: 2n,
      action: 'restore',
      requestHash: '1'.repeat(64),
    };

    await expect(harness.repository.changeLifecycle(context, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'SUPPLIER_VERSION_CONFLICT' },
    });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it('does not complete lifecycle after an unexpected database failure', async () => {
    const harness = createHarness();
    const unexpected = new Error('unexpected Supplier lifecycle database failure');
    arrangeNewOperation(harness);
    harness.returningUpdate.mockRejectedValueOnce(unexpected);

    await expect(
      harness.repository.changeLifecycle(context, {
        supplierId,
        operationId,
        expectedVersion: 1n,
        action: 'archive',
        requestHash: '2'.repeat(64),
      }),
    ).rejects.toBe(unexpected);
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });
});
