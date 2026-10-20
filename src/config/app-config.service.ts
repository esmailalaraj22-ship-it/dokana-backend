import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from './environment';
import {
  recoveryRuntimeConfigFromEnvironment,
  type RecoveryRuntimeConfig,
} from '../recovery/recovery-config';

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

export interface AuthenticationDatabaseConfig extends RuntimeDatabaseConfig {
  poolMax: number;
}

export interface AuthenticationTokenConfig {
  issuer: string;
  audience: string;
  activeKeyId: string;
  activeSecret: string;
  previousSecrets: Readonly<Record<string, string>>;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  sessionTtlSeconds: number;
}

export interface OfflineLicenseSigningConfig {
  activeKeyId: string;
  activePrivateKeyPkcs8: string;
  publicKeys: Readonly<Record<string, string>>;
}

export interface AttachmentStorageConfig {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  forcePathStyle: boolean;
  timeoutMs: number;
}

export interface AttachmentScannerConfig {
  host: string;
  port: number;
  timeoutMs: number;
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

  get authenticationDatabase(): AuthenticationDatabaseConfig {
    return {
      ...this.runtimeDatabase,
      connectionString: this.config.get('AUTH_DATABASE_URL', { infer: true }),
      poolMax: this.config.get('AUTH_DB_POOL_MAX', { infer: true }),
    };
  }

  get authenticationTokens(): AuthenticationTokenConfig {
    const previousSecrets: unknown = JSON.parse(
      this.config.get('AUTH_ACCESS_TOKEN_PREVIOUS_KEYS', { infer: true }),
    );

    return {
      issuer: this.config.get('AUTH_TOKEN_ISSUER', { infer: true }),
      audience: this.config.get('AUTH_TOKEN_AUDIENCE', { infer: true }),
      activeKeyId: this.config.get('AUTH_ACCESS_TOKEN_ACTIVE_KID', { infer: true }),
      activeSecret: this.config.get('AUTH_ACCESS_TOKEN_ACTIVE_SECRET', { infer: true }),
      previousSecrets: previousSecrets as Readonly<Record<string, string>>,
      accessTokenTtlSeconds: this.config.get('AUTH_ACCESS_TOKEN_TTL_SECONDS', {
        infer: true,
      }),
      refreshTokenTtlSeconds: this.config.get('AUTH_REFRESH_TOKEN_TTL_SECONDS', {
        infer: true,
      }),
      sessionTtlSeconds: this.config.get('AUTH_SESSION_TTL_SECONDS', { infer: true }),
    };
  }

  get offlineLicenseSigning(): OfflineLicenseSigningConfig {
    const publicKeys: unknown = JSON.parse(
      this.config.get('OFFLINE_LICENSE_PUBLIC_KEYS', { infer: true }),
    );

    return {
      activeKeyId: this.config.get('OFFLINE_LICENSE_ACTIVE_KEY_ID', { infer: true }),
      activePrivateKeyPkcs8: this.config.get('OFFLINE_LICENSE_ACTIVE_PRIVATE_KEY_PKCS8', {
        infer: true,
      }),
      publicKeys: publicKeys as Readonly<Record<string, string>>,
    };
  }

  get attachmentStorage(): AttachmentStorageConfig | null {
    const bucket = this.config.get('ATTACHMENT_S3_BUCKET', { infer: true });
    if (!bucket) return null;

    return {
      endpoint: this.config.get('ATTACHMENT_S3_ENDPOINT', { infer: true }),
      region: this.config.get('ATTACHMENT_S3_REGION', { infer: true }),
      bucket,
      accessKeyId: this.config.get('ATTACHMENT_S3_ACCESS_KEY_ID', { infer: true }),
      secretAccessKey: this.config.get('ATTACHMENT_S3_SECRET_ACCESS_KEY', { infer: true }),
      forcePathStyle: this.config.get('ATTACHMENT_S3_FORCE_PATH_STYLE', { infer: true }),
      timeoutMs: this.config.get('ATTACHMENT_STORAGE_TIMEOUT_MS', { infer: true }),
    };
  }

  get attachmentScanner(): AttachmentScannerConfig | null {
    const host = this.config.get('ATTACHMENT_CLAMAV_HOST', { infer: true });
    if (!host) return null;

    return {
      host,
      port: this.config.get('ATTACHMENT_CLAMAV_PORT', { infer: true }),
      timeoutMs: this.config.get('ATTACHMENT_SCAN_TIMEOUT_MS', { infer: true }),
    };
  }

  get recovery(): RecoveryRuntimeConfig {
    return recoveryRuntimeConfigFromEnvironment({
      APP_ENV: this.config.get('APP_ENV', { infer: true }),
      RECOVERY_ENVIRONMENT_ID: this.config.get('RECOVERY_ENVIRONMENT_ID', { infer: true }),
      RECOVERY_SOURCE_REVISION: this.config.get('RECOVERY_SOURCE_REVISION', { infer: true }),
      RECOVERY_STORAGE_DRIVER: this.config.get('RECOVERY_STORAGE_DRIVER', { infer: true }),
      RECOVERY_FILESYSTEM_ROOT: this.config.get('RECOVERY_FILESYSTEM_ROOT', { infer: true }),
      RECOVERY_S3_ENDPOINT: this.config.get('RECOVERY_S3_ENDPOINT', { infer: true }),
      RECOVERY_S3_REGION: this.config.get('RECOVERY_S3_REGION', { infer: true }),
      RECOVERY_S3_BUCKET: this.config.get('RECOVERY_S3_BUCKET', { infer: true }),
      RECOVERY_S3_ACCESS_KEY_ID: this.config.get('RECOVERY_S3_ACCESS_KEY_ID', { infer: true }),
      RECOVERY_S3_SECRET_ACCESS_KEY: this.config.get('RECOVERY_S3_SECRET_ACCESS_KEY', {
        infer: true,
      }),
      RECOVERY_S3_FORCE_PATH_STYLE: this.config.get('RECOVERY_S3_FORCE_PATH_STYLE', {
        infer: true,
      }),
      RECOVERY_S3_KMS_KEY_ID: this.config.get('RECOVERY_S3_KMS_KEY_ID', { infer: true }),
      RECOVERY_STORAGE_TIMEOUT_MS: this.config.get('RECOVERY_STORAGE_TIMEOUT_MS', {
        infer: true,
      }),
      RECOVERY_LOGICAL_MAX_AGE_HOURS: this.config.get('RECOVERY_LOGICAL_MAX_AGE_HOURS', {
        infer: true,
      }),
      RECOVERY_ATTACHMENT_BATCH_SIZE: this.config.get('RECOVERY_ATTACHMENT_BATCH_SIZE', {
        infer: true,
      }),
      RECOVERY_ATTACHMENT_CONCURRENCY: this.config.get('RECOVERY_ATTACHMENT_CONCURRENCY', {
        infer: true,
      }),
      RECOVERY_ATTACHMENT_ORPHAN_GRACE_HOURS: this.config.get(
        'RECOVERY_ATTACHMENT_ORPHAN_GRACE_HOURS',
        { infer: true },
      ),
    });
  }
}
