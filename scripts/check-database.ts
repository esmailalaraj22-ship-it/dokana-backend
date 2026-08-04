import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { validateEnvironment } from '../src/config/environment';

type Target = 'runtime' | 'admin';

interface ConnectionMetadata {
  database: string;
  role: string;
  serverVersion: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateDatabases: boolean;
  canCreateRoles: boolean;
  canReplicate: boolean;
  isRuntimeRoleMember: boolean;
  isMigrationRoleMember: boolean;
  hasRestrictedSchemaAccess: boolean;
}

async function main(): Promise<void> {
  const target = (process.argv[2] ?? 'runtime') as Target;

  if (!['runtime', 'admin'].includes(target)) {
    throw new Error('Database check target must be "runtime" or "admin".');
  }

  const environment = validateEnvironment(process.env);
  const connectionString =
    target === 'runtime' ? environment.DATABASE_URL : environment.DATABASE_ADMIN_URL;

  if (!connectionString) {
    throw new Error('DATABASE_ADMIN_URL is required for the administrative connectivity check.');
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
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "isRuntimeRoleMember",
        pg_has_role(current_user, 'shop_app_migrator', 'MEMBER') as "isMigrationRoleMember",
        (
          has_schema_privilege(current_user, 'platform', 'USAGE')
          or has_schema_privilege(current_user, 'audit', 'USAGE')
        ) as "hasRestrictedSchemaAccess"
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
        !metadata.isRuntimeRoleMember ||
        metadata.isMigrationRoleMember ||
        metadata.hasRestrictedSchemaAccess)
    ) {
      throw new Error('Runtime role safety verification failed.');
    }

    process.stdout.write(
      `${JSON.stringify({
        status: 'ok',
        target,
        database: metadata.database,
        role: metadata.role,
        serverVersion: metadata.serverVersion,
        runtimeRoleVerified: target === 'runtime' ? metadata.isRuntimeRoleMember : undefined,
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
