import type { Environment } from '../config/environment';

export interface RecoveryFilesystemStorageConfig {
  driver: 'filesystem';
  rootDirectory: string;
}

export interface RecoveryS3StorageConfig {
  driver: 's3';
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  forcePathStyle: boolean;
  kmsKeyId: string | undefined;
  timeoutMs: number;
}

export type RecoveryStorageConfig =
  { driver: 'unconfigured' } | RecoveryFilesystemStorageConfig | RecoveryS3StorageConfig;

export interface RecoveryRuntimeConfig {
  applicationEnvironment: Environment['APP_ENV'];
  environmentId: string;
  sourceRevision: string | null;
  storage: RecoveryStorageConfig;
  logicalMaximumAgeHours: number;
  attachmentBatchSize: number;
  attachmentConcurrency: number;
  attachmentOrphanGraceHours: number;
}

export type RecoveryEnvironment = Pick<
  Environment,
  | 'APP_ENV'
  | 'RECOVERY_ENVIRONMENT_ID'
  | 'RECOVERY_SOURCE_REVISION'
  | 'RECOVERY_STORAGE_DRIVER'
  | 'RECOVERY_FILESYSTEM_ROOT'
  | 'RECOVERY_S3_ENDPOINT'
  | 'RECOVERY_S3_REGION'
  | 'RECOVERY_S3_BUCKET'
  | 'RECOVERY_S3_ACCESS_KEY_ID'
  | 'RECOVERY_S3_SECRET_ACCESS_KEY'
  | 'RECOVERY_S3_FORCE_PATH_STYLE'
  | 'RECOVERY_S3_KMS_KEY_ID'
  | 'RECOVERY_STORAGE_TIMEOUT_MS'
  | 'RECOVERY_LOGICAL_MAX_AGE_HOURS'
  | 'RECOVERY_ATTACHMENT_BATCH_SIZE'
  | 'RECOVERY_ATTACHMENT_CONCURRENCY'
  | 'RECOVERY_ATTACHMENT_ORPHAN_GRACE_HOURS'
>;

export function recoveryRuntimeConfigFromEnvironment(
  environment: RecoveryEnvironment,
): RecoveryRuntimeConfig {
  let storage: RecoveryStorageConfig;
  if (environment.RECOVERY_STORAGE_DRIVER === 'filesystem') {
    if (!environment.RECOVERY_FILESYSTEM_ROOT) {
      throw new Error('Recovery filesystem storage is not configured.');
    }
    storage = {
      driver: 'filesystem',
      rootDirectory: environment.RECOVERY_FILESYSTEM_ROOT,
    };
  } else if (environment.RECOVERY_STORAGE_DRIVER === 's3') {
    if (!environment.RECOVERY_S3_BUCKET) {
      throw new Error('Recovery S3 storage is not configured.');
    }
    storage = {
      driver: 's3',
      endpoint: environment.RECOVERY_S3_ENDPOINT,
      region: environment.RECOVERY_S3_REGION,
      bucket: environment.RECOVERY_S3_BUCKET,
      accessKeyId: environment.RECOVERY_S3_ACCESS_KEY_ID,
      secretAccessKey: environment.RECOVERY_S3_SECRET_ACCESS_KEY,
      forcePathStyle: environment.RECOVERY_S3_FORCE_PATH_STYLE,
      kmsKeyId: environment.RECOVERY_S3_KMS_KEY_ID,
      timeoutMs: environment.RECOVERY_STORAGE_TIMEOUT_MS,
    };
  } else {
    storage = { driver: 'unconfigured' };
  }

  return {
    applicationEnvironment: environment.APP_ENV,
    environmentId: environment.RECOVERY_ENVIRONMENT_ID,
    sourceRevision: environment.RECOVERY_SOURCE_REVISION ?? null,
    storage,
    logicalMaximumAgeHours: environment.RECOVERY_LOGICAL_MAX_AGE_HOURS,
    attachmentBatchSize: environment.RECOVERY_ATTACHMENT_BATCH_SIZE,
    attachmentConcurrency: environment.RECOVERY_ATTACHMENT_CONCURRENCY,
    attachmentOrphanGraceHours: environment.RECOVERY_ATTACHMENT_ORPHAN_GRACE_HOURS,
  };
}
