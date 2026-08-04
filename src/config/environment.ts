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
    DATABASE_ADMIN_URL: optionalPostgresUrlSchema,
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
