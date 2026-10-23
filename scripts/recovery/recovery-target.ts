import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import { readRepresentativeRecoveryCounts } from './restore-smoke';

export interface RecoveryControlState {
  recoveryGenerationId: string;
  serviceState: 'ACTIVE' | 'FENCED';
  authorityNotBefore: string | null;
  fencedAt: string | null;
  updatedAt: string;
}

export interface RecoveryTargetVerification {
  schemas: string[];
  migrationCount: number;
  latestMigration: string;
  foreignKeys: number;
  uniqueConstraints: number;
  checkConstraints: number;
  correctnessIndexes: number;
  forcedRlsTables: number;
  unsafeStoreOwnedRlsTables: number;
  policies: number;
  securityDefinerFunctions: number;
  triggers: number;
  disabledUserTriggers: number;
  representativeCounts: Record<string, string>;
  auditMissingDeviceReferenceCount: number;
  serverTime: string;
}

export async function readRecoveryControl(connectionString: string): Promise<RecoveryControlState> {
  const result = await runRecoveryOperatorQuery<RecoveryControlState>(
    connectionString,
    'dokana_recovery_control_read',
    `
      select
        recovery_generation_id::text as "recoveryGenerationId",
        service_state as "serviceState",
        authority_not_before::text as "authorityNotBefore",
        fenced_at::text as "fencedAt",
        updated_at::text as "updatedAt"
      from platform.read_platform_recovery_control_v1()
    `,
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row) {
    throw new Error('Platform recovery authority is unavailable.');
  }
  return row;
}

export async function fenceRecoveryControl(
  connectionString: string,
  expectedGenerationId: string,
): Promise<RecoveryControlState> {
  const result = await runRecoveryOperatorQuery<RecoveryControlState>(
    connectionString,
    'dokana_recovery_control_fence',
    `
      select
        recovery_generation_id::text as "recoveryGenerationId",
        service_state as "serviceState",
        authority_not_before::text as "authorityNotBefore",
        fenced_at::text as "fencedAt",
        updated_at::text as "updatedAt"
      from platform.fence_platform_recovery_v1($1::uuid)
    `,
    [expectedGenerationId],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row?.serviceState !== 'FENCED' || !row.fencedAt) {
    throw new Error('Platform recovery fence did not commit.');
  }
  return row;
}

export async function activateRecoveryControl(
  connectionString: string,
  expectedGenerationId: string,
): Promise<RecoveryControlState> {
  const result = await runRecoveryOperatorQuery<RecoveryControlState>(
    connectionString,
    'dokana_recovery_control_activate',
    `
      select
        recovery_generation_id::text as "recoveryGenerationId",
        service_state as "serviceState",
        authority_not_before::text as "authorityNotBefore",
        fenced_at::text as "fencedAt",
        updated_at::text as "updatedAt"
      from platform.activate_new_recovery_generation_v1($1::uuid)
    `,
    [expectedGenerationId],
  );
  const row = result.rows[0];
  if (
    result.rowCount !== 1 ||
    row?.serviceState !== 'ACTIVE' ||
    !row.authorityNotBefore ||
    row.recoveryGenerationId === expectedGenerationId
  ) {
    throw new Error('Platform recovery activation did not commit safely.');
  }
  return row;
}

