import { performance } from 'node:perf_hooks';

import type { PoolClient } from 'pg';

import { createMigrationPool, requiredPostgresUrl } from './migrations/migration-database';
import { readMigrationFile } from './migrations/migration-files';

interface AppliedMigration {
  filename: string;
  checksumSha256: string;
}

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
    throw new Error('The auth schema bootstrap requires the approved postgres session.');
  }
}

async function verifyRegisteredFoundation(client: PoolClient): Promise<void> {
  const files = await Promise.all([
    readMigrationFile('0001_rls_context_function_privileges.sql'),
    readMigrationFile('0002_migration_ownership_foundation.sql'),
  ]);
  const result = await client.query<AppliedMigration>(`
    select filename, checksum_sha256 as "checksumSha256"
    from platform.schema_migrations
    order by filename
  `);

  if (result.rows.length !== files.length) {
    throw new Error('The migration ledger is not at the expected pre-auth state.');
  }

  for (const file of files) {
    const registered = result.rows.find((entry) => entry.filename === file.filename);
    if (registered?.checksumSha256 !== file.checksumSha256) {
      throw new Error(`Migration ledger checksum mismatch: ${file.filename}.`);
    }
  }
}

async function main(): Promise<void> {
  const verifyOnly = process.argv[2] === 'verify';
  if (process.argv[2] !== undefined && !verifyOnly) {
    throw new Error('The only supported auth schema bootstrap option is verify.');
  }

  const migration = await readMigrationFile('0003_authentication_api_schema.sql');
  const pool = createMigrationPool(
    requiredPostgresUrl('DATABASE_ADMIN_URL'),
    'dokana-auth-schema-bootstrap',
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
    await verifyRegisteredFoundation(client);

    const startedAt = performance.now();
    await client.query(migration.contents);
    const executionMs = Math.max(0, Math.round(performance.now() - startedAt));

    const schemaState = await client.query<{ owner: string; functionCount: number }>(`
      select
        pg_get_userbyid(namespace.nspowner) as owner,
        (
          select count(*)::integer
          from pg_proc as function_state
          where function_state.pronamespace = namespace.oid
        ) as "functionCount"
      from pg_namespace as namespace
      where namespace.nspname = 'auth_api'
    `);
    if (
      schemaState.rows[0]?.owner !== 'shop_app_auth_owner' ||
      schemaState.rows[0].functionCount !== 0
    ) {
      throw new Error('The auth API schema bootstrap postcondition failed.');
    }

    if (verifyOnly) {
      await client.query('rollback');
      transactionStarted = false;
      process.stdout.write(
        'Authentication schema bootstrap check: OK (rolled back; no changes made).\n',
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
        values ($1, $2, clock_timestamp(), $3, $4, $5::jsonb)
      `,
      [
        migration.filename,
        migration.checksumSha256,
        'postgres (one-time auth schema bootstrap)',
        executionMs,
        JSON.stringify({
          bootstrap: true,
          scope: 'auth_api_schema_only',
          persistentDatabaseCreateGrant: false,
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

  process.stdout.write('Authentication schema bootstrap: OK (0003 applied and registered).\n');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown auth schema failure.';
  process.stderr.write(`Authentication schema bootstrap: FAIL (${message})\n`);
  process.exitCode = 1;
});
