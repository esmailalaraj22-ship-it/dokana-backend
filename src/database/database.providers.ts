import type { Provider } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { DATABASE_POOL, DRIZZLE_DATABASE } from './database.constants';

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
    useFactory: (pool: Pool) =>
      drizzle(pool, {
        casing: 'snake_case',
        logger: false,
      }),
  },
];
