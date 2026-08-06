import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { readMigrationFiles, sha256 } from '../scripts/migrations/migration-files';
import {
  verifyApplicationInventory,
  verifyStation2ContextFunctions,
} from '../scripts/migrations/verify-application-inventory';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

const managedRoles = [
  'dokana_auth_login',
  'dokana_migration_login',
  'shop_app_auth',
  'shop_app_auth_owner',
  'shop_app_migrator',
  'shop_app_runtime',
] as const;

interface RoleState {
  roleName: string;
  canLogin: boolean;
  inherits: boolean;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  bypassesRls: boolean;
}

describeWithPostgres('Station 3 PostgreSQL security and migrations', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let authPool: Pool;
  let migrationPool: Pool;
  let poolsInitialized = false;
  const rlsStoreIds = [randomUUID(), randomUUID()];

  async function removeInterruptedStation3Fixtures(): Promise<void> {
    await adminPool.query(`
      delete from platform.auth_sessions
      where user_id in (
        select id
        from platform.users
        where normalized_email ~ '^station3-(other-)?[0-9a-f-]{36}@example[.]test$'
      )
    `);
    await adminPool.query(`
      delete from ledger.devices
      where store_id in (
        select membership.store_id
        from platform.store_memberships as membership
        inner join platform.users as users on users.id = membership.user_id
        where users.normalized_email
          ~ '^station3-(other-)?[0-9a-f-]{36}@example[.]test$'
      )
    `);
    await adminPool.query(`
      delete from sync.change_events
      where store_id in (
        select membership.store_id
        from platform.store_memberships as membership
        inner join platform.users as users on users.id = membership.user_id
        where users.normalized_email
          ~ '^station3-(other-)?[0-9a-f-]{36}@example[.]test$'
      )
    `);
    await adminPool.query(`
      delete from platform.store_memberships
      where user_id in (
        select id
        from platform.users
        where normalized_email ~ '^station3-(other-)?[0-9a-f-]{36}@example[.]test$'
      )
    `);
    await adminPool.query(`
      delete from platform.users
      where normalized_email ~ '^station3-(other-)?[0-9a-f-]{36}@example[.]test$'
    `);
    await adminPool.query(`
      delete from ledger.stores as stores
      where stores.name in ('Station 3 Store', 'Other Station 3 Store')
        and not exists (
          select 1
          from platform.store_memberships as membership
          where membership.store_id = stores.id
        )
    `);
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The local PostgreSQL test environment is unavailable.');
    }

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-station3-security-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-station3-security-runtime', 3);
    authPool = createTestPool(environment.authUrl, 'dokana-station3-security-auth', 1);
    migrationPool = createTestPool(
      environment.migrationUrl,
      'dokana-station3-security-migration',
      3,
    );
    poolsInitialized = true;

    await removeInterruptedStation3Fixtures();
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [rlsStoreIds]);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values ($1, 'Station 3 RLS A', 'active'), ($2, 'Station 3 RLS B', 'active')
      `,
      rlsStoreIds,
    );
  });

  afterAll(async () => {
    if (!poolsInitialized) {
      return;
    }
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [rlsStoreIds]);
    await Promise.all([adminPool.end(), runtimePool.end(), authPool.end(), migrationPool.end()]);
  });

  it('enforces exact non-elevated role attributes and memberships', async () => {
    const roles = await adminPool.query<RoleState>(
      `
        select
          rolname as "roleName",
          rolcanlogin as "canLogin",
          rolinherit as inherits,
          rolsuper as "isSuperuser",
          rolcreatedb as "canCreateDatabase",
          rolcreaterole as "canCreateRole",
          rolreplication as "canReplicate",
          rolbypassrls as "bypassesRls"
        from pg_roles
        where rolname = any($1::text[])
        order by rolname
      `,
      [managedRoles],
    );
    expect(roles.rows).toHaveLength(managedRoles.length);
    for (const role of roles.rows) {
      expect(role).toMatchObject({
        isSuperuser: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canReplicate: false,
        bypassesRls: false,
      });
    }
    expect(roles.rows.filter((role) => role.canLogin).map((role) => role.roleName)).toEqual([
      'dokana_auth_login',
      'dokana_migration_login',
    ]);
    expect(roles.rows.filter((role) => role.inherits).map((role) => role.roleName)).toEqual([
      'dokana_auth_login',
    ]);

    const memberships = await adminPool.query<{
      member: string;
      grantedRole: string;
      adminOption: boolean;
      inheritOption: boolean;
      setOption: boolean;
    }>(
      `
        select
          member_role.rolname as member,
          granted_role.rolname as "grantedRole",
          membership.admin_option as "adminOption",
          membership.inherit_option as "inheritOption",
          membership.set_option as "setOption"
        from pg_auth_members as membership
        inner join pg_roles as member_role on member_role.oid = membership.member
        inner join pg_roles as granted_role on granted_role.oid = membership.roleid
        where member_role.rolname = any($1::text[])
           or granted_role.rolname = any($1::text[])
        order by member_role.rolname, granted_role.rolname
      `,
      [managedRoles],
    );
    expect(memberships.rows).toEqual([
      {
        member: 'dokana_auth_login',
        grantedRole: 'shop_app_auth',
        adminOption: false,
        inheritOption: true,
        setOption: false,
      },
      {
        member: 'dokana_migration_login',
        grantedRole: 'shop_app_migrator',
        adminOption: false,
        inheritOption: false,
        setOption: true,
      },
      {
        member: 'dokana_runtime_login',
        grantedRole: 'shop_app_runtime',
        adminOption: false,
        inheritOption: true,
        setOption: true,
      },
      {
        member: 'shop_app_migrator',
        grantedRole: 'shop_app_auth_owner',
        adminOption: false,
        inheritOption: false,
        setOption: true,
      },
    ]);
  });

  it('allows only the approved role transitions', async () => {
    const migrationClient = await migrationPool.connect();
    const authClient = await authPool.connect();
    const runtimeClient = await runtimePool.connect();

    try {
      await migrationClient.query('begin');
      await migrationClient.query('set local role shop_app_migrator');
      expect(
        (await migrationClient.query<{ role: string }>(`select current_user as role`)).rows[0]
          ?.role,
      ).toBe('shop_app_migrator');
      await migrationClient.query('set local role shop_app_auth_owner');
      expect(
        (await migrationClient.query<{ role: string }>(`select current_user as role`)).rows[0]
          ?.role,
      ).toBe('shop_app_auth_owner');
      await migrationClient.query('rollback');

      await expect(migrationClient.query('set role shop_app_auth')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(migrationClient.query('set role shop_app_runtime')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(authClient.query('set role shop_app_migrator')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(authClient.query('set role shop_app_auth_owner')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(authClient.query('set role shop_app_runtime')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(runtimeClient.query('set role shop_app_migrator')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(runtimeClient.query('set role shop_app_auth')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(runtimeClient.query('set role shop_app_auth_owner')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      migrationClient.release();
      authClient.release();
      runtimeClient.release();
    }
  });

  it('keeps auth execution function-only and runtime outside auth_api', async () => {
    await expect(authPool.query(`select id from platform.users limit 1`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      runtimePool.query(`select * from auth_api.lookup_credentials('nobody@example.test')`),
    ).rejects.toMatchObject({
      code: '42501',
    });

    const grants = await adminPool.query<{
      directExecutionTableGrant: boolean;
      runtimeAuthUsage: boolean;
      authProtectedUsage: boolean;
      authSchemaCreate: boolean;
    }>(`
      select
        (
          exists (
            select 1
            from information_schema.table_privileges
            where grantee in ('shop_app_auth', 'dokana_auth_login')
              and table_schema in ('platform', 'ledger')
              and table_name in (
                'users',
                'store_memberships',
                'auth_sessions',
                'refresh_tokens',
                'stores',
                'devices'
              )
          )
          or exists (
            select 1
            from information_schema.column_privileges
            where grantee in ('shop_app_auth', 'dokana_auth_login')
              and table_schema in ('platform', 'ledger')
              and table_name in (
                'users',
                'store_memberships',
                'auth_sessions',
                'refresh_tokens',
                'stores',
                'devices'
              )
          )
        ) as "directExecutionTableGrant",
        has_schema_privilege('shop_app_runtime', 'auth_api', 'USAGE') as "runtimeAuthUsage",
        (
          has_schema_privilege('dokana_auth_login', 'platform', 'USAGE')
          or has_schema_privilege('dokana_auth_login', 'ledger', 'USAGE')
        ) as "authProtectedUsage",
        has_schema_privilege('dokana_auth_login', 'auth_api', 'CREATE')
          as "authSchemaCreate"
    `);
    expect(grants.rows[0]).toEqual({
      directExecutionTableGrant: false,
      runtimeAuthUsage: false,
      authProtectedUsage: false,
      authSchemaCreate: false,
    });
  });

  it('pins every auth definer function and exposes only approved entry points', async () => {
    const functions = await adminPool.query<{
      signature: string;
      owner: string;
      securityDefiner: boolean;
      configuration: string[];
      publicExecute: boolean;
      authExecute: boolean;
      runtimeExecute: boolean;
    }>(`
      select
        function_state.proname || '('
          || pg_get_function_identity_arguments(function_state.oid) || ')' as signature,
        pg_get_userbyid(function_state.proowner) as owner,
        function_state.prosecdef as "securityDefiner",
        function_state.proconfig as configuration,
        exists (
          select 1
          from aclexplode(coalesce(function_state.proacl, acldefault('f', function_state.proowner)))
            as privilege
          where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        has_function_privilege('shop_app_auth', function_state.oid, 'EXECUTE')
          as "authExecute",
        has_function_privilege('shop_app_runtime', function_state.oid, 'EXECUTE')
          as "runtimeExecute"
      from pg_proc as function_state
      inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
      where namespace.nspname = 'auth_api'
      order by signature
    `);

    expect(functions.rows).toHaveLength(7);
    for (const functionState of functions.rows) {
      expect(functionState.owner).toBe('shop_app_auth_owner');
      expect(functionState.securityDefiner).toBe(true);
      expect(functionState.publicExecute).toBe(false);
      expect(functionState.runtimeExecute).toBe(false);
      expect(functionState.configuration).toHaveLength(1);
      expect(functionState.configuration[0]).toMatch(
        /^search_path=pg_catalog, auth_api,(?: platform,)?(?: ledger,)? pg_temp$/,
      );
    }

    const executableSignatures = functions.rows
      .filter((functionState) => functionState.authExecute)
      .map((functionState) => functionState.signature);
    expect(executableSignatures).toHaveLength(6);
    expect(executableSignatures).not.toContain(
      'rotate_refresh_token(p_current_token_hash text, p_new_token_id uuid, p_new_token_hash text, p_new_access_token_jti uuid, p_new_refresh_expires_at timestamp with time zone)',
    );
  });

  it('limits auth-owner ownership and direct privileges to approved auth objects', async () => {
    const ownership = await adminPool.query<{
      authSchemaOwner: string;
      unexpectedRelationCount: number;
      unexpectedFunctionCount: number;
      migratorSchemaCount: number;
    }>(`
      select
        (
          select pg_get_userbyid(nspowner)
          from pg_namespace
          where nspname = 'auth_api'
        ) as "authSchemaOwner",
        (
          select count(*)::integer
          from pg_class
          where relowner = (select oid from pg_roles where rolname = 'shop_app_auth_owner')
        ) as "unexpectedRelationCount",
        (
          select count(*)::integer
          from pg_proc as function_state
          inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
          where function_state.proowner = (
            select oid from pg_roles where rolname = 'shop_app_auth_owner'
          )
            and namespace.nspname <> 'auth_api'
        ) as "unexpectedFunctionCount",
        (
          select count(*)::integer
          from pg_namespace
          where nspname in ('platform', 'ledger', 'sync', 'audit')
            and nspowner = (select oid from pg_roles where rolname = 'shop_app_migrator')
        ) as "migratorSchemaCount"
    `);
    expect(ownership.rows[0]).toEqual({
      authSchemaOwner: 'shop_app_auth_owner',
      unexpectedRelationCount: 0,
      unexpectedFunctionCount: 0,
      migratorSchemaCount: 4,
    });

    const prohibitedPrivileges = await adminPool.query<{ count: number }>(`
      select count(*)::integer as count
      from information_schema.column_privileges
      where grantee = 'shop_app_auth_owner'
        and (
          table_schema not in ('platform', 'ledger')
          or table_name not in (
            'users', 'store_memberships', 'auth_sessions', 'refresh_tokens', 'stores', 'devices'
          )
          or privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
        )
    `);
    expect(prohibitedPrivileges.rows[0]?.count).toBe(0);
  });

  it('keeps the auth RLS additions narrow without weakening baseline policies', async () => {
    const policies = await adminPool.query<{
      schemaName: string;
      tableName: string;
      policyName: string;
      permissive: string;
      command: string;
      roles: string[];
    }>(`
      select
        schemaname as "schemaName",
        tablename as "tableName",
        policyname as "policyName",
        permissive,
        cmd as command,
        roles
      from pg_policies
      where policyname like 'auth_%'
      order by policyname
    `);
    expect(policies.rows.map((policy) => policy.policyName)).toEqual([
      'auth_device_membership_restrictive',
      'auth_membership_self_permissive',
      'auth_membership_self_restrictive',
      'auth_store_membership_permissive',
      'auth_store_membership_restrictive',
    ]);
    expect(policies.rows.every((policy) => policy.roles.includes('shop_app_auth_owner'))).toBe(
      true,
    );
    expect(
      policies.rows
        .filter((policy) => policy.policyName.endsWith('restrictive'))
        .every((policy) => policy.permissive === 'RESTRICTIVE'),
    ).toBe(true);

    const baselineRls = await adminPool.query<{
      tableName: string;
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      tenantPolicy: boolean;
    }>(`
      select
        relation.relname as "tableName",
        relation.relrowsecurity as "rowSecurity",
        relation.relforcerowsecurity as "forceRowSecurity",
        exists (
          select 1
          from pg_policy
          where polrelid = relation.oid and polname like 'tenant_isolation_%'
        ) as "tenantPolicy"
      from pg_class as relation
      where relation.oid = any(array[
        'ledger.stores'::regclass,
        'ledger.devices'::regclass,
        'platform.store_memberships'::regclass
      ])
      order by relation.relname
    `);
    expect(
      baselineRls.rows.every(
        (table) => table.rowSecurity && table.forceRowSecurity && table.tenantPolicy,
      ),
    ).toBe(true);
  });

  it('fails closed without context and blocks cross-tenant runtime reads and writes', async () => {
    const missingContext = await runtimePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.stores where id = any($1::uuid[])`,
      [rlsStoreIds],
    );
    expect(missingContext.rows[0]?.count).toBe(0);
    await expect(
      runtimePool.query(`insert into ledger.stores (id, name) values ($1, 'Blocked')`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.store_id', $1, true)`, [rlsStoreIds[0]]);
      const visible = await client.query<{ id: string }>(
        `select id from ledger.stores where id = any($1::uuid[]) order by id`,
        [rlsStoreIds],
      );
      expect(visible.rows.map((row) => row.id)).toEqual([rlsStoreIds[0]]);

      await expect(
        client.query(`insert into ledger.stores (id, name) values ($1, 'Cross tenant')`, [
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('keeps tenant context transaction-local across commit, rollback, errors, and pool reuse', async () => {
    const client = await runtimePool.connect();
    const storeId = rlsStoreIds[0] ?? randomUUID();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.store_id', $1, true)`, [storeId]);
      await client.query('commit');
      let setting = await client.query<{ value: string | null }>(
        `select nullif(current_setting('app.store_id', true), '') as value`,
      );
      expect(setting.rows[0]?.value).toBeNull();

      await client.query('begin');
      await client.query(`select set_config('app.store_id', $1, true)`, [storeId]);
      await client.query('rollback');
      setting = await client.query<{ value: string | null }>(
        `select nullif(current_setting('app.store_id', true), '') as value`,
      );
      expect(setting.rows[0]?.value).toBeNull();

      await client.query('begin');
      await client.query(`select set_config('app.store_id', $1, true)`, [storeId]);
      await expect(client.query('select 1 / 0')).rejects.toMatchObject({ code: '22012' });
      await client.query('rollback');
    } finally {
      client.release();
    }

    const reused = await runtimePool.query<{ value: string | null }>(
      `select nullif(current_setting('app.store_id', true), '') as value`,
    );
    expect(reused.rows[0]?.value).toBeNull();

    const [left, right] = await Promise.all([runtimePool.connect(), runtimePool.connect()]);
    try {
      await Promise.all([left.query('begin'), right.query('begin')]);
      await Promise.all([
        left.query(`select set_config('app.store_id', $1, true)`, [rlsStoreIds[0]]),
        right.query(`select set_config('app.store_id', $1, true)`, [rlsStoreIds[1]]),
      ]);
      const contexts = await Promise.all([
        left.query<{ value: string }>(`select current_setting('app.store_id') as value`),
        right.query<{ value: string }>(`select current_setting('app.store_id') as value`),
      ]);
      expect(contexts.map((result) => result.rows[0]?.value)).toEqual(rlsStoreIds);
      await Promise.all([left.query('rollback'), right.query('rollback')]);
    } finally {
      left.release();
      right.release();
    }
  });

  it('rolls back tenant writes and leaves no fixture row', async () => {
    const rolledBackStoreId = randomUUID();
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.store_id', $1, true)`, [rolledBackStoreId]);
      await client.query(
        `insert into ledger.stores (id, name) values ($1, 'Rolled back Station 3 store')`,
        [rolledBackStoreId],
      );
      await client.query('rollback');
    } finally {
      client.release();
    }

    const persisted = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.stores where id = $1`,
      [rolledBackStoreId],
    );
    expect(persisted.rows[0]?.count).toBe(0);
  });

  it('verifies migration checksums, ownership, 0001 registration, and live effects', async () => {
    const files = await readMigrationFiles();
    const ledger = await adminPool.query<{
      filename: string;
      checksumSha256: string;
      metadata: Record<string, unknown>;
    }>(`
      select filename, checksum_sha256 as "checksumSha256", metadata
      from platform.schema_migrations
      order by filename
    `);
    expect(ledger.rows).toHaveLength(files.length);
    expect(ledger.rows.map((row) => row.filename)).toEqual(files.map((file) => file.filename));
    for (const file of files) {
      expect(ledger.rows.find((row) => row.filename === file.filename)?.checksumSha256).toBe(
        file.checksumSha256,
      );
    }
    expect(ledger.rows[0]?.metadata).toMatchObject({
      registration: 'verified_preexisting',
      replayed: false,
    });

    const adminClient = await adminPool.connect();
    try {
      await verifyApplicationInventory(adminClient, 'shop_app_migrator', true);
      await verifyStation2ContextFunctions(adminClient, 'shop_app_migrator');
    } finally {
      adminClient.release();
    }
  });

  it('rejects wrong migration identities and rolls back a failed migration without recording it', async () => {
    const runtimeClient = await runtimePool.connect();
    const authClient = await authPool.connect();
    const adminClient = await adminPool.connect();
    const migrationClient = await migrationPool.connect();
    const failedFilename = '9999_station3_failed_test.sql';

    try {
      await expect(verifyMigrationSession(runtimeClient)).rejects.toThrow(
        'approved limited migration login',
      );
      await expect(verifyMigrationSession(authClient)).rejects.toThrow(
        'approved limited migration login',
      );
      await expect(verifyMigrationSession(adminClient)).rejects.toThrow(
        'approved limited migration login',
      );

      await verifyMigrationSession(migrationClient);
      await expect(
        applyMigration(migrationClient, {
          filename: failedFilename,
          absolutePath: 'integration-test-only',
          contents:
            'create table platform.station3_failed_migration_test (id integer); select 1 / 0;',
          checksumSha256: sha256('intentional failure'),
        }),
      ).rejects.toMatchObject({ code: '22012' });

      const state = await migrationClient.query<{
        ledgerCount: number;
        relationName: string | null;
      }>(
        `
          select
            (
              select count(*)::integer
              from platform.schema_migrations
              where filename = $1
            ) as "ledgerCount",
            to_regclass('platform.station3_failed_migration_test')::text as "relationName"
        `,
        [failedFilename],
      );
      expect(state.rows[0]).toEqual({
        ledgerCount: 0,
        relationName: null,
      });
    } finally {
      await migrationClient.query('reset role');
      runtimeClient.release();
      authClient.release();
      adminClient.release();
      migrationClient.release();
    }
  });

  it('prevents concurrent migration runners with the advisory lock', async () => {
    const first = await migrationPool.connect();
    const second = await migrationPool.connect();

    try {
      await Promise.all([first.query('reset role'), second.query('reset role')]);
      await verifyMigrationSession(first);
      await verifyMigrationSession(second);
      const acquired = await first.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(hashtextextended('dokana:migrations', 0)) as acquired`,
      );
      const blocked = await second.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(hashtextextended('dokana:migrations', 0)) as acquired`,
      );
      expect(acquired.rows[0]?.acquired).toBe(true);
      expect(blocked.rows[0]?.acquired).toBe(false);
    } finally {
      await first.query(`select pg_advisory_unlock(hashtextextended('dokana:migrations', 0))`);
      await Promise.all([first.query('reset role'), second.query('reset role')]);
      first.release();
      second.release();
    }
  });

  it('leaves no Station 3 test identities, sessions, devices, or failed migration objects', async () => {
    const artifacts = await adminPool.query<{
      users: number;
      sessions: number;
      devices: number;
      failedMigrationObjects: number;
    }>(`
      select
        (
          select count(*)::integer
          from platform.users
          where normalized_email like 'station3-%@example.test'
        ) as users,
        (
          select count(*)::integer
          from platform.auth_sessions as sessions
          inner join platform.users as users on users.id = sessions.user_id
          where users.normalized_email like 'station3-%@example.test'
        ) as sessions,
        (
          select count(*)::integer
          from ledger.devices
          where device_name like 'Station 3 test%'
        ) as devices,
        (
          select count(*)::integer
          from pg_class as relation
          inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'platform'
            and relation.relname = 'station3_failed_migration_test'
        ) as "failedMigrationObjects"
    `);
    expect(artifacts.rows[0]).toEqual({
      users: 0,
      sessions: 0,
      devices: 0,
      failedMigrationObjects: 0,
    });
  });
});
