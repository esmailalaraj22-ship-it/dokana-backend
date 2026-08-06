import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { validateEnvironment } from '../src/config/environment';

type Target = 'runtime' | 'admin' | 'auth' | 'migration';

interface ConnectionMetadata {
  database: string;
  role: string;
  serverVersion: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateDatabases: boolean;
  canCreateRoles: boolean;
  canReplicate: boolean;
  rowSecurityEnabled: boolean;
  isRuntimeRoleMember: boolean;
  isMigrationRoleMember: boolean;
  isAuthRoleMember: boolean;
  canSetRuntimeRole: boolean;
  canSetMigrationRole: boolean;
  canSetAuthRole: boolean;
  canSetAuthOwnerRole: boolean;
  hasAuthSchemaUsage: boolean;
  hasLedgerSchemaUsage: boolean;
  hasRestrictedSchemaAccess: boolean;
  hasGlobalIdentityTableAccess: boolean;
  hasProtectedTableAccess: boolean;
}

async function main(): Promise<void> {
  const target = (process.argv[2] ?? 'runtime') as Target;

  if (!['runtime', 'admin', 'auth', 'migration'].includes(target)) {
    throw new Error('Database check target is invalid.');
  }

  const environment = validateEnvironment(process.env);
  const connectionStrings: Record<Target, string | undefined> = {
    runtime: environment.DATABASE_URL,
    admin: environment.DATABASE_ADMIN_URL,
    auth: environment.AUTH_DATABASE_URL,
    migration: environment.DATABASE_MIGRATION_URL,
  };
  const connectionString = connectionStrings[target];

  if (!connectionString) {
    throw new Error('The selected database connection is not configured.');
  }

  const pool = new Pool({
    connectionString,
    ssl: environment.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: `dokana-database-check-${target}`,
    max: 1,
    connectionTimeoutMillis: environment.DB_CONNECTION_TIMEOUT_MS,
    statement_timeout: environment.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: environment.DB_STATEMENT_TIMEOUT_MS,
  });

  try {
    const database = drizzle(pool, { logger: false });
    await database.execute(sql`select 1`);

    const result = await pool.query<ConnectionMetadata>(`
      select
        current_database() as "database",
        current_user as "role",
        current_setting('server_version') as "serverVersion",
        r.rolsuper as "isSuperuser",
        r.rolbypassrls as "bypassesRls",
        r.rolcreatedb as "canCreateDatabases",
        r.rolcreaterole as "canCreateRoles",
        r.rolreplication as "canReplicate",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "isRuntimeRoleMember",
        pg_has_role(current_user, 'shop_app_migrator', 'MEMBER') as "isMigrationRoleMember",
        pg_has_role(current_user, 'shop_app_auth', 'MEMBER') as "isAuthRoleMember",
        pg_has_role(current_user, 'shop_app_runtime', 'SET') as "canSetRuntimeRole",
        pg_has_role(current_user, 'shop_app_migrator', 'SET') as "canSetMigrationRole",
        pg_has_role(current_user, 'shop_app_auth', 'SET') as "canSetAuthRole",
        pg_has_role(current_user, 'shop_app_auth_owner', 'SET') as "canSetAuthOwnerRole",
        has_schema_privilege(current_user, 'auth_api', 'USAGE') as "hasAuthSchemaUsage",
        has_schema_privilege(current_user, 'ledger', 'USAGE') as "hasLedgerSchemaUsage",
        (
          has_schema_privilege(current_user, 'platform', 'USAGE')
          or has_schema_privilege(current_user, 'audit', 'USAGE')
        ) as "hasRestrictedSchemaAccess",
        exists (
          select 1
          from pg_class as global_identity
          inner join pg_namespace as global_namespace
            on global_namespace.oid = global_identity.relnamespace
          where
            global_namespace.nspname = 'platform'
            and global_identity.relname in (
              'users',
              'store_memberships',
              'auth_sessions',
              'refresh_tokens'
            )
            and (
              has_table_privilege(current_user, global_identity.oid, 'SELECT')
              or has_table_privilege(current_user, global_identity.oid, 'INSERT')
              or has_table_privilege(current_user, global_identity.oid, 'UPDATE')
              or has_table_privilege(current_user, global_identity.oid, 'DELETE')
              or has_table_privilege(current_user, global_identity.oid, 'TRUNCATE')
              or has_table_privilege(current_user, global_identity.oid, 'REFERENCES')
              or has_table_privilege(current_user, global_identity.oid, 'TRIGGER')
              or has_any_column_privilege(current_user, global_identity.oid, 'SELECT')
              or has_any_column_privilege(current_user, global_identity.oid, 'INSERT')
              or has_any_column_privilege(current_user, global_identity.oid, 'UPDATE')
              or has_any_column_privilege(current_user, global_identity.oid, 'REFERENCES')
            )
        ) as "hasGlobalIdentityTableAccess",
        exists (
          select 1
          from pg_class as protected_auth
          inner join pg_namespace as protected_namespace
            on protected_namespace.oid = protected_auth.relnamespace
          where
            (
              (
                protected_namespace.nspname = 'platform'
                and protected_auth.relname in (
                  'users',
                  'store_memberships',
                  'auth_sessions',
                  'refresh_tokens'
                )
              )
              or (
                protected_namespace.nspname = 'ledger'
                and protected_auth.relname in ('stores', 'devices')
              )
            )
            and (
              has_table_privilege(current_user, protected_auth.oid, 'SELECT')
              or has_table_privilege(current_user, protected_auth.oid, 'INSERT')
              or has_table_privilege(current_user, protected_auth.oid, 'UPDATE')
              or has_table_privilege(current_user, protected_auth.oid, 'DELETE')
              or has_table_privilege(current_user, protected_auth.oid, 'TRUNCATE')
              or has_table_privilege(current_user, protected_auth.oid, 'REFERENCES')
              or has_table_privilege(current_user, protected_auth.oid, 'TRIGGER')
              or has_any_column_privilege(current_user, protected_auth.oid, 'SELECT')
              or has_any_column_privilege(current_user, protected_auth.oid, 'INSERT')
              or has_any_column_privilege(current_user, protected_auth.oid, 'UPDATE')
              or has_any_column_privilege(current_user, protected_auth.oid, 'REFERENCES')
            )
        ) as "hasProtectedTableAccess"
      from pg_roles as r
      where r.rolname = current_user
    `);
    const metadata = result.rows[0];

    if (!metadata) {
      throw new Error('Connection metadata was unavailable.');
    }

    if (
      target === 'runtime' &&
      (metadata.isSuperuser ||
        metadata.bypassesRls ||
        metadata.canCreateDatabases ||
        metadata.canCreateRoles ||
        metadata.canReplicate ||
        !metadata.rowSecurityEnabled ||
        !metadata.isRuntimeRoleMember ||
        metadata.isMigrationRoleMember ||
        metadata.isAuthRoleMember ||
        metadata.canSetMigrationRole ||
        metadata.canSetAuthRole ||
        metadata.canSetAuthOwnerRole ||
        metadata.hasAuthSchemaUsage ||
        metadata.hasRestrictedSchemaAccess ||
        metadata.hasGlobalIdentityTableAccess)
    ) {
      throw new Error('Runtime role safety verification failed.');
    }
    if (
      target === 'auth' &&
      (metadata.role !== 'dokana_auth_login' ||
        metadata.isSuperuser ||
        metadata.bypassesRls ||
        metadata.canCreateDatabases ||
        metadata.canCreateRoles ||
        metadata.canReplicate ||
        !metadata.rowSecurityEnabled ||
        !metadata.isAuthRoleMember ||
        metadata.canSetAuthRole ||
        metadata.canSetAuthOwnerRole ||
        metadata.canSetMigrationRole ||
        metadata.canSetRuntimeRole ||
        !metadata.hasAuthSchemaUsage ||
        metadata.hasLedgerSchemaUsage ||
        metadata.hasRestrictedSchemaAccess ||
        metadata.hasProtectedTableAccess)
    ) {
      throw new Error('Authentication role safety verification failed.');
    }
    if (
      target === 'migration' &&
      (metadata.role !== 'dokana_migration_login' ||
        metadata.isSuperuser ||
        metadata.bypassesRls ||
        metadata.canCreateDatabases ||
        metadata.canCreateRoles ||
        metadata.canReplicate ||
        !metadata.rowSecurityEnabled ||
        !metadata.isMigrationRoleMember ||
        !metadata.canSetMigrationRole ||
        metadata.canSetRuntimeRole ||
        metadata.canSetAuthRole)
    ) {
      throw new Error('Migration role safety verification failed.');
    }

    process.stdout.write(
      `${JSON.stringify({
        status: 'ok',
        target,
        database: metadata.database,
        role: metadata.role,
        serverVersion: metadata.serverVersion,
        runtimeRoleVerified: target === 'runtime' ? metadata.isRuntimeRoleMember : undefined,
        authenticationRoleVerified: target === 'auth' ? metadata.isAuthRoleMember : undefined,
        migrationRoleVerified: target === 'migration' ? metadata.isMigrationRoleMember : undefined,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      status: 'error',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })}\n`,
  );
  process.exitCode = 1;
});
