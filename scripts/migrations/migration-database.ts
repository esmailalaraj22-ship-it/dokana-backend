import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

loadEnvironment({ path: resolve(__dirname, '..', '..', '.env') });

export function requiredPostgresUrl(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }

  return value;
}

export function migrationPoolConfig(connectionString: string, applicationName: string): PoolConfig {
  return {
    connectionString,
    ssl: process.env.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
    allowExitOnIdle: true,
  };
}

export function createMigrationPool(connectionString: string, applicationName: string): Pool {
  return new Pool(migrationPoolConfig(connectionString, applicationName));
}
