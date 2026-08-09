import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PinoLogger } from 'nestjs-pino';
import type { Pool, PoolClient, QueryResult } from 'pg';

import type { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { devices, stores } from '../src/database/schema';
import * as databaseSchema from '../src/database/schema';
import type {
  DatabaseClient,
  DatabaseTransaction,
  TenantTransactionContext,
} from '../src/database/database.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

const storeIds = {
  primary: '41000000-0000-4000-8000-000000000001',
  other: '41000000-0000-4000-8000-000000000002',
};
const context: TenantTransactionContext = {
  storeId: storeIds.primary,
  userId: randomUUID(),
  deviceId: randomUUID(),
  requestId: randomUUID(),
};

function deviceRecord(storeId: string, id: string, label: string) {
  return {
    id,
    storeId,
    deviceName: label,
    platform: 'android' as const,
    installationId: id,
    devicePrefix: id.replaceAll('-', '').slice(0, 12),
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Store-level business-write authorization', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let databaseService: DatabaseService;
  let poolsInitialized = false;

  async function removeFixtureEffects(): Promise<void> {
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      [storeIds.primary, storeIds.other],
    ]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      [storeIds.primary, storeIds.other],
    ]);
  }

  async function resetFixtures(): Promise<void> {
    await removeFixtureEffects();
    await adminPool.query(
      `
        update ledger.stores
        set status = 'active', name = case id when $1 then 'Task 4.1 Primary' else 'Task 4.1 Other' end
        where id = any($2::uuid[])
      `,
      [storeIds.primary, [storeIds.primary, storeIds.other]],
    );
  }

  async function readPoolContext(): Promise<
    | {
        storeId: string | null;
        userId: string | null;
        deviceId: string | null;
        requestId: string | null;
      }
    | undefined
  > {
    const result = await runtimePool.query<{
      storeId: string | null;
      userId: string | null;
      deviceId: string | null;
      requestId: string | null;
    }>(`
      select
        nullif(current_setting('app.store_id', true), '') as "storeId",
        nullif(current_setting('app.user_id', true), '') as "userId",
        nullif(current_setting('app.device_id', true), '') as "deviceId",
        nullif(current_setting('app.request_id', true), '') as "requestId"
    `);
    return result.rows[0];
  }

  async function waitForBlockedStatusUpdate(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const result = await adminPool.query<{ blocked: boolean }>(
        `select cardinality(pg_blocking_pids($1)) > 0 as blocked`,
        [pid],
      );
      if (result.rows[0]?.blocked) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('The competing store-status update did not enter a lock wait.');
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The local PostgreSQL test environment is unavailable.');
    }

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task41-admin',
      3,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task41-runtime', 1);
    poolsInitialized = true;

    await removeFixtureEffects();
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [
      [storeIds.primary, storeIds.other],
    ]);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values ($1, 'Task 4.1 Primary', 'active'), ($2, 'Task 4.1 Other', 'active')
      `,
      [storeIds.primary, storeIds.other],
    );

    const database = drizzle(runtimePool, {
      casing: 'snake_case',
      logger: false,
      schema: databaseSchema,
    }) as DatabaseClient;
    databaseService = new DatabaseService(
      database,
      runtimePool,
      {} as AppConfigService,
      {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
      } as unknown as PinoLogger,
    );
  });

  beforeEach(async () => {
    await resetFixtures();
  });

  afterAll(async () => {
    if (!poolsInitialized) {
      return;
    }
    await removeFixtureEffects();
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [
      [storeIds.primary, storeIds.other],
    ]);
    const residue = await adminPool.query<{ count: number }>(
      `
        select (
          (select count(*) from ledger.stores where id = any($1::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [[storeIds.primary, storeIds.other]],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end()]);
  });

  it('runs active-store work once on the context-setting transaction and commits it', async () => {
    const deviceId = randomUUID();
    const work = jest.fn(async (transaction: DatabaseTransaction) => {
      const transactionState = await transaction.execute<{
        isolationLevel: string;
        storeId: string;
      }>(sql`
        select
          current_setting('transaction_isolation') as "isolationLevel",
          current_setting('app.store_id') as "storeId"
      `);
      expect(transactionState.rows[0]).toEqual({
        isolationLevel: 'read committed',
        storeId: context.storeId,
      });

      const inserted = await transaction
        .insert(devices)
        .values(deviceRecord(context.storeId, deviceId, 'Authorized business write'))
        .returning({ id: devices.id });
      return inserted[0]?.id;
    });

    await expect(databaseService.withBusinessWriteTransaction(context, work)).resolves.toBe(
      deviceId,
    );
    expect(work).toHaveBeenCalledTimes(1);

    const persisted = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where id = $1`,
      [deviceId],
    );
    expect(persisted.rows[0]?.count).toBe(1);
    await expect(readPoolContext()).resolves.toEqual({
      storeId: null,
      userId: null,
      deviceId: null,
      requestId: null,
    });
  });

  it.each(['read_only', 'suspended', 'archived'] as const)(
    'observes a committed %s transition and never invokes protected work',
    async (status) => {
      const authenticatedState = await adminPool.query<{ status: string }>(
        `select status from ledger.stores where id = $1`,
        [context.storeId],
      );
      expect(authenticatedState.rows[0]?.status).toBe('active');

      await adminPool.query(`update ledger.stores set status = $2 where id = $1`, [
        context.storeId,
        status,
      ]);
      const deviceId = randomUUID();
      const work = jest.fn(async (transaction: DatabaseTransaction) =>
        transaction.insert(devices).values(deviceRecord(context.storeId, deviceId, status)),
      );

      await expect(
        databaseService.withBusinessWriteTransaction(context, work),
      ).rejects.toMatchObject({
        status: 403,
        response: {
          code: 'BUSINESS_WRITE_NOT_ALLOWED',
          message: 'Business writes are not allowed.',
        },
      });
      expect(work).not.toHaveBeenCalled();

      const persisted = await adminPool.query<{ count: number }>(
        `select count(*)::integer as count from ledger.devices where id = $1`,
        [deviceId],
      );
      expect(persisted.rows[0]?.count).toBe(0);
    },
  );

  it('fails closed for a missing authoritative store without invoking protected work', async () => {
    const work = jest.fn();

    await expect(
      databaseService.withBusinessWriteTransaction({ ...context, storeId: randomUUID() }, work),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' },
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('rolls back protected work and transaction-local context when the callback fails', async () => {
    const deviceId = randomUUID();
    const work = jest.fn(async (transaction: DatabaseTransaction) => {
      await transaction
        .insert(devices)
        .values(deviceRecord(context.storeId, deviceId, 'Rolled back business write'));
      throw new Error('forced callback failure');
    });

    await expect(databaseService.withBusinessWriteTransaction(context, work)).rejects.toThrow(
      'forced callback failure',
    );
    expect(work).toHaveBeenCalledTimes(1);

    const persisted = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where id = $1`,
      [deviceId],
    );
    expect(persisted.rows[0]?.count).toBe(0);
    await expect(readPoolContext()).resolves.toEqual({
      storeId: null,
      userId: null,
      deviceId: null,
      requestId: null,
    });
  });

  it('uses trusted context for authorization and leaves forged cross-tenant work to RLS', async () => {
    const clientControlledStoreId = storeIds.other;
    const deviceId = randomUUID();
    const work = jest.fn(async (transaction: DatabaseTransaction) => {
      const foreignStore = await transaction
        .select({ status: stores.status })
        .from(stores)
        .where(eq(stores.id, clientControlledStoreId));
      expect(foreignStore).toEqual([]);

      await transaction
        .insert(devices)
        .values(deviceRecord(clientControlledStoreId, deviceId, 'Forged tenant write'));
    });

    await expect(databaseService.withBusinessWriteTransaction(context, work)).rejects.toMatchObject(
      { cause: { code: '42501' } },
    );
    expect(work).toHaveBeenCalledTimes(1);

    const visible = await databaseService.withBusinessWriteTransaction(
      context,
      async (transaction) =>
        transaction
          .select({ id: stores.id })
          .from(stores)
          .where(inArray(stores.id, [storeIds.primary, storeIds.other])),
    );
    expect(visible).toEqual([{ id: storeIds.primary }]);

    const persisted = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.devices where id = $1`,
      [deviceId],
    );
    expect(persisted.rows[0]?.count).toBe(0);
  });

  it('holds the store lock until business commit and serializes a competing status update', async () => {
    const deviceId = randomUUID();
    const authorizationReached = createDeferred();
    const releaseBusinessWork = createDeferred();
    const adminClient: PoolClient = await adminPool.connect();
    let businessTransaction: Promise<string | undefined> | undefined;
    let statusUpdate: Promise<QueryResult<{ status: string }>> | undefined;
    let statusTransactionCommitted = false;

    try {
      await adminClient.query('begin');
      const backend = await adminClient.query<{ pid: number }>(
        `select pg_backend_pid()::integer as pid`,
      );
      const statusBackendPid = backend.rows[0]?.pid;
      if (statusBackendPid === undefined) {
        throw new Error('Unable to identify the status-update backend.');
      }

      businessTransaction = databaseService.withBusinessWriteTransaction(
        context,
        async (transaction) => {
          authorizationReached.resolve();
          await releaseBusinessWork.promise;
          const inserted = await transaction
            .insert(devices)
            .values(deviceRecord(context.storeId, deviceId, 'Business lock winner'))
            .returning({ id: devices.id });
          return inserted[0]?.id;
        },
      );
      await authorizationReached.promise;

      statusUpdate = adminClient.query<{ status: string }>(
        `update ledger.stores set status = 'read_only' where id = $1 returning status`,
        [context.storeId],
      );
      await waitForBlockedStatusUpdate(statusBackendPid);

      releaseBusinessWork.resolve();
      await expect(businessTransaction).resolves.toBe(deviceId);
      await expect(statusUpdate).resolves.toMatchObject({
        rowCount: 1,
        rows: [{ status: 'read_only' }],
      });
      await adminClient.query('commit');
      statusTransactionCommitted = true;
    } finally {
      releaseBusinessWork.resolve();
      await businessTransaction?.catch(() => undefined);
      await statusUpdate?.catch(() => undefined);
      if (!statusTransactionCommitted) {
        await adminClient.query('rollback').catch(() => undefined);
      }
      adminClient.release();
    }

    const finalState = await adminPool.query<{ deviceCount: number; status: string }>(
      `
        select
          (select count(*)::integer from ledger.devices where id = $1) as "deviceCount",
          (select status from ledger.stores where id = $2) as status
      `,
      [deviceId, context.storeId],
    );
    expect(finalState.rows[0]).toEqual({ deviceCount: 1, status: 'read_only' });
  });
});
