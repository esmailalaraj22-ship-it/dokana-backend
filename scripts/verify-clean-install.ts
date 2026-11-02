import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { config as loadEnvironment } from 'dotenv';
import { Pool } from 'pg';

import { readCatalogFingerprint } from './migrations/catalog-fingerprint';
import { readEffectiveMigrationState } from './migrations/effective-migration-state';
import { readMigrationFile, readMigrationFiles } from './migrations/migration-files';

loadEnvironment({ path: resolve(__dirname, '..', '.env') });

const disposableNamePattern = /^dokana_s234_[0-9a-f]{32}$/;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'create' && process.argv.length === 3) {
    await createCleanInstall();
    return;
  }
  if (command === 'drop' && process.argv.length === 4 && process.argv[3]) {
    await dropCleanInstall(process.argv[3]);
    return;
  }
  throw new Error('Expected clean-install command: create, or drop <database>.');
}

async function createCleanInstall(): Promise<void> {
  const urls = readUrls();
  const databaseName = `dokana_s234_${randomUUID().replaceAll('-', '')}`;
  const management = pool(withDatabase(urls.admin, 'postgres'), 'dokana-s234-management');
  let created = false;
  try {
    await assertProvisionedRoles(management);
    await management.query(`create database "${databaseName}" template template0`);
    created = true;
    await management.query(
      `grant connect on database "${databaseName}" to dokana_migration_login, dokana_auth_login`,
    );

    const adminUrl = withDatabase(urls.admin, databaseName);
    const admin = pool(adminUrl, 'dokana-s234-bootstrap');
    try {
      const empty = await admin.query<{ count: number }>(`
        select count(*)::integer as count
        from pg_namespace
        where nspname in ('audit', 'auth_api', 'ledger', 'platform', 'sync')
      `);
      if (empty.rows[0]?.count !== 0) throw new Error('Disposable database is not empty.');
      await admin.query(
        await readFile(
          resolve(
            'database/reference/backend_database_reference/shop_ledger_postgresql_v1_all_in_one.sql',
          ),
          'utf8',
        ),
      );
      await admin.query(
        (await readMigrationFile('0001_rls_context_function_privileges.sql')).contents,
      );
    } finally {
      await admin.end();
    }

    const environment = {
      ...process.env,
      DATABASE_ADMIN_URL: adminUrl,
      DATABASE_URL: withDatabase(urls.runtime, databaseName),
      TEST_DATABASE_URL: withDatabase(urls.runtime, databaseName),
      AUTH_DATABASE_URL: withDatabase(urls.auth, databaseName),
      DATABASE_MIGRATION_URL: withDatabase(urls.migration, databaseName),
    };
    await runNpm(['run', 'db:migrate:bootstrap'], environment);
    await runNpm(['run', 'db:migrate:bootstrap:auth-schema'], environment);
    await runNpm(['run', 'db:migrate'], environment);
    await runNpm(['run', 'db:migrate:verify'], environment);

    const verify = pool(adminUrl, 'dokana-s234-verify');
    try {
      const files = await readMigrationFiles();
      const state = await readEffectiveMigrationState(verify, files);
      if (state.pending.length !== 0 || state.effective.length !== files.length) {
        throw new Error('Canonical clean installation has incomplete migration state.');
      }
      const fingerprint = await readCatalogFingerprint(verify);
      process.stdout.write(
        `${JSON.stringify({ databaseName, migrationCount: state.effective.length, catalogFingerprintSha256: fingerprint.sha256 })}\n`,
      );
    } finally {
      await verify.end();
    }
  } catch (error) {
    if (created) await dropDatabase(management, databaseName).catch(() => undefined);
    throw error;
  } finally {
    await management.end();
  }
}

async function dropCleanInstall(databaseName: string): Promise<void> {
  if (!disposableNamePattern.test(databaseName))
    throw new Error('Unsafe disposable database name.');
  const management = pool(withDatabase(readUrls().admin, 'postgres'), 'dokana-s234-cleanup');
  try {
    await dropDatabase(management, databaseName);
  } finally {
    await management.end();
  }
  process.stdout.write('Clean-install database removed.\n');
}

async function dropDatabase(management: Pool, databaseName: string): Promise<void> {
  if (!disposableNamePattern.test(databaseName))
    throw new Error('Unsafe disposable database name.');
  await management.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
    [databaseName],
  );
  await management.query(`drop database if exists "${databaseName}"`);
}

async function assertProvisionedRoles(management: Pool): Promise<void> {
  const result = await management.query<{ valid: boolean }>(`
    select
      count(*) filter (where rolname in (
        'shop_app_runtime', 'shop_app_migrator', 'shop_app_readonly', 'shop_app_auth',
        'shop_app_auth_owner', 'dokana_migration_login', 'dokana_auth_login'
      )) = 7
      and bool_and(not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication
                   and not rolbypassrls) filter (where rolname in (
        'shop_app_runtime', 'shop_app_migrator', 'shop_app_readonly', 'shop_app_auth',
        'shop_app_auth_owner', 'dokana_migration_login', 'dokana_auth_login'
      )) as valid
    from pg_roles
  `);
  if (!result.rows[0]?.valid) throw new Error('Approved least-privileged roles are unavailable.');
}

function readUrls(): { admin: string; runtime: string; auth: string; migration: string } {
  const admin = requiredUrl('DATABASE_ADMIN_URL');
  const runtime = requiredUrl('DATABASE_URL');
  const auth = requiredUrl('AUTH_DATABASE_URL');
  const migration = requiredUrl('DATABASE_MIGRATION_URL');
  for (const value of [admin, runtime, auth, migration]) assertSafeLocal(value);
  return { admin, runtime, auth, migration };
}

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function assertSafeLocal(value: string): void {
  const url = new URL(value);
  if (
    process.env.APP_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    !decodeURIComponent(url.pathname.slice(1))
  ) {
    throw new Error('Clean-install verification requires approved local non-production URLs.');
  }
}

function withDatabase(connectionString: string, databaseName: string): string {
  const value = new URL(connectionString);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

function pool(connectionString: string, applicationName: string): Pool {
  return new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 120_000,
    query_timeout: 120_000,
    allowExitOnIdle: true,
  });
}

function runNpm(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(executable, arguments_, {
      cwd: resolve(__dirname, '..'),
      env: environment,
      shell: process.platform === 'win32',
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once('error', () =>
      reject(new Error('Canonical clean-install command could not start.')),
    );
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error('Canonical clean-install command failed.'));
    });
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown clean-install failure.';
  process.stderr.write(`Clean-install verification: FAIL (${message})\n`);
  process.exitCode = 1;
});
