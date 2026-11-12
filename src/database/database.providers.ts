import type { Provider } from '@nestjs/common';
import type { SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { DATABASE_POOL, DRIZZLE_DATABASE } from './database.constants';
import type { DatabaseTransaction } from './database.types';
import * as databaseSchema from './schema';
import { releasePostgresClient } from './postgresql-client-lifecycle';

interface TransactionFailure {
  error: unknown;
}

// Drizzle awaits rollback in its catch block, which can replace the error that
// caused rollback. Guard both the root transaction and each explicit savepoint.
async function preserveTransactionFailure<T>(
  run: (work: (transaction: DatabaseTransaction) => Promise<T>) => Promise<T>,
  work: (transaction: DatabaseTransaction) => Promise<T>,
  state: { failedCleanup?: TransactionFailure },
): Promise<T> {
  let primary: TransactionFailure | undefined;
  try {
    return await run(async (transaction) => {
      let bodyCompleted = false;
      const execute = transaction.execute.bind(transaction);
      transaction.execute = <TRow extends Record<string, unknown> = Record<string, unknown>>(
        query: SQLWrapper | string,
      ) => {
        const statement = execute<TRow>(query);
        const executeStatement = statement.execute.bind(statement);
        statement.execute = async () => {
          try {
            return await executeStatement();
          } catch (error) {
            // After a successful callback, this is COMMIT or RELEASE SAVEPOINT.
            // Keep its failure even if the subsequent rollback also fails.
            if (bodyCompleted) primary ??= { error };
            throw error;
          }
        };
        return statement;
      };
      const nested = transaction.transaction.bind(transaction);
      transaction.transaction = (nestedWork) =>
        preserveTransactionFailure(nested, nestedWork, state);
      try {
        const result = await work(transaction);
        // A caller may catch an inner error, but cannot safely continue after
        // rollback-to-savepoint failed: the intended inner rollback is unproven.
        if (state.failedCleanup) throw state.failedCleanup.error;
        bodyCompleted = true;
        return result;
      } catch (error) {
        primary = { error };
        throw error;
      }
    });
  } catch (error) {
    if (primary && error !== primary.error) state.failedCleanup ??= primary;
    throw primary ? primary.error : error;
  }
}

export function createRuntimeDatabase(pool: Pool) {
  const connectDrizzle = (client: Pool | PoolClient) =>
    drizzle(client, { casing: 'snake_case', logger: false, schema: databaseSchema });
  const database = connectDrizzle(pool);

  // Own the pool lease outside Drizzle: its pooled transaction starts BEGIN
  // before its release finally block. A failed BEGIN otherwise leaks the lease.
  database.transaction = async (work, config) => {
    const client = await pool.connect();
    let result;
    try {
      result = await preserveTransactionFailure(
        (callback) => connectDrizzle(client).transaction(callback, config),
        work,
        {},
      );
    } catch (error) {
      // This also covers failed rollback/commit and uncertain connection state.
      releasePostgresClient(client, true);
      throw error;
    }
    releasePostgresClient(client, false);
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
