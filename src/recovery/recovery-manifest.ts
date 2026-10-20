import { createHash } from 'node:crypto';

import { z } from 'zod';

export const RECOVERY_MANIFEST_VERSION = '1' as const;
export const RECOVERY_CATALOG_PREFIX = 'recovery/v1';
export const RECOVERY_MANIFEST_MAXIMUM_BYTES = 64 * 1024;
export const RECOVERY_ARTIFACT_MAXIMUM_BYTES = 1_099_511_627_776;

const recoveryPointIdSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const safeEnvironmentSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const safeRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/)
  .nullable();

const manifestBaseSchema = z.object({
  manifestVersion: z.literal(RECOVERY_MANIFEST_VERSION),
  recoveryPointId: recoveryPointIdSchema,
  createdAt: timestampSchema,
  environmentId: safeEnvironmentSchema,
  sourceRevision: safeRevisionSchema,
  backupType: z.literal('postgresql-custom'),
});

export const creatingRecoveryManifestSchema = manifestBaseSchema.extend({
  state: z.literal('CREATING'),
});

export const failedRecoveryManifestSchema = manifestBaseSchema.extend({
  state: z.literal('FAILED'),
  failedAt: timestampSchema,
  failureClass: z.enum([
    'POSTGRES_BACKUP_FAILED',
    'BACKUP_ARTIFACT_INVALID',
    'BACKUP_UPLOAD_FAILED',
    'BACKUP_MANIFEST_FAILED',
    'BACKUP_INTEGRITY_FAILED',
    'BACKUP_VERIFICATION_RESTORE_FAILED',
    'BACKUP_DESTINATION_UNAVAILABLE',
  ]),
});

export const verifiedRecoveryManifestSchema = manifestBaseSchema.extend({
  state: z.literal('VERIFIED'),
  completedAt: timestampSchema,
  artifact: z.object({
    key: z.string().regex(/^recovery\/v1\/database\/[0-9a-f-]{36}\.dump$/),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
  }),
  postgres: z.object({
    serverVersion: z.string().min(1).max(128),
    toolVersion: z.string().min(1).max(256),
  }),
  migrations: z.object({
    appliedCount: z.number().int().nonnegative(),
    latestFilename: z.string().regex(/^[0-9]{4}_[a-z0-9_]+\.sql$/),
    checksumStatus: z.literal('PASS'),
    checksumAggregateSha256: sha256Schema,
  }),
  verification: z.object({
    status: z.literal('VERIFIED'),
    structuralCheck: z.literal('PASS'),
    verifiedAt: timestampSchema,
  }),
  retentionClass: z.enum(['DAILY', 'MONTHLY']),
});

export const recoveryManifestSchema = z.discriminatedUnion('state', [
  creatingRecoveryManifestSchema,
  failedRecoveryManifestSchema,
  verifiedRecoveryManifestSchema,
]);

export type CreatingRecoveryManifest = z.infer<typeof creatingRecoveryManifestSchema>;
export type FailedRecoveryManifest = z.infer<typeof failedRecoveryManifestSchema>;
export type VerifiedRecoveryManifest = z.infer<typeof verifiedRecoveryManifestSchema>;
export type RecoveryManifest = z.infer<typeof recoveryManifestSchema>;

export function recoveryArtifactKey(recoveryPointId: string): string {
  return `${RECOVERY_CATALOG_PREFIX}/database/${assertRecoveryPointId(recoveryPointId)}.dump`;
}

export function recoveryManifestKey(manifest: RecoveryManifest): string {
  return `${RECOVERY_CATALOG_PREFIX}/manifests/${manifest.state.toLowerCase()}/${manifest.recoveryPointId}.json`;
}

export function recoveryJobLockKey(): string {
  return `${RECOVERY_CATALOG_PREFIX}/locks/logical-backup.json`;
}

export function serializeRecoveryManifest(manifest: RecoveryManifest): Buffer {
  const parsed = recoveryManifestSchema.parse(manifest);
  const serialized = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
  if (serialized.byteLength > RECOVERY_MANIFEST_MAXIMUM_BYTES) {
    throw new Error('Recovery manifest exceeds the bounded size.');
  }
  return serialized;
}

export function parseRecoveryManifest(value: Buffer): RecoveryManifest {
  if (value.byteLength > RECOVERY_MANIFEST_MAXIMUM_BYTES) {
    throw new Error('Recovery manifest exceeds the bounded size.');
  }
  const parsed: unknown = JSON.parse(value.toString('utf8'));
  return recoveryManifestSchema.parse(parsed);
}

export function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertRecoveryPointId(value: string): string {
  return recoveryPointIdSchema.parse(value);
}
