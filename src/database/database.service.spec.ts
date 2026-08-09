import type { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';

import type { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from './database.service';
import type {
  DatabaseClient,
  DatabaseTransaction,
  TenantTransactionContext,
} from './database.types';

describe('DatabaseService tenant transactions', () => {
  const context: TenantTransactionContext = {
    storeId: '18dcbf0a-acbe-48d6-88ed-cd1b078ddf41',
    userId: 'a417fabd-b3c8-409c-9db3-2d62fdce21fd',
    deviceId: '59e90f52-05aa-4bf4-af84-242686f712a8',
    requestId: '9f97bb10-b68a-4474-888e-7244fc581bcb',
  };

  const execute = jest.fn().mockResolvedValue(undefined);
  const lockStore = jest.fn().mockResolvedValue([{ status: 'active' }]);
  const where = jest.fn(() => ({ for: lockStore }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const transaction = {
    execute,
    select,
  } as unknown as DatabaseTransaction;
  const database = {
    transaction: jest.fn(async (work: (value: DatabaseTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  } as unknown as DatabaseClient;
  const pool = {
    on: jest.fn(),
  } as unknown as Pool;
  const config = {} as AppConfigService;
  const logger = {
    error: jest.fn(),
  } as unknown as PinoLogger;
  const service = new DatabaseService(database, pool, config, logger);

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue(undefined);
    lockStore.mockResolvedValue([{ status: 'active' }]);
  });

  it('sets every required transaction-local tenant value before work runs', async () => {
    const work = jest.fn().mockResolvedValue('completed');

    await expect(service.withTenantTransaction(context, work)).resolves.toBe('completed');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(work).toHaveBeenCalledWith(transaction);
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed context before opening a transaction', async () => {
    await expect(
      service.withTenantTransaction(
        {
          ...context,
          storeId: 'not-a-uuid',
        },
        jest.fn(),
      ),
    ).rejects.toThrow('must be UUIDs');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('authorizes an active store and invokes work once on the locking transaction', async () => {
    const work = jest.fn().mockResolvedValue('written');

    await expect(service.withBusinessWriteTransaction(context, work)).resolves.toBe('written');

    expect(execute).toHaveBeenCalledTimes(4);
    expect(lockStore).toHaveBeenCalledWith('share');
    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith(transaction);
    const lockCallOrder = lockStore.mock.invocationCallOrder[0];
    const workCallOrder = work.mock.invocationCallOrder[0];
    if (lockCallOrder === undefined || workCallOrder === undefined) {
      throw new Error('Expected the store lock and protected work to be invoked.');
    }
    expect(lockCallOrder).toBeLessThan(workCallOrder);
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['read_only', 'suspended', 'archived'])(
    'denies a %s store before invoking protected work',
    async (status) => {
      lockStore.mockResolvedValueOnce([{ status }]);
      const work = jest.fn();

      await expect(service.withBusinessWriteTransaction(context, work)).rejects.toMatchObject({
        status: 403,
        response: {
          code: 'BUSINESS_WRITE_NOT_ALLOWED',
          message: 'Business writes are not allowed.',
        },
      });
      expect(work).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the authoritative store is missing', async () => {
    lockStore.mockResolvedValueOnce([]);
    const work = jest.fn();

    await expect(service.withBusinessWriteTransaction(context, work)).rejects.toMatchObject({
      status: 403,
      response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' },
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('fails closed before opening a transaction when trusted context is missing', async () => {
    const work = jest.fn();

    await expect(
      service.withBusinessWriteTransaction(undefined as unknown as TenantTransactionContext, work),
    ).rejects.toBeInstanceOf(TypeError);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('does not invoke protected work when tenant setup or store locking fails', async () => {
    const setupWork = jest.fn();
    execute.mockRejectedValueOnce(new Error('context setup failed'));
    await expect(service.withBusinessWriteTransaction(context, setupWork)).rejects.toThrow(
      'context setup failed',
    );
    expect(setupWork).not.toHaveBeenCalled();

    const lockWork = jest.fn();
    lockStore.mockRejectedValueOnce(new Error('store lock failed'));
    await expect(service.withBusinessWriteTransaction(context, lockWork)).rejects.toThrow(
      'store lock failed',
    );
    expect(lockWork).not.toHaveBeenCalled();
  });
});

describe('DatabaseService runtime role safety', () => {
  const safeInspection = {
    isSuperuser: false,
    bypassesRls: false,
    canCreateDatabases: false,
    canCreateRoles: false,
    canReplicate: false,
    rowSecurityEnabled: true,
    isRuntimeRoleMember: true,
    isMigrationRoleMember: false,
    isAuthenticationRoleMember: false,
    canSetMigrationRole: false,
    canSetAuthenticationRole: false,
    canSetAuthenticationOwnerRole: false,
    hasRuntimeSchemaAccess: true,
    hasRestrictedSchemaAccess: false,
    hasAuthenticationSchemaAccess: false,
    hasGlobalIdentityTableAccess: false,
    ownsProtectedTables: false,
  };

  function createReadinessService(inspection: typeof safeInspection): {
    service: DatabaseService;
    query: jest.Mock;
  } {
    const query = jest.fn().mockResolvedValue({ rows: [inspection] });
    const pool = {
      on: jest.fn(),
      query,
    } as unknown as Pool;
    const service = new DatabaseService(
      {} as DatabaseClient,
      pool,
      {} as AppConfigService,
      {
        error: jest.fn(),
      } as unknown as PinoLogger,
    );

    return { service, query };
  }

  it('accepts the least-privileged runtime role', async () => {
    const { service } = createReadinessService(safeInspection);

    await expect(service.checkReadiness(500)).resolves.toMatchObject({ ready: true });
  });

  it('rejects runtime membership or access in the authentication boundary', async () => {
    for (const unsafeInspection of [
      { ...safeInspection, isAuthenticationRoleMember: true },
      { ...safeInspection, canSetAuthenticationOwnerRole: true },
      { ...safeInspection, hasAuthenticationSchemaAccess: true },
      { ...safeInspection, hasGlobalIdentityTableAccess: true },
    ]) {
      const { service } = createReadinessService(unsafeInspection);
      await expect(service.checkReadiness(500)).resolves.toMatchObject({ ready: false });
    }
  });
});
