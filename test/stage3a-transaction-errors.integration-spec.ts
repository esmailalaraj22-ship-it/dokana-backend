import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { createRuntimeDatabase } from '../src/database/database.providers';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;
jest.setTimeout(30_000);

describeDatabase('Stage 3A transaction error precedence and committed cleanup', () => {
  let pool: Pool;
  let admin: Pool;

  async function removeStoreFixture(storeId: string): Promise<void> {
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
        await cleanup.query(`delete from ${table} where store_id=$1`, [storeId]);
      }
      await cleanup.query('delete from ledger.stores where id=$1', [storeId]);
      await cleanup.query('commit');
    } catch (error) {
      await cleanup.query('rollback');
      throw error;
    } finally {
      cleanup.release();
    }
  }

  beforeEach(() => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    pool = createTestPool(environment.runtimeUrl, 'dokana-stage3a-errors', 1);
    admin = createTestPool(environment.adminUrl, 'dokana-stage3a-errors-observer', 1);
  });

  afterEach(async () => {
    await Promise.all([pool.end(), admin.end()]);
  });

  it.each(['before-release', 'release-listener', 'after-release'] as const)(
    'C02 preserves durable success when %s throws and recovers pool capacity',
    async (boundary) => {
      const report = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
      pool.on('error', () => undefined);
      const storeId = randomUUID();
      const connect = pool.connect.bind(pool);
      let leased: PoolClient | undefined;
      const acquisition = jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
        leased = await connect();
        leased.on('error', () => undefined);
        const release = leased.release.bind(leased);
        if (boundary === 'release-listener') {
          pool.once('release', () => {
            throw new Error('Injected release listener failure');
          });
        } else {
          jest.spyOn(leased, 'release').mockImplementationOnce(() => {
            if (boundary === 'after-release') release();
            throw new Error('Injected release bookkeeping failure');
          });
        }
        return leased;
      });
      let response: unknown;
      let failure: unknown;
      try {
        try {
          response = await createRuntimeDatabase(pool).transaction(async (transaction) => {
            await transaction.execute(sql`select set_config('app.store_id', ${storeId}, true)`);
            await transaction.execute(sql`insert into ledger.stores(id, name)
              values (${storeId}::uuid, 'Stage 3A committed cleanup probe')`);
            return 'committed';
          });
        } catch (error) {
          failure = error;
        }
        acquisition.mockRestore();
        expect(
          (await admin.query('select id from ledger.stores where id=$1', [storeId])).rowCount,
        ).toBe(1);
        expect(failure).toBeUndefined();
        expect(response).toBe('committed');
        expect(report).toHaveBeenCalled();
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        expect(
          (await pool.query("select nullif(current_setting('app.store_id', true), '') as store"))
            .rows,
        ).toEqual([{ store: null }]);
        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
      } finally {
        acquisition.mockRestore();
        // Rescue the intentionally broken lease on the pre-fix run as well.
        if (leased) {
          try {
            leased.release(true);
          } catch {
            /* Already consumed release. */
          }
          leased.emit('error', new Error('Stage 3A fixture cleanup'));
        }
        await removeStoreFixture(storeId);
      }
    },
  );

  it.each([
    'commit',
    'callback-rollback',
    'commit-rollback',
    'savepoint-rollback',
    'savepoint-caught',
  ] as const)(
    'preserves %s primary failure, atomic state, capacity and clean context',
    async (scenario) => {
      const database = createRuntimeDatabase(pool);
      const connect = pool.connect.bind(pool);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const storeId = randomUUID();
        const primary = new Error('Stage 3A primary callback failure');
        let release!: jest.SpyInstance;
        let ended!: Promise<void>;
        const commands: string[] = [];
        const acquisition = jest.spyOn(pool, 'connect').mockImplementationOnce(async () => {
          const client = await connect();
          ended = new Promise<void>((resolve) => client.once('end', resolve));
          release = jest.spyOn(client, 'release');
          const query = client.query.bind(client);
          jest.spyOn(client, 'query').mockImplementation((async (...args: unknown[]) => {
            const config = args[0] as string | { text: string };
            const text = typeof config === 'string' ? config : config.text;
            commands.push(text);
            // The transaction and writes are real. Replace only the selected lifecycle
            // command, so PostgreSQL raises the primary/cleanup error deterministically.
            if (text === 'commit' && scenario.startsWith('commit')) {
              return query('select 1 / 0');
            }
            if (
              text === 'rollback' &&
              scenario.endsWith('-rollback') &&
              scenario !== 'savepoint-rollback'
            ) {
              throw new Error('Injected unavailable ROLLBACK transport');
            }
            if (text.startsWith('rollback to savepoint') && scenario.startsWith('savepoint-')) {
              return query('rollback to savepoint stage3a_missing');
            }
            return Reflect.apply(query, client, args) as Promise<QueryResult>;
          }) as PoolClient['query']);
          return client;
        });
        let surfaced: unknown;
        try {
          try {
            await database.transaction(async (transaction) => {
              await transaction.execute(sql`select
                set_config('app.store_id', ${storeId}, true),
                set_config('app.user_id', ${randomUUID()}, true),
                set_config('app.device_id', ${randomUUID()}, true),
                set_config('app.request_id', ${randomUUID()}, true),
                set_config('app.recovery_generation_id', ${randomUUID()}, true)`);
              await transaction.execute(sql`insert into ledger.stores(id, name)
                values (${storeId}::uuid, 'Stage 3A rollback probe')`);
              if (scenario.startsWith('savepoint-')) {
                const nested = transaction.transaction(async () => {
                  throw primary;
                });
                if (scenario === 'savepoint-caught') {
                  await expect(nested).rejects.toBe(primary);
                } else {
                  await nested;
                }
              }
              if (scenario === 'callback-rollback') throw primary;
              return 'prepared success';
            });
          } catch (error) {
            surfaced = error;
          }
        } finally {
          acquisition.mockRestore();
        }
        await ended;
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(true);
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        expect(
          (await admin.query('select id from ledger.stores where id=$1', [storeId])).rowCount,
        ).toBe(0);
        const next = await pool.query<Record<string, string | null>>(`select
          nullif(current_setting('app.store_id', true), '') as store,
          nullif(current_setting('app.user_id', true), '') as actor,
          nullif(current_setting('app.device_id', true), '') as device,
          nullif(current_setting('app.request_id', true), '') as request,
          nullif(current_setting('app.recovery_generation_id', true), '') as generation`);
        expect(next.rows[0]).toEqual({
          store: null,
          actor: null,
          device: null,
          request: null,
          generation: null,
        });
        expect(pool.totalCount).toBe(1);
        expect(pool.idleCount).toBe(1);
        expect(commands).toContain('rollback');
        if (scenario.startsWith('commit')) {
          expect(surfaced).toMatchObject({ cause: { code: '22012' } });
        } else {
          expect(surfaced).toBe(primary);
        }
      }
    },
  );
});
