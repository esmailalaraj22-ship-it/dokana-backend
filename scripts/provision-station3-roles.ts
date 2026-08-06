import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { parse } from 'dotenv';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

const managedRoleNames = [
  'shop_app_migrator',
  'shop_app_auth',
  'shop_app_auth_owner',
  'dokana_migration_login',
  'dokana_auth_login',
] as const;

type ManagedRoleName = (typeof managedRoleNames)[number];

interface RoleState {
  rolname: ManagedRoleName;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

interface MembershipState {
  member: ManagedRoleName;
  grantedRole: ManagedRoleName;
  adminOption: boolean;
  inheritOption: boolean;
  setOption: boolean;
}

const expectedRoleStates: Record<
  ManagedRoleName,
  Pick<
    RoleState,
    | 'rolcanlogin'
    | 'rolinherit'
    | 'rolsuper'
    | 'rolcreatedb'
    | 'rolcreaterole'
    | 'rolreplication'
    | 'rolbypassrls'
  >
> = {
  shop_app_migrator: restrictedRole(false, false),
  shop_app_auth: restrictedRole(false, false),
  shop_app_auth_owner: restrictedRole(false, false),
  dokana_migration_login: restrictedRole(true, false),
  dokana_auth_login: restrictedRole(true, true),
};

const expectedMemberships: MembershipState[] = [
  {
    member: 'dokana_migration_login',
    grantedRole: 'shop_app_migrator',
    adminOption: false,
    inheritOption: false,
    setOption: true,
  },
  {
    member: 'dokana_auth_login',
    grantedRole: 'shop_app_auth',
    adminOption: false,
    inheritOption: true,
    setOption: false,
  },
  {
    member: 'shop_app_migrator',
    grantedRole: 'shop_app_auth_owner',
    adminOption: false,
    inheritOption: false,
    setOption: true,
  },
];

function restrictedRole(rolcanlogin: boolean, rolinherit: boolean): Omit<RoleState, 'rolname'> {
  return {
    rolcanlogin,
    rolinherit,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  };
}

function assertStrongPassword(
  password: string | undefined,
  label: string,
): asserts password is string {
  if (!password || password.length < 20 || password.includes('\0')) {
    throw new Error(`${label} does not meet the local provisioning requirements.`);
  }
}

function assertExistingRolesSafe(rows: RoleState[]): void {
  for (const row of rows) {
    const expected = expectedRoleStates[row.rolname];

    for (const [property, expectedValue] of Object.entries(expected)) {
      if (row[property as keyof RoleState] !== expectedValue) {
        throw new Error(`Existing role ${row.rolname} has unexpected attributes.`);
      }
    }
  }
}

function membershipKey(membership: Pick<MembershipState, 'member' | 'grantedRole'>): string {
  return `${membership.member}->${membership.grantedRole}`;
}

function assertMembershipsAllowed(rows: MembershipState[]): void {
  const allowed = new Set(expectedMemberships.map(membershipKey));

  for (const row of rows) {
    if (!allowed.has(membershipKey(row))) {
      throw new Error('An unexpected managed-role membership already exists.');
    }
  }
}

function assertMembershipsExact(rows: MembershipState[]): void {
  if (rows.length !== expectedMemberships.length) {
    throw new Error('The managed-role membership count is unexpected.');
  }

  const actual = new Map(rows.map((row) => [membershipKey(row), row]));

  for (const expected of expectedMemberships) {
    const row = actual.get(membershipKey(expected));
    if (!row) {
      throw new Error('A managed-role membership is missing.');
    }

    if (
      row.adminOption !== expected.adminOption ||
      row.inheritOption !== expected.inheritOption ||
      row.setOption !== expected.setOption
    ) {
      throw new Error('A managed-role membership has unexpected options.');
    }
  }
}

function replaceEnvironmentVariable(contents: string, name: string, value: string): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = contents.endsWith('\n');
  const lines = contents.split(/\r?\n/);
  if (hasTrailingNewline) {
    lines.pop();
  }

  const matcher = new RegExp(`^(?:export\\s+)?${name}\\s*=`);
  const matchingIndexes = lines.flatMap((line, index) => (matcher.test(line) ? [index] : []));

  if (matchingIndexes.length > 1) {
    throw new Error(`The local environment contains duplicate ${name} entries.`);
  }

