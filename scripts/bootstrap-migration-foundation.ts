import { performance } from 'node:perf_hooks';

import type { PoolClient } from 'pg';

import { station2MigrationChecksum } from './migrations/application-object-inventory';
import { createMigrationPool, requiredPostgresUrl } from './migrations/migration-database';
import { readMigrationFile } from './migrations/migration-files';
import {
  verifyApplicationInventory,
  verifyStation2ContextFunctions,
} from './migrations/verify-application-inventory';

async function verifyAdministrativeSession(client: PoolClient): Promise<void> {
  const result = await client.query<{
    sessionUser: string;
    currentUser: string;
    isSuperuser: boolean;
  }>(`
    select
      session_user as "sessionUser",
      current_user as "currentUser",
      role_state.rolsuper as "isSuperuser"
    from pg_roles as role_state
    where role_state.rolname = current_user
  `);
  const state = result.rows[0];

  if (state?.sessionUser !== 'postgres' || state.currentUser !== 'postgres' || !state.isSuperuser) {
    throw new Error('The ownership bootstrap requires the approved postgres session.');
  }
}

async function assertLedgerAbsent(client: PoolClient): Promise<void> {
  const result = await client.query<{ ledger: string | null }>(
    `select to_regclass('platform.schema_migrations')::text as ledger`,
  );
  if (result.rows[0]?.ledger !== null) {
    throw new Error('The migration foundation is already bootstrapped.');
  }
}

async function main(): Promise<void> {
  const verifyOnly = process.argv[2] === 'verify';
  if (process.argv[2] !== undefined && !verifyOnly) {
    throw new Error('The only supported bootstrap option is verify.');
  }

  const migration0001 = await readMigrationFile('0001_rls_context_function_privileges.sql');
  const migration0002 = await readMigrationFile('0002_migration_ownership_foundation.sql');

  if (migration0001.checksumSha256 !== station2MigrationChecksum) {
    throw new Error('Migration 0001 does not match the approved repository checksum.');
  }

  const pool = createMigrationPool(
    requiredPostgresUrl('DATABASE_ADMIN_URL'),
    'dokana-migration-foundation-bootstrap',
  );
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('begin');
    transactionStarted = true;
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('dokana:migration-foundation', 0))`,
    );
    await verifyAdministrativeSession(client);
    await assertLedgerAbsent(client);
    await verifyApplicationInventory(client, 'postgres', false);
    await verifyStation2ContextFunctions(client, 'postgres');

    const startedAt = performance.now();
    await client.query(migration0002.contents);
    const executionMs = Math.max(0, Math.round(performance.now() - startedAt));

    await verifyApplicationInventory(client, 'shop_app_migrator', true);
    await verifyStation2ContextFunctions(client, 'shop_app_migrator');

    if (verifyOnly) {
      await client.query('rollback');
      transactionStarted = false;
      process.stdout.write(
        'Migration foundation check: OK (0001 and 0002 verified in a rolled-back transaction).\n',
      );
      return;
    }

    await client.query(
      `
        insert into platform.schema_migrations (
          filename,
          checksum_sha256,
          applied_at,
          applied_by,
          execution_ms,
          metadata
        )
        values
          ($1, $2, clock_timestamp(), $3, 0, $4::jsonb),
          ($5, $6, clock_timestamp(), $7, $8, $9::jsonb)
      `,
      [
        migration0001.filename,
        migration0001.checksumSha256,
        'postgres (verified pre-existing migration)',
        JSON.stringify({
          registration: 'verified_preexisting',
          originalAppliedAtKnown: false,
          replayed: false,
        }),
        migration0002.filename,
        migration0002.checksumSha256,
        'postgres (one-time ownership bootstrap)',
        executionMs,
        JSON.stringify({
          bootstrap: true,
          ownershipTransition: 'postgres_to_shop_app_migrator',
        }),
      ],
    );

    await client.query('commit');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query('rollback');
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  process.stdout.write(
    'Migration foundation: OK (0001 verified and registered; 0002 applied and registered).\n',
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown bootstrap failure.';
  process.stderr.write(`Migration foundation: FAIL (${message})\n`);
  process.exitCode = 1;
});
