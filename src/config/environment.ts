import { z } from 'zod';

const postgresUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'must be a valid PostgreSQL URL');

const optionalPostgresUrlSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  postgresUrlSchema.optional(),
);

const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalHttpUrlSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'must be an HTTP(S) URL',
    })
    .optional(),
);

const optionalAbsolutePathSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .min(1)
    .refine((value) => /^(?:[A-Za-z]:[\\/]|\/)/.test(value), 'must be an absolute path')
    .optional(),
);

const signingKeyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

const signingSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be unpadded base64url')
  .refine((value) => Buffer.from(value, 'base64url').byteLength >= 32, {
    message: 'must contain at least 256 bits',
  });

function parsePreviousSigningKeys(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const previousSigningKeysSchema = z
  .string()
  .default('{}')
  .superRefine((value, context) => {
    const parsed = parsePreviousSigningKeys(value);
    if (!parsed) {
      context.addIssue({
        code: 'custom',
        message: 'must be a JSON object of key IDs to base64url secrets',
      });
      return;
    }

    for (const [keyId, secret] of Object.entries(parsed)) {
      if (!signingKeyIdSchema.safeParse(keyId).success) {
        context.addIssue({
          code: 'custom',
          message: 'contains an invalid key ID',
        });
        return;
      }
      if (!signingSecretSchema.safeParse(secret).success) {
        context.addIssue({
          code: 'custom',
          message: 'contains an invalid signing secret',
        });
        return;
      }
    }
  });

const offlineLicensePrivateKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be unpadded base64url PKCS8 DER')
  .refine((value) => Buffer.from(value, 'base64url').byteLength >= 48, {
    message: 'must contain an Ed25519 PKCS8 private key',
  });

function parseOfflineLicensePublicKeys(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const offlineLicensePublicKeysSchema = z.string().superRefine((value, context) => {
  const parsed = parseOfflineLicensePublicKeys(value);
  if (!parsed || Object.keys(parsed).length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'must be a non-empty JSON object of key IDs to base64url SPKI public keys',
    });
    return;
  }

  for (const [keyId, publicKey] of Object.entries(parsed)) {
    if (!signingKeyIdSchema.safeParse(keyId).success) {
      context.addIssue({ code: 'custom', message: 'contains an invalid key ID' });
      return;
    }
    if (
      typeof publicKey !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(publicKey) ||
      Buffer.from(publicKey, 'base64url').byteLength < 32
    ) {
      context.addIssue({
        code: 'custom',
        message: 'contains an invalid base64url SPKI public key',
      });
      return;
    }
  }
});

const booleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

const corsOriginsSchema = z
  .string()
  .default('')
  .superRefine((value, context) => {
    for (const origin of value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
          context.addIssue({
            code: 'custom',
            message: 'must contain comma-separated HTTP(S) origins without paths',
          });
          return;
        }
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'must contain comma-separated valid origins',
        });
        return;
      }
    }
  });