  const replacement = `${name}=${value}`;
  const existingIndex = matchingIndexes[0];
  if (existingIndex === undefined) {
    lines.push(replacement);
  } else {
    lines[existingIndex] = replacement;
  }

  return `${lines.join(newline)}${hasTrailingNewline ? newline : ''}`;
}

function buildLimitedConnectionUrl(
  administrativeUrl: string,
  roleName: string,
  password: string,
): string {
  const url = new URL(administrativeUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The administrative connection is not a PostgreSQL URL.');
  }

  url.username = roleName;
  url.password = password;
  return url.toString();
}

async function readManagedRoles(client: PoolClient): Promise<RoleState[]> {
  const result = await client.query<RoleState>(
    `
      select
        rolname,
        rolcanlogin,
        rolinherit,
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolreplication,
        rolbypassrls
      from pg_roles
      where rolname = any($1::text[])
      order by rolname
    `,
    [managedRoleNames],
  );

  return result.rows;
}

async function readManagedMemberships(client: PoolClient): Promise<MembershipState[]> {
  const result = await client.query<MembershipState>(
    `
      select
        member_role.rolname as "member",
        granted_role.rolname as "grantedRole",
        membership.admin_option as "adminOption",
        membership.inherit_option as "inheritOption",
        membership.set_option as "setOption"
      from pg_auth_members as membership
      inner join pg_roles as member_role on member_role.oid = membership.member
      inner join pg_roles as granted_role on granted_role.oid = membership.roleid
      where
        member_role.rolname = any($1::text[])
        or granted_role.rolname = any($1::text[])
      order by member_role.rolname, granted_role.rolname
    `,
    [managedRoleNames],
  );

  return result.rows;
}

async function verifyAdministrativeSession(client: PoolClient): Promise<void> {
  const result = await client.query<{
    currentUser: string;
    isSuperuser: boolean;
  }>(`
    select
      current_user as "currentUser",
      role_state.rolsuper as "isSuperuser"
    from pg_roles as role_state
    where role_state.rolname = current_user
  `);
  const state = result.rows[0];

  if (!state) {
    throw new Error('The approved local administrative session is unavailable.');
  }
  if (state.currentUser !== 'postgres' || !state.isSuperuser) {
    throw new Error('The approved local administrative session is unavailable.');
  }
}

async function verifyManagedOwnership(client: PoolClient): Promise<void> {
  const result = await client.query<{ owner: string; objectType: string; objectName: string }>(`
    with owned_objects as (
      select
        owner_role.rolname as owner,
        'schema'::text as object_type,
        namespace.nspname as object_name
      from pg_namespace as namespace
      inner join pg_roles as owner_role on owner_role.oid = namespace.nspowner
      where owner_role.rolname in (
        'dokana_migration_login',
        'dokana_auth_login',
        'shop_app_auth',
        'shop_app_auth_owner'
      )

      union all

      select
        owner_role.rolname,
        'relation',
        namespace.nspname || '.' || relation.relname
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      inner join pg_roles as owner_role on owner_role.oid = relation.relowner
      where owner_role.rolname in (
        'dokana_migration_login',
        'dokana_auth_login',
        'shop_app_auth',
        'shop_app_auth_owner'
      )

      union all

      select
        owner_role.rolname,
        'function',
        namespace.nspname || '.' || function_state.proname
      from pg_proc as function_state
      inner join pg_namespace as namespace on namespace.oid = function_state.pronamespace
      inner join pg_roles as owner_role on owner_role.oid = function_state.proowner
      where owner_role.rolname in (
        'dokana_migration_login',
        'dokana_auth_login',
        'shop_app_auth',
        'shop_app_auth_owner'
      )
    )
    select
      owner,
      object_type as "objectType",
      object_name as "objectName"
    from owned_objects
    order by owner, object_type, object_name
  `);

  for (const object of result.rows) {
    const isApprovedAuthObject =
      object.owner === 'shop_app_auth_owner' &&
      (object.objectName === 'auth_api' || object.objectName.startsWith('auth_api.'));

    if (!isApprovedAuthObject) {
      throw new Error('A managed role owns an unexpected database object.');
    }
  }
}

