import { randomInt, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { createRuntimeDatabase } from '../src/database/database.providers';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;
jest.setTimeout(30_000);

describeDatabase('Stage 3A C05 infrastructure failure truth', () => {
  let pool: Pool;
  let admin: Pool;
  let storeIds: string[];
  beforeEach(() => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    pool = createTestPool(environment.runtimeUrl, 'dokana-stage3a-timeouts', 1);
    admin = createTestPool(environment.adminUrl, 'dokana-stage3a-timeouts-observer', 2);
    storeIds = [];
  });
  afterEach(async () => {
    const cleanup = await admin.connect();
    try {
      await cleanup.query('begin');
      await cleanup.query('set local session_replication_role=replica');
      for (const table of [
        'sync.store_change_events_v1',
        'sync.store_change_watermarks_v1',
        'sync.change_events',
        'audit.central_audit_logs',
      ]) {
        await cleanup.query(`delete from ${table} where store_id=any($1::uuid[])`, [storeIds]);
      }
      await cleanup.query('delete from ledger.stores where id=any($1::uuid[])', [storeIds]);
      await cleanup.query('commit');
    } catch (error) {
      await cleanup.query('rollback');
      throw error;
    } finally {
      cleanup.release();
      await Promise.all([pool.end(), admin.end()]);
    }
  });

  it.each(['statement-timeout', 'lock-timeout', 'pre-commit-loss', 'commit-ack-loss'] as const)(
    'preserves %s outcome and restores capacity and clean context over repeated attempts',
    async (scenario) => {
      const database = createRuntimeDatabase(pool);
      const connect = pool.connect.bind(pool);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const storeId = randomUUID();
        storeIds.push(storeId);
        let ended!: Promise<void>;
        let release!: jest.SpyInstance;
        const unavailable = Object.assign(new Error('Commit acknowledgment unavailable'), {
          code: 'ECONNRESET',
        });
        const acquisition = jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
          const client = await connect();
          client.on('error', () => undefined);
          ended = new Promise<void>((resolve) => client.once('end', resolve));
          release = jest.spyOn(client, 'release');
          if (scenario === 'commit-ack-loss') {
            const query = client.query.bind(client);
            const pid = (await query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
              ?.pid;
            jest.spyOn(client, 'query').mockImplementation((async (...args: unknown[]) => {
              const config = args[0] as string | { text: string };
              const command = typeof config === 'string' ? config : config.text;
              const result = await (Reflect.apply(query, client, args) as Promise<QueryResult>);
              if (command === 'commit') {
                // Actual PostgreSQL COMMIT succeeds, but its acknowledgment is
                // withheld at the driver boundary. This is not a network chaos test.
                await admin.query('select pg_terminate_backend($1)', [pid]);
                await ended;
                throw unavailable;
              }
              return result;
            }) as PoolClient['query']);
          }
          return client;
        });
        const blocker = await admin.connect();
        const lock = randomInt(1, 2_000_000_000);
        let held = false;
        let outcome: unknown;
        let failure: unknown;
        try {
          if (scenario === 'lock-timeout') {
            await blocker.query('select pg_advisory_lock($1)', [lock]);
            held = true;
          }
          try {
            outcome = await database.transaction(async (transaction) => {
              for (const name of [
                'store_id',
                'user_id',
                'device_id',
                'request_id',
                'recovery_generation_id',
              ]) {
                await transaction.execute(
                  sql`select set_config(${`app.${name}`}, ${name === 'store_id' ? storeId : randomUUID()}, true)`,
                );
              }
              await transaction.execute(
                sql`insert into ledger.stores(id, name) values(${storeId}::uuid, 'C05 infrastructure probe')`,
              );
              if (scenario === 'statement-timeout') {
                await transaction.execute(sql`set local statement_timeout='20ms'`);
                await transaction.execute(sql`select pg_sleep(1)`);
              } else if (scenario === 'lock-timeout') {
                await transaction.execute(sql`set local lock_timeout='20ms'`);
                await transaction.execute(sql`select pg_advisory_xact_lock(${lock}::bigint)`);
              } else if (scenario === 'pre-commit-loss') {
                const row = (
                  await transaction.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
                ).rows[0];
                await blocker.query('select pg_terminate_backend($1)', [row?.pid]);
                await ended;
              }
              return 'prepared success';
            });
          } catch (error) {
            failure = error;
          }
        } finally {
          acquisition.mockRestore();
          if (held) await blocker.query('select pg_advisory_unlock($1)', [lock]);
          blocker.release();
        }
        await ended;
        expect(outcome).toBeUndefined();
        expect(failure).toBeInstanceOf(Error);
        if (scenario === 'statement-timeout')
          expect(failure).toMatchObject({ cause: { code: '57014' } });
        if (scenario === 'lock-timeout')
          expect(failure).toMatchObject({ cause: { code: '55P03' } });
        if (scenario === 'commit-ack-loss') expect(failure).toMatchObject({ cause: unavailable });
        expect(
          (await admin.query('select id from ledger.stores where id=$1', [storeId])).rowCount,
        ).toBe(scenario === 'commit-ack-loss' ? 1 : 0);
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(true);
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        const next = await pool.query(`select
          nullif(current_setting('app.store_id', true), '') as store,
          nullif(current_setting('app.user_id', true), '') as actor,
          nullif(current_setting('app.device_id', true), '') as device,
          nullif(current_setting('app.request_id', true), '') as request,
          nullif(current_setting('app.recovery_generation_id', true), '') as generation`);
        expect(next.rows).toEqual([
          { store: null, actor: null, device: null, request: null, generation: null },
        ]);
        await expect(
          database.transaction((tx) => tx.execute(sql`select 1`)),
        ).resolves.toMatchObject({ rowCount: 1 });
        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
      }
    },
  );
});
