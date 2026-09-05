import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles, type MigrationFile } from '../scripts/migrations/migration-files';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

export const inventoryMigrationFilename = '0007_inventory_physical_foundation.sql';

export interface InventoryTestDatabase {
  admin: Pool;
  runtime: Pool;
  migration: Pool;
  file: MigrationFile;
  close(): Promise<void>;
}

// An isolated, freshly created database exercises both empty initialization and
// the six-migration upgrade path. Never replay the baseline in the source DB.
export async function createInventoryTestDatabase(): Promise<InventoryTestDatabase> {
  const environment = readLocalPostgresTestEnvironment();
  if (!environment) throw new Error('The approved local PostgreSQL test environment is required.');
  const databaseName = `dokana_s112_${randomUUID().replaceAll('-', '')}`;
  if (
    !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName) ||
    databaseName === environment.databaseName
  ) {
    throw new Error('Invalid disposable inventory database name.');
  }
  const withDatabase = (url: string, name: string): string => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };
  const management = createTestPool(
    withDatabase(environment.adminUrl, 'postgres'),
    'dokana-s112-management',
    1,
  );
  // Fixture creation/teardown only. Runtime/migration connections always retain
  // normal triggers, constraints and RLS; no application invariant is tested here.
  const admin = createTestPool(
    withDatabase(environment.adminUrl, databaseName),
    'dokana-s112-admin',
    2,
    '-c session_replication_role=replica -c app.suppress_change_events=on',
  );
  const runtime = createTestPool(
    withDatabase(environment.runtimeUrl, databaseName),
    'dokana-s112-runtime',
    4,
  );
  const migration = createTestPool(
    withDatabase(environment.migrationUrl, databaseName),
    'dokana-s112-migration',
    1,
  );
  let created = false;
  const close = async (): Promise<void> => {
    await Promise.all([admin.end(), runtime.end(), migration.end()]);
    try {
      if (created) {
        // Only this invocation's generated database; never FORCE/terminate other sessions.
        await management.query(`drop database "${databaseName}"`);
        created = false;
      }
    } finally {
      await management.end();
    }
  };
  try {
    const roles = await management.query<{ valid: boolean }>(`
      select current_user = 'postgres' and
        (select count(*) = 3 from pg_roles where rolname in
          ('shop_app_runtime', 'shop_app_migrator', 'shop_app_readonly')) as valid
    `);
    if (!roles.rows[0]?.valid)
      throw new Error('Existing approved local PostgreSQL roles are required.');
    await management.query(`create database "${databaseName}" template template0`);
    created = true;
    await admin.query(
      await readFile(
        resolve(
          'database/reference/backend_database_reference/shop_ledger_postgresql_v1_all_in_one.sql',
        ),
        'utf8',
      ),
    );
    const files = await readMigrationFiles();
    const file = files.find((item) => item.filename === inventoryMigrationFilename);
    if (!file) throw new Error('Inventory migration is missing.');
    for (const prior of files.filter((item) => item.filename < inventoryMigrationFilename)) {
      if (Number(prior.filename.slice(0, 4)) <= 3) {
        await admin.query(prior.contents);
        if (prior.filename.startsWith('0002')) {
          const first = files.find((item) => item.filename.startsWith('0001'));
          if (!first) throw new Error('Context migration is missing.');
          await registerBootstrap(admin, first);
        }
        if (!prior.filename.startsWith('0001')) await registerBootstrap(admin, prior);
      } else {
        const client = await migration.connect();
        try {
          await verifyMigrationSession(client);
          await applyMigration(client, prior);
        } finally {
          await client.query('reset role');
          client.release();
        }
      }
    }
    return { admin, runtime, migration, file, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function registerBootstrap(admin: Pool, file: MigrationFile): Promise<void> {
  await admin.query(
    `insert into platform.schema_migrations
    (filename, checksum_sha256, applied_at, applied_by, execution_ms, metadata)
    values ($1, $2, clock_timestamp(), current_user, 0, '{"fixture":"isolated-s112"}'::jsonb)`,
    [file.filename, file.checksumSha256],
  );
}

export async function setInventoryContext(
  client: PoolClient,
  storeId: string,
  deviceId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `select set_config('app.store_id', $1, true), set_config('app.device_id', $2, true),
    set_config('app.user_id', $3, true), set_config('app.request_id', $4, true)`,
    [storeId, deviceId, userId, randomUUID()],
  );
}