async function provisionRoles(
  client: PoolClient,
  migrationPassword: string,
  authenticationPassword: string,
): Promise<void> {
  await client.query(`select set_config('dokana.provision.migration_password', $1, true)`, [
    migrationPassword,
  ]);
  await client.query(`select set_config('dokana.provision.authentication_password', $1, true)`, [
    authenticationPassword,
  ]);

  await client.query(`
    do $provision$
    begin
      if not exists (select 1 from pg_roles where rolname = 'shop_app_auth') then
        create role shop_app_auth
          nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;

      if not exists (select 1 from pg_roles where rolname = 'shop_app_auth_owner') then
        create role shop_app_auth_owner
          nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;

      if not exists (select 1 from pg_roles where rolname = 'dokana_migration_login') then
        create role dokana_migration_login
          login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;

      if not exists (select 1 from pg_roles where rolname = 'dokana_auth_login') then
        create role dokana_auth_login
          login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;

      execute format(
        'alter role dokana_migration_login password %L',
        current_setting('dokana.provision.migration_password')
      );
      execute format(
        'alter role dokana_auth_login password %L',
        current_setting('dokana.provision.authentication_password')
      );
    end
    $provision$;

    alter role dokana_migration_login set search_path to pg_catalog;
    alter role dokana_migration_login set row_security to on;
    alter role dokana_auth_login set search_path to pg_catalog;
    alter role dokana_auth_login set row_security to on;

    revoke shop_app_migrator from dokana_migration_login;
    grant shop_app_migrator to dokana_migration_login
      with admin false, inherit false, set true;

    revoke shop_app_auth from dokana_auth_login;
    grant shop_app_auth to dokana_auth_login
      with admin false, inherit true, set false;

    revoke shop_app_auth_owner from shop_app_migrator;
    grant shop_app_auth_owner to shop_app_migrator
      with admin false, inherit false, set true;

    do $database_grants$
    begin
      execute format(
        'grant connect on database %I to dokana_migration_login, dokana_auth_login',
        current_database()
      );
    end
    $database_grants$;
  `);
}

async function verifyRoleCapabilities(client: PoolClient): Promise<void> {
  const result = await client.query<{
    migrationCanSetMigrator: boolean;
    migratorCanSetAuthOwner: boolean;
    migrationCanSetAuthExecution: boolean;
    migratorCanSetAuthExecution: boolean;
    migrationCanSetRuntime: boolean;
    migratorCanSetRuntime: boolean;
    authCanSetMigrator: boolean;
    authCanSetAuthOwner: boolean;
    authCanSetRuntime: boolean;
    authOwnerCanLogin: boolean;
    migrationCanSetApplicationLogin: boolean;
    migratorCanSetApplicationLogin: boolean;
    migrationCanSetElevatedRole: boolean;
    migratorCanSetElevatedRole: boolean;
    migrationCanConnect: boolean;
    authCanConnect: boolean;
  }>(`
    select
      pg_has_role('dokana_migration_login', 'shop_app_migrator', 'SET')
        as "migrationCanSetMigrator",
      pg_has_role('shop_app_migrator', 'shop_app_auth_owner', 'SET')
        as "migratorCanSetAuthOwner",
      pg_has_role('dokana_migration_login', 'shop_app_auth', 'SET')
        as "migrationCanSetAuthExecution",
      pg_has_role('shop_app_migrator', 'shop_app_auth', 'SET')
        as "migratorCanSetAuthExecution",
      pg_has_role('dokana_migration_login', 'shop_app_runtime', 'SET')
        as "migrationCanSetRuntime",
      pg_has_role('shop_app_migrator', 'shop_app_runtime', 'SET')
        as "migratorCanSetRuntime",
      pg_has_role('dokana_auth_login', 'shop_app_migrator', 'SET')
        as "authCanSetMigrator",
      pg_has_role('dokana_auth_login', 'shop_app_auth_owner', 'SET')
        as "authCanSetAuthOwner",
      pg_has_role('dokana_auth_login', 'shop_app_runtime', 'SET')
        as "authCanSetRuntime",
      (select rolcanlogin from pg_roles where rolname = 'shop_app_auth_owner')
        as "authOwnerCanLogin",
      exists (
        select 1
        from pg_roles as target_role
        where
          target_role.rolcanlogin
          and target_role.rolname <> 'dokana_migration_login'
          and pg_has_role('dokana_migration_login', target_role.rolname, 'SET')
      ) as "migrationCanSetApplicationLogin",
      exists (
        select 1
        from pg_roles as target_role
        where
          target_role.rolcanlogin
          and pg_has_role('shop_app_migrator', target_role.rolname, 'SET')
      ) as "migratorCanSetApplicationLogin",
      exists (
        select 1
        from pg_roles as target_role
        where
          (target_role.rolsuper or target_role.rolbypassrls)
          and pg_has_role('dokana_migration_login', target_role.rolname, 'SET')
      ) as "migrationCanSetElevatedRole",
      exists (
        select 1
        from pg_roles as target_role
        where
          (target_role.rolsuper or target_role.rolbypassrls)
          and pg_has_role('shop_app_migrator', target_role.rolname, 'SET')
      ) as "migratorCanSetElevatedRole",
      has_database_privilege('dokana_migration_login', current_database(), 'CONNECT')
        as "migrationCanConnect",
      has_database_privilege('dokana_auth_login', current_database(), 'CONNECT')
        as "authCanConnect"
  `);
  const state = result.rows[0];

  if (
    !state ||
    !state.migrationCanSetMigrator ||
    !state.migratorCanSetAuthOwner ||
    state.migrationCanSetAuthExecution ||
    state.migratorCanSetAuthExecution ||
    state.migrationCanSetRuntime ||
    state.migratorCanSetRuntime ||
    state.authCanSetMigrator ||
    state.authCanSetAuthOwner ||
    state.authCanSetRuntime ||
    state.authOwnerCanLogin ||
    state.migrationCanSetApplicationLogin ||
    state.migratorCanSetApplicationLogin ||
    state.migrationCanSetElevatedRole ||
    state.migratorCanSetElevatedRole ||
    !state.migrationCanConnect ||
    !state.authCanConnect
  ) {
    throw new Error('The provisioned role capabilities are not least-privileged.');
  }
}

