import { Pool } from 'pg';

export interface LocalPostgresTestEnvironment {
  runtimeUrl: string;
  adminUrl: string;
  authUrl: string;
  migrationUrl: string;
  ssl: false | { rejectUnauthorized: true };
  databaseName: string;
}

const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function readLocalPostgresTestEnvironment(): LocalPostgresTestEnvironment | undefined {
  const runtimeUrl = process.env.TEST_DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const authUrl = process.env.AUTH_DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;

  if (
    !runtimeUrl ||
    !adminUrl ||
    !authUrl ||
    !migrationUrl ||
    process.env.APP_ENV === 'production'
  ) {
    return undefined;
  }

  try {
    const parsedRuntime = new URL(runtimeUrl);
    const parsedAdmin = new URL(adminUrl);
    const parsedAuth = new URL(authUrl);
    const parsedMigration = new URL(migrationUrl);
    const urls = [parsedRuntime, parsedAdmin, parsedAuth, parsedMigration];
    const databaseNames = urls.map((url) => decodeURIComponent(url.pathname.slice(1)));

    if (
      urls.some(
        (url) =>
          !['postgres:', 'postgresql:'].includes(url.protocol) || !localHostnames.has(url.hostname),
      ) ||
      databaseNames.some((name) => !name || name !== databaseNames[0])
    ) {
      return undefined;
    }

    return {
      runtimeUrl,
      adminUrl,
      authUrl,
      migrationUrl,
      ssl:
        process.env.TEST_DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
      databaseName: databaseNames[0] ?? '',
    };
  } catch {
    return undefined;
  }
}

export function createTestPool(
  connectionString: string,
  applicationName: string,
  max = 2,
  options?: string,
): Pool {
  return new Pool({
    connectionString,
    ssl:
      process.env.TEST_DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: applicationName,
    options,
    max,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    allowExitOnIdle: true,
  });
}
