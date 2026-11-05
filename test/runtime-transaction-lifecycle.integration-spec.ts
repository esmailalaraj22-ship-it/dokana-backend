import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';

import { createRuntimeDatabase } from '../src/database/database.providers';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;
jest.setTimeout(30_000);

describeDatabase('runtime transaction lease lifecycle with real PostgreSQL', () => {
  let pool: Pool;
  let admin: Pool;

  beforeEach(() => {
    if (!environment) throw new Error('Local PostgreSQL is required.');
    pool = createTestPool(environment.runtimeUrl, 'dokana-runtime-lease-test', 2);
    admin = createTestPool(environment.adminUrl, 'dokana-runtime-lease-admin', 1);
  });
  afterEach(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  it('releases repeated connections lost before BEGIN without losing pool capacity', async () => {
    const database = createRuntimeDatabase(pool);
    const connect = pool.connect.bind(pool);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const acquisition = jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
        const client = await connect();
        client.on('error', () => undefined);
        // Real server-side failure at the acquisition/BEGIN boundary, not a mocked query error.
        const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
          ?.pid;
        const ended = new Promise<void>((resolve) => {
          client.once('end', resolve);
        });
        await admin.query('select pg_terminate_backend($1)', [pid]);
        await ended;
        return client;
      });
      const work = jest.fn();
      try {
        await expect(database.transaction(work)).rejects.toThrow();
        expect(work).not.toHaveBeenCalled();
        expect(pool.totalCount).toBe(0);
        expect(pool.idleCount).toBe(0);
      } finally {
        acquisition.mockRestore();
      }
    }
    await expect(
      database.transaction((transaction) => transaction.execute(sql`select 1`)),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('discards the connection if ROLLBACK cannot run and permits a replacement lease', async () => {
    const database = createRuntimeDatabase(pool);
    let ended: Promise<unknown> | undefined;
    pool.once('acquire', (client: PoolClient) => {
      client.on('error', () => undefined);
      // events.once rejects on error; the end event is the condition needed here.
      ended = new Promise<void>((resolve) => {
        client.once('end', resolve);
      });
    });
    await expect(
      database.transaction(async (transaction) => {
        const result = await transaction.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        await admin.query('select pg_terminate_backend($1)', [result.rows[0]?.pid]);
        await ended;
        throw new Error('Work interrupted by connection loss.');
      }),
    ).rejects.toThrow('Work interrupted by connection loss.');
    expect(pool.totalCount).toBe(0);
    await expect(
      database.transaction((transaction) => transaction.execute(sql`select 1`)),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('reuses a committed lease without tenant context and rolls back failed writes', async () => {
    const database = createRuntimeDatabase(pool);
    const storeId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('app.store_id', ${storeId}, true)`);
    });
    expect(pool.idleCount).toBe(1);
    const context = await pool.query<{ storeId: string | null }>(
      "select nullif(current_setting('app.store_id', true), '') as \"storeId\"",
    );
    expect(context.rows[0]?.storeId).toBeNull();
    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.store_id', ${storeId}, true)`);
        await transaction.execute(
          sql`insert into ledger.stores(id, name) values (${storeId}::uuid, 'Lease rollback probe')`,
        );
        throw new Error('rollback probe');
      }),
    ).rejects.toThrow('rollback probe');
    expect(
      (await admin.query('select id from ledger.stores where id=$1', [storeId])).rowCount,
    ).toBe(0);
    expect(pool.totalCount).toBe(0);
    const snapshot = await database.transaction(
      (transaction) =>
        transaction.execute(
          sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as readonly`,
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    expect(snapshot.rows[0]).toEqual({ isolation: 'repeatable read', readonly: 'on' });
  });

  it('isolates concurrent tenant contexts and preserves nested savepoint behavior', async () => {
    const database = createRuntimeDatabase(pool);
    const stores = [randomUUID(), randomUUID()];
    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const results = await Promise.all(
      stores.map((store) =>
        database.transaction(async (transaction) => {
          await transaction.execute(sql`select set_config('app.store_id', ${store}, true)`);
          await expect(
            transaction.transaction(async (savepoint) => {
              await savepoint.execute(
                sql`select set_config('app.store_id', ${randomUUID()}, true)`,
              );
              throw new Error('savepoint rejection');
            }),
          ).rejects.toThrow('savepoint rejection');
          arrived += 1;
          if (arrived === stores.length) releaseBarrier();
          await barrier;
          const result = await transaction.execute<{ store: string }>(
            sql`select current_setting('app.store_id') as store`,
          );
          return result.rows[0]?.store;
        }),
      ),
    );
    expect(results).toEqual(stores);
    expect(pool.idleCount).toBe(2);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        expect(
          (
            await client.query<{ store: string | null }>(
              "select nullif(current_setting('app.store_id', true), '') as store",
            )
          ).rows[0]?.store,
        ).toBeNull();
      }
    } finally {
      clients.forEach((client) => client.release());
    }
  });

  it('cleans up a statement timeout and permits another transaction', async () => {
    const database = createRuntimeDatabase(pool);
    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`set local statement_timeout='20ms'`);
        await transaction.execute(sql`select pg_sleep(1)`);
      }),
    ).rejects.toMatchObject({ cause: { code: '57014' } });
    expect(pool.totalCount).toBe(0);
    await expect(
      database.transaction((transaction) => transaction.execute(sql`select 1`)),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
