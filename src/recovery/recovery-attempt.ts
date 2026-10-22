import { createHash } from 'node:crypto';

import { z } from 'zod';

import { RECOVERY_CATALOG_PREFIX } from './recovery-manifest';

export const RECOVERY_ATTEMPT_VERSION = '1' as const;
export const RECOVERY_ATTEMPT_RECORD_MAXIMUM_BYTES = 64 * 1024;

const uuidSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const databaseNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/);
const recoveryTargetDatabaseNameSchema = z.string().regex(/^dokana_recovery_[0-9a-f]{32}$/);
const migrationFilenameSchema = z.string().regex(/^[0-9]{4}_[a-z0-9_]+\.sql$/);
const decimalCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

const baseRecordSchema = z.object({
  attemptVersion: z.literal(RECOVERY_ATTEMPT_VERSION),
  attemptId: uuidSchema,
  recoveryPointId: uuidSchema,
  recordedAt: timestampSchema,
  previousRecordSha256: sha256Schema.nullable(),
});

export const preparedRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('PREPARED'),
  lockToken: uuidSchema,
  sourceDatabaseName: databaseNameSchema,
  targetDatabaseName: recoveryTargetDatabaseNameSchema,
  sourceRecoveryGenerationId: uuidSchema,
  databaseManifestSha256: sha256Schema,
  attachmentManifestSha256: sha256Schema,
  recoveryPointCreatedAt: timestampSchema,
  recoveryPointVerifiedAt: timestampSchema,
  migrationCount: z.number().int().positive(),
  latestMigration: migrationFilenameSchema,
  sourceRevision: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
});

export const sourceFencedRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('SOURCE_FENCED'),
  recoveryGenerationId: uuidSchema,
  fencedAt: timestampSchema,
});

export const databaseRestoredRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('DATABASE_RESTORED'),
  targetRecoveryGenerationId: uuidSchema,
  targetFencedAt: timestampSchema,
  migrationCount: z.number().int().positive(),
  latestMigration: migrationFilenameSchema,
  representativeCounts: z.record(z.string(), decimalCountSchema),
});

export const attachmentsRestoredRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('ATTACHMENTS_RESTORED'),
  attachmentEntryCount: z.number().int().nonnegative(),
  totalProtectedBytes: decimalCountSchema,
  attachmentManifestSha256: sha256Schema,
});

export const verifiedRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('VERIFIED'),
  databaseChecks: z.object({
    migrations: z.literal('PASS'),
    checksums: z.literal('PASS'),
    constraints: z.literal('PASS'),
    indexes: z.literal('PASS'),
    rls: z.literal('PASS'),
    functions: z.literal('PASS'),
    triggers: z.literal('PASS'),
    runtimePrivileges: z.literal('PASS'),
    recoveryAuthority: z.literal('FENCED'),
    currentServerTime: z.literal('PASS'),
  }),
  attachmentChecks: z.object({
    completeness: z.literal('PASS'),
    digests: z.literal('PASS'),
    removedResurrectionCount: z.literal(0),
  }),
  accountingDeltaCount: z.literal(0),
  auditMissingDeviceReferenceCount: z.number().int().nonnegative(),
  auditMissingDeviceClassification: z.enum([
    'NONE',
    'OPTIONAL_HISTORICAL_REFERENCE',
    'TEST_FIXTURE_DEFECT',
  ]),
});

export const approvedRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('APPROVED'),
  approvedRecoveryPointId: uuidSchema,
  verificationRecordSha256: sha256Schema,
});

export const activatedRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('ACTIVATED'),
  previousRecoveryGenerationId: uuidSchema,
  recoveryGenerationId: uuidSchema,
  authorityNotBefore: timestampSchema,
});

export const abortedRecoveryAttemptRecordSchema = baseRecordSchema.extend({
  phase: z.literal('ABORTED'),
  reasonCode: z.enum(['PREPARE_CANCELLED', 'TARGET_RESTORE_FAILED']),
});

export const recoveryAttemptRecordSchema = z.discriminatedUnion('phase', [
  preparedRecoveryAttemptRecordSchema,
  sourceFencedRecoveryAttemptRecordSchema,
  databaseRestoredRecoveryAttemptRecordSchema,
  attachmentsRestoredRecoveryAttemptRecordSchema,
  verifiedRecoveryAttemptRecordSchema,
  approvedRecoveryAttemptRecordSchema,
  activatedRecoveryAttemptRecordSchema,
  abortedRecoveryAttemptRecordSchema,
]);

export type PreparedRecoveryAttemptRecord = z.infer<typeof preparedRecoveryAttemptRecordSchema>;
export type DatabaseRestoredRecoveryAttemptRecord = z.infer<
  typeof databaseRestoredRecoveryAttemptRecordSchema
>;
export type RecoveryAttemptRecord = z.infer<typeof recoveryAttemptRecordSchema>;
export type RecoveryAttemptPhase = RecoveryAttemptRecord['phase'];

export const RECOVERY_ATTEMPT_ORDER: readonly RecoveryAttemptPhase[] = [
  'PREPARED',
  'SOURCE_FENCED',
  'DATABASE_RESTORED',
  'ATTACHMENTS_RESTORED',
  'VERIFIED',
  'APPROVED',
  'ACTIVATED',
];

const RECORD_FILENAMES: Readonly<Record<RecoveryAttemptPhase, string>> = {
  PREPARED: '00-prepared.json',
  SOURCE_FENCED: '01-source-fenced.json',
  DATABASE_RESTORED: '02-database-restored.json',
  ATTACHMENTS_RESTORED: '03-attachments-restored.json',
  VERIFIED: '04-verified.json',
  APPROVED: '05-approved.json',
  ACTIVATED: '06-activated.json',
  ABORTED: '99-aborted.json',
};

export function recoveryAttemptRecordKey(attemptId: string, phase: RecoveryAttemptPhase): string {
  return `${RECOVERY_CATALOG_PREFIX}/attempts/${uuidSchema.parse(attemptId)}/events/${RECORD_FILENAMES[phase]}`;
}

export function recoveryAttemptAttachmentKey(input: {
  attemptId: string;
  attachmentId: string;
  sha256: string;
}): string {
  return `${RECOVERY_CATALOG_PREFIX}/attempts/${uuidSchema.parse(input.attemptId)}/restored-attachments/${uuidSchema.parse(input.attachmentId)}/${sha256Schema.parse(input.sha256)}.bin`;
}

export function serializeRecoveryAttemptRecord(record: RecoveryAttemptRecord): Buffer {
  const parsed = recoveryAttemptRecordSchema.parse(record);
  const body = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
  if (body.byteLength > RECOVERY_ATTEMPT_RECORD_MAXIMUM_BYTES) {
    throw new Error('Recovery attempt record exceeds the bounded size.');
  }
  return body;
}

export function parseRecoveryAttemptRecord(body: Buffer): RecoveryAttemptRecord {
  if (body.byteLength > RECOVERY_ATTEMPT_RECORD_MAXIMUM_BYTES) {
    throw new Error('Recovery attempt record exceeds the bounded size.');
  }
  const value: unknown = JSON.parse(body.toString('utf8'));
  return recoveryAttemptRecordSchema.parse(value);
}

export function recoveryAttemptRecordSha256(record: RecoveryAttemptRecord): string {
  return createHash('sha256').update(serializeRecoveryAttemptRecord(record)).digest('hex');
}
