import type { Provider } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { AUTH_DATABASE_POOL } from './auth.constants';

export const authenticationDatabaseProviders: Provider[] = [
  {
    provide: AUTH_DATABASE_POOL,
    inject: [AppConfigService],
    useFactory: (config: AppConfigService): Pool => {
      const database = config.authenticationDatabase;

      return new Pool({
        connectionString: database.connectionString,
        ssl: database.sslMode === 'verify-full' ? { rejectUnauthorized: true } : false,
        application_name: `dokana-auth-${config.environment}`,
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
];
