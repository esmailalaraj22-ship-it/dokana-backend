import type { PoolClient } from 'pg';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0034_retire_broken_recovery_session_wrapper.sql';
const wrapperSignature =
  'auth_api.issue_session_recovery_v1(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text,text)';
const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(300_000);

interface WrapperState {
  present: boolean;
  owner: string | null;
  securityDefiner: boolean | null;
  publicExecute: boolean | null;
  authExecute: boolean | null;
  runtimeExecute: boolean | null;
  dependencies: number;
}

interface StableCatalogState {
  authFunctionFingerprint: string;
  relationCount: number;
  policyCount: number;
  triggerCount: number;
}

describeWithPostgres('S23.2 broken authentication wrapper retirement', () => {
  let database: InventoryTestDatabase;
  let migration: PoolClient;

  beforeAll(async () => {
    if (!environment) throw new Error('Local PostgreSQL integration environment is unavailable.');
    database = await createInventoryTestDatabase(migrationFilename);
    migration = await database.migration.connect();
    await verifyMigrationSession(migration);
  });

  afterAll(async () => {
    await migration.query('reset role').catch(() => undefined);
    migration.release();
    await database.close();
  });

  it('fails closed on a dependency, rolls back, and then retires only the exact wrapper', async () => {
    const files = await readMigrationFiles();
    const migration0033 = files.find(
      (file) => file.filename === '0033_platform_recovery_generation_fencing.sql',
    );
    if (!migration0033) throw new Error('Migration 0033 is unavailable.');

    const before = await readWrapperState(database.admin);
    expect(before).toEqual({
      present: true,
      owner: 'shop_app_auth_owner',
      securityDefiner: true,
      publicExecute: false,
      authExecute: true,
      runtimeExecute: false,
      dependencies: 0,
    });
    const stableBefore = await readStableCatalogState(database.admin);

    await database.admin.query(`
      create view auth_api.s23_2_wrapper_dependency_probe as
      select issued.session_id
      from auth_api.issue_session_recovery_v1(
        null::uuid, null::uuid, null::uuid, null::text, null::text,
        null::uuid, null::uuid, null::uuid, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::text, null::text
      ) as issued
    `);
    await expect(applyMigration(migration, database.file)).rejects.toThrow(
      '0034 found an unexpected wrapper dependency',
    );

    const rolledBack = await readWrapperState(database.admin);
    expect(rolledBack).toMatchObject({ present: true, authExecute: true });
    const failedLedger = await database.admin.query<{ count: number }>(
      `select count(*)::integer as count
       from platform.schema_migrations where filename = $1`,
      [migrationFilename],
    );
    expect(failedLedger.rows[0]?.count).toBe(0);
    await database.admin.query(`drop view auth_api.s23_2_wrapper_dependency_probe`);

    await applyMigration(migration, database.file);

    expect(await readWrapperState(database.admin)).toEqual({
      present: false,
      owner: null,
      securityDefiner: null,
      publicExecute: null,
      authExecute: null,
      runtimeExecute: null,
      dependencies: 0,
    });
    expect(await readStableCatalogState(database.admin)).toEqual(stableBefore);

    const ledger = await database.admin.query<{
      count: number;
      latest: string;
      checksum0033: string;
      checksum0034: string;
    }>(
      `select
         count(*)::integer as count,
         max(filename) as latest,
         max(checksum_sha256) filter (where filename = $1) as "checksum0033",
         max(checksum_sha256) filter (where filename = $2) as "checksum0034"
       from platform.schema_migrations`,
      [migration0033.filename, migrationFilename],
    );
    expect(ledger.rows[0]).toEqual({
      count: 34,
      latest: migrationFilename,
      checksum0033: migration0033.checksumSha256,
      checksum0034: database.file.checksumSha256,
    });

    const authInventory = await database.admin.query<{
      functionCount: number;
      authExecutableCount: number;
      publicExecutableCount: number;
      runtimeExecutableCount: number;
      requiredRecoveryCount: number;
    }>(`
      select
        count(*)::integer as "functionCount",
        count(*) filter (
          where has_function_privilege('shop_app_auth', function_state.oid, 'EXECUTE')
        )::integer as "authExecutableCount",
        count(*) filter (
          where has_function_privilege('public', function_state.oid, 'EXECUTE')
        )::integer as "publicExecutableCount",
        count(*) filter (
          where has_function_privilege('shop_app_runtime', function_state.oid, 'EXECUTE')
        )::integer as "runtimeExecutableCount",
        count(*) filter (
          where function_state.proname in (
            'validate_session_recovery_v1',
            'rotate_refresh_token_recovery_v1',
            'validate_sync_session_recovery_v1',
            'validate_sync_refresh_token_recovery_v1'
          )
        )::integer as "requiredRecoveryCount"
      from pg_proc as function_state
      inner join pg_namespace as namespace_state
        on namespace_state.oid = function_state.pronamespace
      where namespace_state.nspname = 'auth_api'
    `);
    expect(authInventory.rows[0]).toEqual({
      functionCount: 13,
      authExecutableCount: 12,
      publicExecutableCount: 0,
      runtimeExecutableCount: 0,
      requiredRecoveryCount: 4,
    });

    const roleState = await migration.query<{ sessionUser: string; currentUser: string }>(
      `select session_user as "sessionUser", current_user as "currentUser"`,
    );
    expect(roleState.rows[0]).toEqual({
      sessionUser: 'dokana_migration_login',
      currentUser: 'shop_app_migrator',
    });
    await migration.query('reset role');
    const restored = await migration.query<{ sessionUser: string; currentUser: string }>(
      `select session_user as "sessionUser", current_user as "currentUser"`,
    );
    expect(restored.rows[0]).toEqual({
      sessionUser: 'dokana_migration_login',
      currentUser: 'dokana_migration_login',
    });
  });
});

