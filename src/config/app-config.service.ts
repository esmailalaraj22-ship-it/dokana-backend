import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from './environment';

export interface RuntimeDatabaseConfig {
  connectionString: string;
  sslMode: Environment['DATABASE_SSL_MODE'];
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  get environment(): Environment['APP_ENV'] {
    return this.config.get('APP_ENV', { infer: true });
  }

  get port(): number {
    return this.config.get('APP_PORT', { infer: true });
  }

  get logLevel(): Environment['LOG_LEVEL'] {
    return this.config.get('LOG_LEVEL', { infer: true });
  }

  get requestIdHeader(): string {
    return this.config.get('REQUEST_ID_HEADER', { infer: true });
  }

  get trustIncomingRequestId(): boolean {
    return this.config.get('REQUEST_ID_TRUST_INCOMING', { infer: true });
  }

  get corsOrigins(): string[] {
    return this.config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  get trustProxy(): boolean {
    return this.config.get('TRUST_PROXY', { infer: true });
  }

  get requestBodyLimitBytes(): number {
    return this.config.get('REQUEST_BODY_LIMIT_BYTES', { infer: true });
  }

  get apiVersion(): string {
    return this.config.get('API_VERSION', { infer: true });
  }

  get healthCheckTimeoutMs(): number {
    return this.config.get('HEALTH_CHECK_TIMEOUT_MS', { infer: true });
  }

  get runtimeDatabase(): RuntimeDatabaseConfig {
    return {
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      sslMode: this.config.get('DATABASE_SSL_MODE', { infer: true }),
      poolMax: this.config.get('DB_POOL_MAX', { infer: true }),
      connectionTimeoutMs: this.config.get('DB_CONNECTION_TIMEOUT_MS', { infer: true }),
      idleTimeoutMs: this.config.get('DB_IDLE_TIMEOUT_MS', { infer: true }),
      statementTimeoutMs: this.config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
      lockTimeoutMs: this.config.get('DB_LOCK_TIMEOUT_MS', { infer: true }),
      idleInTransactionTimeoutMs: this.config.get('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', {
        infer: true,
      }),
    };
  }
}
