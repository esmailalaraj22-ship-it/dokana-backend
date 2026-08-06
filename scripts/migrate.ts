import { performance } from 'node:perf_hooks';

import type { PoolClient } from 'pg';

import { createMigrationPool, requiredPostgresUrl } from './migrations/migration-database';
import { readMigrationFiles, type MigrationFile } from './migrations/migration-files';

export type MigrationCommand = 'apply' | 'status' | 'verify';

export interface AppliedMigration {
  filename: string;
  checksumSha256: string;
}

const bootstrapOnlyMigrations = new Set([
  '0001_rls_context_function_privileges.sql',
  '0002_migration_ownership_foundation.sql',
  '0003_authentication_api_schema.sql',
]);

const authOwnerMigrationAllowList = new Set([
  '0004_authentication_database_api.sql',
  '0005_refresh_rotation_session_boundary.sql',
]);

export function parseCommand(value: string | undefined): MigrationCommand {
  if (value === 'apply' || value === 'status' || value === 'verify') {
    return value;
  }
  throw new Error('Expected migration command: apply, status, or verify.');
}

export async function verifyMigrationSession(client: PoolClient): Promise<void> {
  const result = await client.query<{
    sessionUser: string;
    currentUser: string;
    isSuperuser: boolean;
    bypassesRls: boolean;
    canSetMigrator: boolean;
    canSetRuntime: boolean;
    canSetAuth: boolean;
  }>(`
    select
      session_user as "sessionUser",
      current_user as "currentUser",
      role_state.rolsuper as "isSuperuser",
      role_state.rolbypassrls as "bypassesRls",
      pg_has_role(session_user, 'shop_app_migrator', 'SET') as "canSetMigrator",
      pg_has_role(session_user, 'shop_app_runtime', 'SET') as "canSetRuntime",
      pg_has_role(session_user, 'shop_app_auth', 'SET') as "canSetAuth"
    from pg_roles as role_state
    where role_state.rolname = current_user
  `);
  const state = result.rows[0];

  if (
    state?.sessionUser !== 'dokana_migration_login' ||
    state.currentUser !== 'dokana_migration_login' ||
    state.isSuperuser ||
    state.bypassesRls ||
    !state.canSetMigrator ||
    state.canSetRuntime ||
    state.canSetAuth
  ) {
    throw new Error('Migration execution requires the approved limited migration login.');
  }

  await client.query('set role shop_app_migrator');
  const effectiveRole = await client.query<{ currentUser: string; sessionUser: string }>(`
    select current_user as "currentUser", session_user as "sessionUser"
  `);
  const effectiveRoleState = effectiveRole.rows[0];
  if (
    effectiveRoleState?.currentUser !== 'shop_app_migrator' ||
    effectiveRoleState.sessionUser !== 'dokana_migration_login'
  ) {
    throw new Error('The approved migration role transition failed.');
  }
}

export function validateRoleSwitches(migration: MigrationFile): void {
  const roleSwitches = migration.contents.match(/\bset\s+(?:local\s+)?role\s+[a-z0-9_]+/gi) ?? [];

  if (roleSwitches.length === 0) {
    return;
  }
  if (!authOwnerMigrationAllowList.has(migration.filename)) {
    throw new Error(`Migration ${migration.filename} contains a prohibited role transition.`);
  }
  if (
    roleSwitches.some(
      (statement) =>
        statement.trim().replace(/\s+/g, ' ').toLowerCase() !==
        'set local role shop_app_auth_owner',
    )
  ) {
    throw new Error(`Migration ${migration.filename} contains a prohibited role transition.`);
  }
}

async function readAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const ledger = await client.query<{ ledger: string | null; owner: string | null }>(`
    select
      to_regclass('platform.schema_migrations')::text as ledger,
      case
        when to_regclass('platform.schema_migrations') is null then null
        else pg_get_userbyid(
          (select relowner from pg_class where oid = 'platform.schema_migrations'::regclass)
        )
      end as owner
  `);
  const ledgerState = ledger.rows[0];
  if (
    ledgerState?.ledger !== 'platform.schema_migrations' ||
    ledgerState.owner !== 'shop_app_migrator'
  ) {
    throw new Error('The verified migration foundation is not installed.');
  }

  const result = await client.query<AppliedMigration>(`
    select filename, checksum_sha256 as "checksumSha256"
    from platform.schema_migrations
    order by filename
  `);
  return result.rows;
}

export function verifyChecksums(files: MigrationFile[], applied: AppliedMigration[]): void {
  const filesByName = new Map(files.map((file) => [file.filename, file]));

  for (const migration of applied) {
    const file = filesByName.get(migration.filename);
    if (!file) {
      throw new Error(`Applied migration file is missing: ${migration.filename}.`);
    }
    if (file.checksumSha256 !== migration.checksumSha256) {
      throw new Error(`Applied migration checksum mismatch: ${migration.filename}.`);
    }
  }
}

export async function applyMigration(client: PoolClient, migration: MigrationFile): Promise<void> {
  validateRoleSwitches(migration);
  const startedAt = performance.now();
  await client.query('begin');

  try {
    await client.query('set local role shop_app_migrator');
    await client.query(migration.contents);
    await client.query('set local role shop_app_migrator');

    const effectiveRole = await client.query<{ currentUser: string }>(
      `select current_user as "currentUser"`,
    );
    if (effectiveRole.rows[0]?.currentUser !== 'shop_app_migrator') {
      throw new Error('Migration did not restore the approved effective role.');
    }

    const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
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
        values ($1, $2, clock_timestamp(), current_user, $3, $4::jsonb)
      `,
      [
        migration.filename,
        migration.checksumSha256,
        executionMs,
        JSON.stringify({
          runner: 'scripts/migrate.ts',
          sessionUser: 'dokana_migration_login',
          transactional: true,
        }),
      ],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const files = await readMigrationFiles();
  const pool = createMigrationPool(
    requiredPostgresUrl('DATABASE_MIGRATION_URL'),
    `dokana-migration-${command}`,
  );
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await verifyMigrationSession(client);
    const lockResult = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtextextended('dokana:migrations', 0)) as acquired`,
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new Error('Another migration runner holds the advisory lock.');
    }

    const applied = await readAppliedMigrations(client);
    verifyChecksums(files, applied);
    const appliedNames = new Set(applied.map((migration) => migration.filename));
    const pending = files.filter((file) => !appliedNames.has(file.filename));

    if (pending.some((file) => bootstrapOnlyMigrations.has(file.filename))) {
      throw new Error('The one-time migration foundation is not fully registered.');
    }

    if (command === 'apply') {
      for (const migration of pending) {
        await applyMigration(client, migration);
      }
    } else if (command === 'verify' && pending.length > 0) {
      throw new Error(
        `Pending migrations remain: ${pending.map((file) => file.filename).join(', ')}.`,
      );
    }

    process.stdout.write(
      `Migrations: OK (applied=${String(applied.length + (command === 'apply' ? pending.length : 0))}, pending=${String(
        command === 'apply' ? 0 : pending.length,
      )}).\n`,
    );
  } finally {
    try {
      if (lockAcquired) {
        await client.query(`select pg_advisory_unlock(hashtextextended('dokana:migrations', 0))`);
      }
    } finally {
      client.release();
      await pool.end();
    }
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown migration failure.';
    process.stderr.write(`Migrations: FAIL (${message})\n`);
    process.exitCode = 1;
  });
}
