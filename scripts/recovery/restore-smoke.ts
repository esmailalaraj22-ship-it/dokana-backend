import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import type { VerifiedRecoveryManifest } from '../../src/recovery/recovery-manifest';
import { restoreCustomFormatDump, type PostgresToolchain } from './postgres-tools';

export interface RestoreSmokeResult {
  databaseName: string;
  schemas: string[];
  migrationCount: number;
  latestMigration: string;
  forcedRlsTables: number;
  policies: number;
  securityDefinerFunctions: number;
  triggers: number;
}

export async function runIsolatedRestoreSmoke(input: {
  adminConnectionString: string;
  artifactPath: string;
  manifest: VerifiedRecoveryManifest;
  toolchain: PostgresToolchain;
  expectedRepresentativeCounts?: Record<string, string>;
}): Promise<RestoreSmokeResult> {
  assertSafeLocalAdminConnection(input.adminConnectionString);
  const databaseName = `dokana_recovery_smoke_${randomUUID().replaceAll('-', '')}`;
  const adminPool = pool(input.adminConnectionString, 'dokana_recovery_smoke_admin');
  let created = false;
  try {
    await adminPool.query(`create database "${databaseName}"`);
    created = true;
    const targetUrl = withDatabase(input.adminConnectionString, databaseName);
    await restoreCustomFormatDump(input.toolchain, targetUrl, input.artifactPath);
    const targetPool = pool(targetUrl, 'dokana_recovery_smoke_verify');
    try {
      const [schemas, migrations, security, essential, restoredCounts] = await Promise.all([
        targetPool.query<{ schemaName: string }>(
          `
          select schema_name as "schemaName"
          from information_schema.schemata
          where schema_name = any($1::text[])
          order by schema_name
        `,
          [['audit', 'ledger', 'platform', 'sync']],
        ),
        targetPool.query<{ count: number; latest: string | null }>(`
          select count(*)::integer as count, max(filename) as latest
          from platform.schema_migrations
        `),
        targetPool.query<{
          forcedRlsTables: number;
          policies: number;
          securityDefinerFunctions: number;
          triggers: number;
        }>(
          `
          select
            (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname=any($1::text[]) and c.relkind='r' and c.relforcerowsecurity) as "forcedRlsTables",
            (select count(*)::integer from pg_policies where schemaname=any($1::text[])) as policies,
            (select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname=any($1::text[]) and p.prosecdef) as "securityDefinerFunctions",
            (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid
             join pg_namespace n on n.oid=c.relnamespace
             where n.nspname=any($1::text[]) and not t.tgisinternal) as triggers
        `,
          [['audit', 'ledger', 'platform', 'sync']],
        ),
        targetPool.query<{ count: number }>(
          `
          select count(*)::integer as count
          from information_schema.tables
          where table_schema=any($1::text[])
            and table_name=any($2::text[])
        `,
          [
            ['audit', 'ledger', 'platform', 'sync'],
            [
              'central_audit_logs',
              'stores',
              'devices',
              'store_memberships',
              'schema_migrations',
              'processed_operations',
              'change_events',
              'notifications',
              'attachments',
              'subscriptions',
              'license_issuances',
            ],
          ],
        ),
        readRepresentativeRecoveryCounts(targetPool),
      ]);
      const schemaNames = schemas.rows.map((row) => row.schemaName);
      const migration = migrations.rows[0];
      const securityState = security.rows[0];
      if (schemaNames.join(',') !== 'audit,ledger,platform,sync') {
        throw new Error('Isolated restore is missing a required Dokana schema.');
      }
      if (
        migration?.count !== input.manifest.migrations.appliedCount ||
        migration.latest !== input.manifest.migrations.latestFilename
      ) {
        throw new Error('Isolated restore migration identity does not match the manifest.');
      }
      if (essential.rows[0]?.count !== 11) {
        throw new Error('Isolated restore is missing required platform data structures.');
      }
      if (
        input.expectedRepresentativeCounts &&
        JSON.stringify(restoredCounts) !== JSON.stringify(input.expectedRepresentativeCounts)
      ) {
        throw new Error('Isolated restore representative data does not match the source snapshot.');
      }
      if (!securityState || securityState.forcedRlsTables <= 0 || securityState.policies <= 0) {
        throw new Error('Isolated restore is missing required RLS protection.');
      }
      if (securityState.securityDefinerFunctions <= 0 || securityState.triggers <= 0) {
        throw new Error('Isolated restore is missing required database execution authority.');
      }
      return {
        databaseName,
        schemas: schemaNames,
        migrationCount: migration.count,
        latestMigration: migration.latest,
        ...securityState,
      };
    } finally {
      await targetPool.end();
    }
  } finally {
    if (created) {
      await adminPool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
        [databaseName],
      );
      await adminPool.query(`drop database if exists "${databaseName}"`);
    }
    await adminPool.end();
  }
}

function assertSafeLocalAdminConnection(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (
    process.env.APP_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname) ||
    !decodeURIComponent(parsed.pathname.slice(1))
  ) {
    throw new Error('Restore-smoke requires an approved local non-production PostgreSQL target.');
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
    statement_timeout: 60_000,
    query_timeout: 60_000,
    allowExitOnIdle: true,
  });
}

export async function readRepresentativeRecoveryCounts(
  pool: Pool,
): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(`
    select
      (select count(*)::text from platform.schema_migrations) as migrations,
      (select count(*)::text from platform.store_memberships) as memberships,
      (select count(*)::text from platform.subscriptions) as subscriptions,
      (select count(*)::text from platform.license_issuances) as licenses,
      (select count(*)::text from ledger.stores) as stores,
      (select count(*)::text from ledger.devices) as devices,
      (select count(*)::text from ledger.notifications) as notifications,
      (select count(*)::text from ledger.attachments) as attachments,
      (select count(*)::text from sync.processed_operations) as operations,
      (select count(*)::text from sync.store_change_events_v1) as changes,
      (select count(*)::text from audit.central_audit_logs) as audit
  `);
  const counts = result.rows[0];
  if (!counts) throw new Error('Representative recovery data counts are unavailable.');
  return counts;
}