export async function verifyRecoveryTargetDatabase(input: {
  adminConnectionString: string;
  runtimeConnectionString: string;
  expectedMigrationCount: number;
  expectedLatestMigration: string;
  expectedRecoveryGenerationId: string;
}): Promise<RecoveryTargetVerification> {
  const admin = recoveryPool(input.adminConnectionString, 'dokana_recovery_target_verify');
  const runtime = recoveryPool(input.runtimeConnectionString, 'dokana_recovery_target_runtime');
  try {
    const [schemas, migrations, constraints, security, authority, serverTime, auditGap] =
      await Promise.all([
        admin.query<{ schemaName: string }>(
          `
          select schema_name as "schemaName"
          from information_schema.schemata
          where schema_name = any($1::text[])
          order by schema_name
        `,
          [['audit', 'ledger', 'platform', 'sync']],
        ),
        admin.query<{ count: number; latest: string | null }>(`
          select count(*)::integer as count, max(filename) as latest
          from platform.schema_migrations
        `),
        admin.query<{
          foreignKeys: number;
          uniqueConstraints: number;
          checkConstraints: number;
          correctnessIndexes: number;
        }>(
          `
          select
            count(*) filter (where constraint_type='FOREIGN KEY')::integer as "foreignKeys",
            count(*) filter (where constraint_type='UNIQUE')::integer as "uniqueConstraints",
            count(*) filter (where constraint_type='CHECK')::integer as "checkConstraints",
            (select count(*)::integer from pg_indexes
             where schemaname=any($1::text[])) as "correctnessIndexes"
          from information_schema.table_constraints
          where constraint_schema=any($1::text[])
        `,
          [['audit', 'ledger', 'platform', 'sync']],
        ),
        admin.query<{
          forcedRlsTables: number;
          unsafeStoreOwnedRlsTables: number;
          policies: number;
          securityDefinerFunctions: number;
          triggers: number;
          disabledUserTriggers: number;
        }>(
          `
          select
            (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname=any($1::text[]) and c.relkind='r' and c.relforcerowsecurity)
              as "forcedRlsTables",
            (select count(distinct c.oid)::integer
             from pg_class c
             join pg_namespace n on n.oid=c.relnamespace
             join pg_attribute a on a.attrelid=c.oid
               and a.attname='store_id' and not a.attisdropped
             where n.nspname=any($1::text[])
               and c.relkind='r'
               and (not c.relrowsecurity or not c.relforcerowsecurity)
               and not (
                 n.nspname='platform'
                 and c.relname in ('admin_actions', 'auth_sessions')
               )) as "unsafeStoreOwnedRlsTables",
            (select count(*)::integer from pg_policies where schemaname=any($1::text[])) as policies,
            (select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname=any($1::text[]) and p.prosecdef) as "securityDefinerFunctions",
            (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid
             join pg_namespace n on n.oid=c.relnamespace
             where n.nspname=any($1::text[]) and not t.tgisinternal) as triggers,
            (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid
             join pg_namespace n on n.oid=c.relnamespace
             where n.nspname=any($1::text[]) and not t.tgisinternal and t.tgenabled='D')
              as "disabledUserTriggers"
        `,
          [['audit', 'ledger', 'platform', 'sync']],
        ),
        admin.query<{ count: number; generation: string; state: string }>(`
          select count(*)::integer as count,
                 min(recovery_generation_id::text) as generation,
                 min(service_state) as state
          from platform.recovery_control
        `),
        admin.query<{ serverTime: string }>(`select clock_timestamp()::text as "serverTime"`),
        admin.query<{ count: number }>(`
          select count(*)::integer as count
          from audit.central_audit_logs AS event
          left join ledger.devices AS device
            on device.store_id=event.store_id and device.id=event.device_id
          where event.device_id is not null and device.id is null
        `),
      ]);

    const schemaNames = schemas.rows.map((row) => row.schemaName);
    const migration = migrations.rows[0];
    const constraintState = constraints.rows[0];
    const securityState = security.rows[0];
    const authorityState = authority.rows[0];
    const currentTime = serverTime.rows[0]?.serverTime;
    if (schemaNames.join(',') !== 'audit,ledger,platform,sync') {
      throw new Error('Recovery target is missing a required schema.');
    }
    if (
      migration?.count !== input.expectedMigrationCount ||
      migration.latest !== input.expectedLatestMigration
    ) {
      throw new Error('Recovery target migration identity is invalid.');
    }
    if (
      !constraintState ||
      constraintState.foreignKeys <= 0 ||
      constraintState.uniqueConstraints <= 0 ||
      constraintState.checkConstraints <= 0 ||
      constraintState.correctnessIndexes <= 0
    ) {
      throw new Error('Recovery target constraints or indexes are incomplete.');
    }
    if (
      !securityState ||
      securityState.forcedRlsTables <= 0 ||
      securityState.unsafeStoreOwnedRlsTables !== 0 ||
      securityState.policies <= 0 ||
      securityState.securityDefinerFunctions <= 0 ||
      securityState.triggers <= 0 ||
      securityState.disabledUserTriggers !== 0
    ) {
      throw new Error('Recovery target security objects are incomplete.');
    }
    if (
      authorityState?.count !== 1 ||
      authorityState.state !== 'FENCED' ||
      authorityState.generation !== input.expectedRecoveryGenerationId
    ) {
      throw new Error('Recovery target authority is not safely fenced.');
    }
    if (!currentTime || Math.abs(Date.now() - new Date(currentTime).getTime()) > 60_000) {
      throw new Error('Recovery target trusted server time is invalid.');
    }

    const runtimePrivileges = await runtime.query<{
      recoverySelect: boolean;
      auditSelect: boolean;
      recoveryTransition: boolean;
    }>(`
      select
        has_table_privilege(current_user, recovery_table.oid, 'SELECT') as "recoverySelect",
        has_table_privilege(current_user, audit_table.oid, 'SELECT') as "auditSelect",
        has_function_privilege(current_user, transition.oid, 'EXECUTE') as "recoveryTransition"
      from pg_class AS recovery_table
      join pg_namespace AS recovery_schema on recovery_schema.oid=recovery_table.relnamespace
      cross join pg_class AS audit_table
      join pg_namespace AS audit_schema on audit_schema.oid=audit_table.relnamespace
      cross join pg_proc AS transition
      join pg_namespace AS transition_schema on transition_schema.oid=transition.pronamespace
      where recovery_schema.nspname='platform'
        and recovery_table.relname='recovery_control'
        and audit_schema.nspname='audit'
        and audit_table.relname='central_audit_logs'
        and transition_schema.nspname='platform'
        and transition.proname='fence_platform_recovery_v1'
    `);
    const privileges = runtimePrivileges.rows[0];
    if (
      !privileges ||
      privileges.recoverySelect ||
      privileges.auditSelect ||
      privileges.recoveryTransition
    ) {
      throw new Error('Recovery target runtime privileges are unsafe.');
    }

    return {
      schemas: schemaNames,
      migrationCount: migration.count,
      latestMigration: migration.latest,
      ...constraintState,
      ...securityState,
      representativeCounts: await readRepresentativeRecoveryCounts(admin),
      auditMissingDeviceReferenceCount: auditGap.rows[0]?.count ?? 0,
      serverTime: currentTime,
    };
  } finally {
    await Promise.all([admin.end(), runtime.end()]);
  }
}

export function withDatabase(connectionString: string, databaseName: string): string {
  const value = new URL(connectionString);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

export function databaseName(connectionString: string): string {
  const value = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!value) throw new Error('Recovery database name is missing.');
  return value;
}

export function recoveryPool(
  connectionString: string,
  applicationName: string,
  statementTimeout = 60_000,
): Pool {
  return new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
    allowExitOnIdle: true,
  });
}

async function runRecoveryOperatorQuery<T extends QueryResultRow>(
  connectionString: string,
  applicationName: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const pool = recoveryPool(connectionString, applicationName);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role shop_app_migrator');
    const result = await client.query<T>(text, [...values]);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