export const environmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: postgresUrlSchema,
    AUTH_DATABASE_URL: postgresUrlSchema,
    DATABASE_ADMIN_URL: optionalPostgresUrlSchema,
    DATABASE_MIGRATION_URL: optionalPostgresUrlSchema,
    DATABASE_SSL_MODE: z.enum(['disable', 'verify-full']),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    REQUEST_ID_HEADER: z
      .string()
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'must be a valid HTTP header name')
      .transform((value) => value.toLowerCase())
      .default('x-request-id'),
    REQUEST_ID_TRUST_INCOMING: booleanStringSchema.default(false),
    CORS_ORIGINS: corsOriginsSchema,
    TRUST_PROXY: booleanStringSchema.default(false),
    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
    API_VERSION: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default('1'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(15_000),
    DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(15_000),
    AUTH_DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    AUTH_TOKEN_ISSUER: z.string().min(1).max(200).default('dokana-backend'),
    AUTH_TOKEN_AUDIENCE: z.string().min(1).max(200).default('dokana-mobile'),
    AUTH_ACCESS_TOKEN_ACTIVE_KID: signingKeyIdSchema,
    AUTH_ACCESS_TOKEN_ACTIVE_SECRET: signingSecretSchema,
    AUTH_ACCESS_TOKEN_PREVIOUS_KEYS: previousSigningKeysSchema,
    AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3_600)
      .max(2_678_400)
      .default(2_592_000),
    AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(3_600).max(2_678_400).default(2_592_000),
    OFFLINE_LICENSE_ACTIVE_KEY_ID: signingKeyIdSchema,
    OFFLINE_LICENSE_ACTIVE_PRIVATE_KEY_PKCS8: offlineLicensePrivateKeySchema,
    OFFLINE_LICENSE_PUBLIC_KEYS: offlineLicensePublicKeysSchema,
    ATTACHMENT_S3_ENDPOINT: optionalHttpUrlSchema,
    ATTACHMENT_S3_REGION: z.string().min(1).default('us-east-1'),
    ATTACHMENT_S3_BUCKET: optionalNonEmptyStringSchema,
    ATTACHMENT_S3_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
    ATTACHMENT_S3_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
    ATTACHMENT_S3_FORCE_PATH_STYLE: booleanStringSchema.default(false),
    ATTACHMENT_STORAGE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    ATTACHMENT_CLAMAV_HOST: optionalNonEmptyStringSchema,
    ATTACHMENT_CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
    ATTACHMENT_SCAN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    RECOVERY_DATABASE_URL: optionalPostgresUrlSchema,
    RECOVERY_POSTGRES_BIN_DIR: optionalAbsolutePathSchema,
    RECOVERY_ENVIRONMENT_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .default('local-development'),
    RECOVERY_SOURCE_REVISION: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[0-9a-f]{7,64}$/)
        .optional(),
    ),
    RECOVERY_STORAGE_DRIVER: z.enum(['unconfigured', 'filesystem', 's3']).default('unconfigured'),
    RECOVERY_FILESYSTEM_ROOT: optionalAbsolutePathSchema,
    RECOVERY_S3_ENDPOINT: optionalHttpUrlSchema,
    RECOVERY_S3_REGION: z.string().min(1).default('us-east-1'),
    RECOVERY_S3_BUCKET: optionalNonEmptyStringSchema,
    RECOVERY_S3_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
    RECOVERY_S3_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
    RECOVERY_S3_FORCE_PATH_STYLE: booleanStringSchema.default(false),
    RECOVERY_S3_KMS_KEY_ID: optionalNonEmptyStringSchema,
    RECOVERY_TARGET_ATTACHMENT_S3_ENDPOINT: optionalHttpUrlSchema,
    RECOVERY_TARGET_ATTACHMENT_S3_REGION: z.string().min(1).default('us-east-1'),
    RECOVERY_TARGET_ATTACHMENT_S3_BUCKET: optionalNonEmptyStringSchema,
    RECOVERY_TARGET_ATTACHMENT_S3_ACCESS_KEY_ID: optionalNonEmptyStringSchema,
    RECOVERY_TARGET_ATTACHMENT_S3_SECRET_ACCESS_KEY: optionalNonEmptyStringSchema,
    RECOVERY_TARGET_ATTACHMENT_S3_FORCE_PATH_STYLE: booleanStringSchema.default(false),
    RECOVERY_STORAGE_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
    RECOVERY_LOGICAL_MAX_AGE_HOURS: z.coerce.number().int().min(24).max(72).default(36),
    RECOVERY_ATTACHMENT_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    RECOVERY_ATTACHMENT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    RECOVERY_ATTACHMENT_ORPHAN_GRACE_HOURS: z.coerce.number().int().min(24).max(720).default(168),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  })
  .superRefine((environment, context) => {
    if (environment.HEALTH_CHECK_TIMEOUT_MS < environment.DB_CONNECTION_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['HEALTH_CHECK_TIMEOUT_MS'],
        message: 'must be greater than or equal to DB_CONNECTION_TIMEOUT_MS',
      });
    }

    const previousSigningKeys = parsePreviousSigningKeys(
      environment.AUTH_ACCESS_TOKEN_PREVIOUS_KEYS,
    );
    if (previousSigningKeys?.[environment.AUTH_ACCESS_TOKEN_ACTIVE_KID] !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_ACCESS_TOKEN_PREVIOUS_KEYS'],
        message: 'must not contain the active key ID',
      });
    }

    if (environment.AUTH_REFRESH_TOKEN_TTL_SECONDS > environment.AUTH_SESSION_TTL_SECONDS) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_REFRESH_TOKEN_TTL_SECONDS'],
        message: 'must not exceed AUTH_SESSION_TTL_SECONDS',
      });
    }

    const publicKeys = parseOfflineLicensePublicKeys(environment.OFFLINE_LICENSE_PUBLIC_KEYS);
    if (publicKeys?.[environment.OFFLINE_LICENSE_ACTIVE_KEY_ID] === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['OFFLINE_LICENSE_PUBLIC_KEYS'],
        message: 'must contain the active Offline License key ID',
      });
    }

    if (
      (environment.ATTACHMENT_S3_ACCESS_KEY_ID === undefined) !==
      (environment.ATTACHMENT_S3_SECRET_ACCESS_KEY === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ATTACHMENT_S3_ACCESS_KEY_ID'],
        message: 'access-key ID and secret access key must be configured together',
      });
    }

    if (
      (environment.RECOVERY_S3_ACCESS_KEY_ID === undefined) !==
      (environment.RECOVERY_S3_SECRET_ACCESS_KEY === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_S3_ACCESS_KEY_ID'],
        message: 'access-key ID and secret access key must be configured together',
      });
    }

    if (
      (environment.RECOVERY_TARGET_ATTACHMENT_S3_ACCESS_KEY_ID === undefined) !==
      (environment.RECOVERY_TARGET_ATTACHMENT_S3_SECRET_ACCESS_KEY === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_TARGET_ATTACHMENT_S3_ACCESS_KEY_ID'],
        message: 'access-key ID and secret access key must be configured together',
      });
    }

    if (
      environment.RECOVERY_STORAGE_DRIVER === 'filesystem' &&
      environment.RECOVERY_FILESYSTEM_ROOT === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_FILESYSTEM_ROOT'],
        message: 'is required when RECOVERY_STORAGE_DRIVER is filesystem',
      });
    }

    if (
      environment.RECOVERY_STORAGE_DRIVER === 'filesystem' &&
      environment.APP_ENV === 'production'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_STORAGE_DRIVER'],
        message: 'filesystem recovery storage is forbidden in production',
      });
    }

    if (
      environment.RECOVERY_STORAGE_DRIVER === 's3' &&
      environment.RECOVERY_S3_BUCKET === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_S3_BUCKET'],
        message: 'is required when RECOVERY_STORAGE_DRIVER is s3',
      });
    }

    if (
      environment.RECOVERY_S3_BUCKET !== undefined &&
      environment.RECOVERY_S3_BUCKET === environment.ATTACHMENT_S3_BUCKET
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_S3_BUCKET'],
        message: 'must use a bucket distinct from business attachments',
      });
    }

    if (
      environment.RECOVERY_TARGET_ATTACHMENT_S3_BUCKET !== undefined &&
      (environment.RECOVERY_TARGET_ATTACHMENT_S3_BUCKET === environment.ATTACHMENT_S3_BUCKET ||
        environment.RECOVERY_TARGET_ATTACHMENT_S3_BUCKET === environment.RECOVERY_S3_BUCKET)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_TARGET_ATTACHMENT_S3_BUCKET'],
        message: 'must use a bucket distinct from live attachments and recovery artifacts',
      });
    }

    if (
      environment.APP_ENV === 'production' &&
      environment.RECOVERY_STORAGE_DRIVER === 's3' &&
      environment.RECOVERY_S3_ENDPOINT?.startsWith('http:')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_S3_ENDPOINT'],
        message: 'must use HTTPS in production',
      });
    }

    if (
      environment.APP_ENV === 'production' &&
      environment.RECOVERY_TARGET_ATTACHMENT_S3_ENDPOINT?.startsWith('http:')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['RECOVERY_TARGET_ATTACHMENT_S3_ENDPOINT'],
        message: 'must use HTTPS in production',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(rawEnvironment: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(rawEnvironment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');

    throw new Error(`Environment validation failed: ${details}`);
  }

  return result.data;
}
