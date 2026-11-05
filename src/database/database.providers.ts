import type { Provider } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { DATABASE_POOL, DRIZZLE_DATABASE } from './database.constants';
import * as databaseSchema from './schema';

export function createRuntimeDatabase(pool: Pool) {
  const connectDrizzle = (client: Pool | PoolClient) =>
    drizzle(client, { casing: 'snake_case', logger: false, schema: databaseSchema });
  const database = connectDrizzle(pool);

  // Own the pool lease outside Drizzle: its pooled transaction starts BEGIN
  // before its release finally block. A failed BEGIN otherwise leaks the lease.
  database.transaction = async (work, config) => {
    const client = await pool.connect();
    let workFailure: { error: unknown } | undefined;
    let result;
    try {
      result = await connectDrizzle(client).transaction(async (transaction) => {
        try {
          return await work(transaction);
        } catch (error) {
          workFailure = { error };
          throw error;
        }
      }, config);
    } catch (error) {
      // This also covers failed rollback/commit and uncertain connection state.
      try {
        client.release(true);
      } catch {
        // A cleanup failure must not replace the transaction's primary error.
      }
      throw workFailure ? workFailure.error : error;
    }
    client.release();
    return result;
  };
  return database;
}

export const databaseProviders: Provider[] = [
  {
    provide: DATABASE_POOL,
    inject: [AppConfigService],
    useFactory: (config: AppConfigService): Pool => {
      const database = config.runtimeDatabase;

      return new Pool({
        connectionString: database.connectionString,
        ssl: database.sslMode === 'verify-full' ? { rejectUnauthorized: true } : false,
        application_name: `dokana-backend-${config.environment}`,
        max: database.poolMax,
        connectionTimeoutMillis: database.connectionTimeoutMs,
        idleTimeoutMillis: database.idleTimeoutMs,
        statement_timeout: database.statementTimeoutMs,
        query_timeout: database.statementTimeoutMs,
        lock_timeout: database.lockTimeoutMs,
        idle_in_transaction_session_timeout: database.idleInTransactionTimeoutMs,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        allowExitOnIdle: false,
      });
    },
  },
  {
    provide: DRIZZLE_DATABASE,
    inject: [DATABASE_POOL],
    useFactory: createRuntimeDatabase,
  },
];
