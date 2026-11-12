import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';

import type { AppConfigService } from '../src/config/app-config.service';
import { createRuntimeDatabase } from '../src/database/database.providers';
import { DatabaseService } from '../src/database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../src/database/database.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;
jest.setTimeout(30_000);

function context(): TenantTransactionContext {
  return {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    requestId: randomUUID(),
    recoveryGenerationId: randomUUID(),
  };
}

async function identity(transaction: DatabaseTransaction) {
  return (
    await transaction.execute(sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid,
    current_setting('app.store_id') as store, current_setting('app.user_id') as actor,
    current_setting('app.device_id') as device, current_setting('app.request_id') as request,
    current_setting('app.recovery_generation_id') as generation`)
  ).rows[0];
}

describeDatabase('Stage 3A C04 transaction nesting', () => {
  let pool: Pool;
  let admin: Pool;
  let database: DatabaseService;
  let contexts: [TenantTransactionContext, TenantTransactionContext];
  beforeEach(() => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    contexts = [context(), context()];
    pool = createTestPool(environment.runtimeUrl, 'dokana-stage3a-nesting', 2);
    admin = createTestPool(environment.adminUrl, 'dokana-stage3a-nesting-observer', 1);
    database = new DatabaseService(
      createRuntimeDatabase(pool),
      pool,
      {} as AppConfigService,
      { error: jest.fn() } as unknown as PinoLogger,
    );
  });

  afterEach(async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role=replica');
      for (const table of [
        'sync.store_change_events_v1',
        'sync.store_change_watermarks_v1',
        'sync.change_events',
        'audit.central_audit_logs',
      ]) {
        await client.query(`delete from ${table} where store_id=any($1::uuid[])`, [
          contexts.map((value) => value.storeId),
        ]);
      }
      await client.query('delete from ledger.stores where id=any($1::uuid[])', [
        contexts.map((value) => value.storeId),
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
      await Promise.all([pool.end(), admin.end()]);
    }
  });

  it.each(['success', 'outer-failure', 'inner-caught', 'inner-uncaught'] as const)(
    'keeps %s savepoint effects and all five context values within the outer transaction',
    async (scenario) => {
      const ctx = contexts[0];
      const failure = new Error('C04 controlled failure');
      const operation = database.withTenantTransaction(ctx, async (outer) => {
        await outer.execute(
          sql`insert into ledger.stores(id, name) values(${ctx.storeId}::uuid, 'C04 outer')`,
        );
        const before = await identity(outer);
        const nested = outer.transaction(async (inner) => {
          expect(await identity(inner)).toEqual(before);
          await inner.execute(
            sql`update ledger.stores set phone='inner' where id=${ctx.storeId}::uuid`,
          );
          if (scenario.startsWith('inner-')) {
            for (const key of [
              'store_id',
              'user_id',
              'device_id',
              'request_id',
              'recovery_generation_id',
            ]) {
              await inner.execute(sql`select set_config(${`app.${key}`}, ${randomUUID()}, true)`);
            }
            throw failure;
          }
        });
        if (scenario === 'inner-caught') await expect(nested).rejects.toBe(failure);
        else await nested;
        expect(await identity(outer)).toEqual(before);
        if (scenario === 'outer-failure') throw failure;
        await outer.execute(
          sql`update ledger.stores set name='C04 continued' where id=${ctx.storeId}::uuid`,
        );
      });
      if (scenario === 'outer-failure' || scenario === 'inner-uncaught')
        await expect(operation).rejects.toBe(failure);
      else await operation;
      const rows = (
        await admin.query<{ name: string; phone: string | null }>(
          'select name, phone from ledger.stores where id=$1',
          [ctx.storeId],
        )
      ).rows;
      expect(rows).toEqual(
        scenario === 'outer-failure' || scenario === 'inner-uncaught'
          ? []
          : [{ name: 'C04 continued', phone: scenario === 'inner-caught' ? null : 'inner' }],
      );
      expect(pool.totalCount - pool.idleCount).toBe(0);
    },
  );

  it.each([false, true])(
    'reuses one offline connection and transaction, downstream failure=%s',
    async (fail) => {
      const ctx = contexts[0];
      const failure = new Error('C04 downstream failure');
      const connect = jest.spyOn(pool, 'connect');
      const operation = database.withOfflineOperationTransaction(
        ctx,
        { operationId: randomUUID(), operationType: 'customers.create.v1' },
        async (outer) => {
          const before = await identity(outer);
          await database.withTenantTransaction(ctx, async (inner) => {
            expect(inner).toBe(outer);
            expect(await identity(inner)).toEqual(before);
            await inner.execute(
              sql`insert into ledger.stores(id, name) values(${ctx.storeId}::uuid, 'C04 reused')`,
            );
            if (fail) throw failure;
          });
        },
      );
      if (fail) await expect(operation).rejects.toBe(failure);
      else await operation;
      expect(connect).toHaveBeenCalledTimes(1);
      expect(
        (await admin.query('select id from ledger.stores where id=$1', [ctx.storeId])).rowCount,
      ).toBe(fail ? 0 : 1);
      expect(pool.totalCount - pool.idleCount).toBe(0);
    },
  );

  it('documents independent ordinary wrapper nesting outside offline scope', async () => {
    const outerContext = contexts[0];
    const innerContext = contexts[1];
    const failure = new Error('C04 outer failure after independent inner commit');
    await expect(
      database.withTenantTransaction(outerContext, async (outer) => {
        await outer.execute(
          sql`insert into ledger.stores(id, name) values(${outerContext.storeId}::uuid, 'C04 outer')`,
        );
        const outerIdentity = await identity(outer);
        await database.withTenantTransaction(innerContext, async (inner) => {
          const innerIdentity = await identity(inner);
          expect(innerIdentity?.pid).not.toBe(outerIdentity?.pid);
          expect(innerIdentity?.xid).not.toBe(outerIdentity?.xid);
          await inner.execute(
            sql`insert into ledger.stores(id, name) values(${innerContext.storeId}::uuid, 'C04 independent')`,
          );
        });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      (await admin.query('select id from ledger.stores where id=$1', [outerContext.storeId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await admin.query('select id from ledger.stores where id=$1', [innerContext.storeId]))
        .rowCount,
    ).toBe(1);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });
});