async function readWrapperState(client: Pick<PoolClient, 'query'>): Promise<WrapperState> {
  const state = await client.query<WrapperState>(
    `with wrapper as (select to_regprocedure($1) as oid)
     select
       wrapper.oid is not null as present,
       case when wrapper.oid is null then null else pg_get_userbyid(function_state.proowner) end
         as owner,
       function_state.prosecdef as "securityDefiner",
       case when wrapper.oid is null then null
         else has_function_privilege('public', wrapper.oid, 'EXECUTE') end as "publicExecute",
       case when wrapper.oid is null then null
         else has_function_privilege('shop_app_auth', wrapper.oid, 'EXECUTE') end as "authExecute",
       case when wrapper.oid is null then null
         else has_function_privilege('shop_app_runtime', wrapper.oid, 'EXECUTE') end
         as "runtimeExecute",
       case when wrapper.oid is null then 0 else (
         select count(*)::integer
         from pg_depend as dependency
         where dependency.refclassid = 'pg_proc'::regclass
           and dependency.refobjid = wrapper.oid
           and dependency.deptype in ('n', 'a', 'e')
       ) end as dependencies
     from wrapper
     left join pg_proc as function_state on function_state.oid = wrapper.oid`,
    [wrapperSignature],
  );
  const row = state.rows[0];
  if (!row) throw new Error('Wrapper state is unavailable.');
  return row;
}

async function readStableCatalogState(
  client: Pick<PoolClient, 'query'>,
): Promise<StableCatalogState> {
  const state = await client.query<StableCatalogState>(`
    select
      (
        select md5(string_agg(
          pg_get_function_identity_arguments(function_state.oid)
          || pg_get_functiondef(function_state.oid)
          || coalesce(function_state.proacl::text, '')
          || coalesce(array_to_string(function_state.proconfig, ','), ''),
          E'\n' order by function_state.proname,
          pg_get_function_identity_arguments(function_state.oid)
        ))
        from pg_proc as function_state
        inner join pg_namespace as namespace_state
          on namespace_state.oid = function_state.pronamespace
        where namespace_state.nspname = 'auth_api'
          and function_state.proname <> 'issue_session_recovery_v1'
      ) as "authFunctionFingerprint",
      (
        select count(*)::integer
        from pg_class as relation
        inner join pg_namespace as namespace_state on namespace_state.oid = relation.relnamespace
        where namespace_state.nspname in ('audit', 'ledger', 'platform', 'sync', 'auth_api')
          and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      ) as "relationCount",
      (
        select count(*)::integer
        from pg_policy as policy
        inner join pg_class as relation on relation.oid = policy.polrelid
        inner join pg_namespace as namespace_state on namespace_state.oid = relation.relnamespace
        where namespace_state.nspname in ('audit', 'ledger', 'platform', 'sync', 'auth_api')
      ) as "policyCount",
      (
        select count(*)::integer
        from pg_trigger as trigger_state
        inner join pg_class as relation on relation.oid = trigger_state.tgrelid
        inner join pg_namespace as namespace_state on namespace_state.oid = relation.relnamespace
        where namespace_state.nspname in ('audit', 'ledger', 'platform', 'sync', 'auth_api')
          and not trigger_state.tgisinternal
      ) as "triggerCount"
  `);
  const row = state.rows[0];
  if (!row) throw new Error('Stable catalog state is unavailable.');
  return row;
}
