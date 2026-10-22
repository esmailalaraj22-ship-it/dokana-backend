import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemRecoveryArtifactStorage } from './filesystem-recovery-artifact-storage';
import { RecoveryAttemptCatalogService } from './recovery-attempt-catalog.service';
import { RecoveryCatalogService } from './recovery-catalog.service';

describe('RecoveryAttemptCatalogService', () => {
  let root: string;
  let storage: FilesystemRecoveryArtifactStorage;
  let attempts: RecoveryAttemptCatalogService;
  let catalog: RecoveryCatalogService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dokana-recovery-attempt-'));
    storage = new FilesystemRecoveryArtifactStorage(root);
    attempts = new RecoveryAttemptCatalogService(storage);
    catalog = new RecoveryCatalogService(storage);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists an immutable hash-linked recovery lifecycle across service restarts', async () => {
    const lockToken = await catalog.acquireJobLock();
    let state = await attempts.writePrepared(prepared(lockToken));
    state = await attempts.append({
      ...base('SOURCE_FENCED', state.recordSha256),
      recoveryGenerationId: sourceGenerationId,
      fencedAt: '2026-10-21T08:01:00.000Z',
    });
    state = await attempts.append({
      ...base('DATABASE_RESTORED', state.recordSha256),
      targetRecoveryGenerationId: sourceGenerationId,
      targetFencedAt: '2026-10-21T08:02:00.000Z',
      migrationCount: 33,
      latestMigration: '0033_platform_recovery_generation_fencing.sql',
      representativeCounts: { sales: '0' },
    });
    state = await attempts.append({
      ...base('ATTACHMENTS_RESTORED', state.recordSha256),
      attachmentEntryCount: 0,
      totalProtectedBytes: '0',
      attachmentManifestSha256: 'b'.repeat(64),
    });
    state = await attempts.append({
      ...base('VERIFIED', state.recordSha256),
      databaseChecks: {
        migrations: 'PASS',
        checksums: 'PASS',
        constraints: 'PASS',
        indexes: 'PASS',
        rls: 'PASS',
        functions: 'PASS',
        triggers: 'PASS',
        runtimePrivileges: 'PASS',
        recoveryAuthority: 'FENCED',
        currentServerTime: 'PASS',
      },
      attachmentChecks: {
        completeness: 'PASS',
        digests: 'PASS',
        removedResurrectionCount: 0,
      },
      accountingDeltaCount: 0,
      auditMissingDeviceReferenceCount: 0,
      auditMissingDeviceClassification: 'NONE',
    });
    const verificationDigest = state.recordSha256;
    state = await attempts.append({
      ...base('APPROVED', state.recordSha256),
      approvedRecoveryPointId: recoveryPointId,
      verificationRecordSha256: verificationDigest,
    });
    state = await attempts.append({
      ...base('ACTIVATED', state.recordSha256),
      previousRecoveryGenerationId: sourceGenerationId,
      recoveryGenerationId: '62000000-0000-4000-8000-000000000005',
      authorityNotBefore: '2026-10-21T08:05:00.000Z',
    });

    const restarted = new RecoveryAttemptCatalogService(storage);
    const restartedState = await restarted.readAttempt(attemptId);
    expect(restartedState?.current.phase).toBe('ACTIVATED');
    expect(restartedState?.records.map((record) => record.phase)).toEqual([
      'PREPARED',
      'SOURCE_FENCED',
      'DATABASE_RESTORED',
      'ATTACHMENTS_RESTORED',
      'VERIFIED',
      'APPROVED',
      'ACTIVATED',
    ]);
    await expect(
      restarted.append({
        ...base('ABORTED', state.recordSha256),
        reasonCode: 'PREPARE_CANCELLED',
      }),
    ).rejects.toThrow('terminal');
    await catalog.releaseJobLock(lockToken);
  });

  it('rejects phase skipping and serializes recovery operations with the shared lock', async () => {
    const lockToken = await catalog.acquireJobLock();
    const state = await attempts.writePrepared(prepared(lockToken));
    await expect(catalog.acquireJobLock()).rejects.toThrow('already active');
    await expect(
      attempts.append({
        ...base('DATABASE_RESTORED', state.recordSha256),
        targetRecoveryGenerationId: sourceGenerationId,
        targetFencedAt: '2026-10-21T08:02:00.000Z',
        migrationCount: 33,
        latestMigration: '0033_platform_recovery_generation_fencing.sql',
        representativeCounts: { sales: '0' },
      }),
    ).rejects.toThrow('transition');
    await catalog.assertJobLockOwnership(lockToken);
    await expect(catalog.assertJobLockOwnership(attemptId)).rejects.toThrow('ownership');
    await catalog.releaseJobLock(lockToken);
  });
});

const attemptId = '62000000-0000-4000-8000-000000000001';
const recoveryPointId = '62000000-0000-4000-8000-000000000002';
const sourceGenerationId = '62000000-0000-4000-8000-000000000003';

function prepared(lockToken: string) {
  return {
    ...base('PREPARED', null),
    lockToken,
    sourceDatabaseName: 'dokana_source',
    targetDatabaseName: 'dokana_recovery_62000000000040008000000000000001',
    sourceRecoveryGenerationId: sourceGenerationId,
    databaseManifestSha256: 'a'.repeat(64),
    attachmentManifestSha256: 'b'.repeat(64),
    recoveryPointCreatedAt: '2026-10-21T08:00:00.000Z',
    recoveryPointVerifiedAt: '2026-10-21T08:00:30.000Z',
    migrationCount: 33,
    latestMigration: '0033_platform_recovery_generation_fencing.sql',
    sourceRevision: null,
  } as const;
}

function base<
  P extends
    | 'PREPARED'
    | 'SOURCE_FENCED'
    | 'DATABASE_RESTORED'
    | 'ATTACHMENTS_RESTORED'
    | 'VERIFIED'
    | 'APPROVED'
    | 'ACTIVATED'
    | 'ABORTED',
>(phase: P, previousRecordSha256: string | null) {
  return {
    attemptVersion: '1' as const,
    attemptId,
    recoveryPointId,
    phase,
    recordedAt: '2026-10-21T08:00:00.000Z',
    previousRecordSha256,
  };
}