async function replaceEnvironmentFile(path: string, contents: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.env.station3-${String(process.pid)}-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, '..');
  const environmentPath = join(repositoryRoot, '.env');
  const environmentContents = await readFile(environmentPath, 'utf8');
  const environment = parse(environmentContents);
  const administrativeUrl = environment.DATABASE_ADMIN_URL;
  const migrationPassword = process.env.DOKANA_STATION3_MIGRATION_PASSWORD;
  const authenticationPassword = process.env.DOKANA_STATION3_AUTH_PASSWORD;

  if (!administrativeUrl) {
    throw new Error('The approved local administrative connection is not configured.');
  }
  assertStrongPassword(migrationPassword, 'Migration password');
  assertStrongPassword(authenticationPassword, 'Authentication password');
  if (migrationPassword === authenticationPassword) {
    throw new Error('The limited database logins must use distinct passwords.');
  }

  const migrationUrl = buildLimitedConnectionUrl(
    administrativeUrl,
    'dokana_migration_login',
    migrationPassword,
  );
  const authenticationUrl = buildLimitedConnectionUrl(
    administrativeUrl,
    'dokana_auth_login',
    authenticationPassword,
  );
  const withMigrationUrl = replaceEnvironmentVariable(
    environmentContents,
    'DATABASE_MIGRATION_URL',
    migrationUrl,
  );
  const updatedEnvironment = replaceEnvironmentVariable(
    withMigrationUrl,
    'AUTH_DATABASE_URL',
    authenticationUrl,
  );

  if (parse(updatedEnvironment).DATABASE_ADMIN_URL !== administrativeUrl) {
    throw new Error('The administrative connection would be modified.');
  }

  const pool = new Pool({
    connectionString: administrativeUrl,
    ssl: environment.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: 'dokana-station3-role-provisioning',
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('begin');
    transactionStarted = true;
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('dokana:station3:role-provisioning', 0))`,
    );
    await verifyAdministrativeSession(client);

    const existingRoles = await readManagedRoles(client);
    assertExistingRolesSafe(existingRoles);
    assertMembershipsAllowed(await readManagedMemberships(client));
    await verifyManagedOwnership(client);

    await provisionRoles(client, migrationPassword, authenticationPassword);

    const provisionedRoles = await readManagedRoles(client);
    if (provisionedRoles.length !== managedRoleNames.length) {
      throw new Error('Not all managed roles were provisioned.');
    }
    assertExistingRolesSafe(provisionedRoles);
    assertMembershipsExact(await readManagedMemberships(client));
    await verifyRoleCapabilities(client);
    await verifyManagedOwnership(client);

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

  await replaceEnvironmentFile(environmentPath, updatedEnvironment);
}

void main().catch(() => {
  process.exitCode = 1;
});
