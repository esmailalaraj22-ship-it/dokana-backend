import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { ATTACHMENT_MAX_BYTES } from '../../src/attachments/attachment.types';
import {
  ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
  attachmentRecoveryManifestDigest,
} from '../../src/recovery/attachment-recovery-manifest';
import { AttachmentRecoveryCatalogService } from '../../src/recovery/attachment-recovery-catalog.service';
import { RecoveryAttemptCatalogService } from '../../src/recovery/recovery-attempt-catalog.service';
import {
  recoveryAttemptAttachmentKey,
  type DatabaseRestoredRecoveryAttemptRecord,
  type RecoveryAttemptRecord,
} from '../../src/recovery/recovery-attempt';
import type { RecoveryArtifactStoragePort } from '../../src/recovery/recovery-artifact-storage.port';
import { RecoveryCatalogService } from '../../src/recovery/recovery-catalog.service';
import { serializeRecoveryManifest, sha256 } from '../../src/recovery/recovery-manifest';
import { readAttachmentRecoveryEntries } from './attachment-recovery-files';
import { readVerifiedMigrationState } from './migration-state';
import { restoreCustomFormatDump, type PostgresToolchain } from './postgres-tools';
import {
  activateRecoveryControl,
  databaseName,
  fenceRecoveryControl,
  readRecoveryControl,
  recoveryPool,
  verifyRecoveryTargetDatabase,
  withDatabase,
  type RecoveryControlState,
} from './recovery-target';
import { readRepresentativeRecoveryCounts } from './restore-smoke';
import { withLatestVerifiedArtifact } from './stored-recovery-verification';

const REQUIRED_RECOVERY_MIGRATION = '0033_platform_recovery_generation_fencing.sql';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface RecoveryExecutionDependencies {
  storage: RecoveryArtifactStoragePort;
  toolchain: PostgresToolchain;
  adminConnectionString: string;
  migrationConnectionString: string;
  runtimeConnectionString: string;
  applicationEnvironment: string;
  environmentId: string;
}

export interface RecoveryExecutionResult {
  recoveryAttemptId: string;
  recoveryPointId: string;
  phase: RecoveryAttemptRecord['phase'];
  targetDatabaseName: string;
  recoveryGenerationId?: string;
  authorityNotBefore?: string;
}

export class RecoveryExecutionService {
  private readonly catalog: RecoveryCatalogService;
  private readonly attachmentCatalog: AttachmentRecoveryCatalogService;
  private readonly attemptCatalog: RecoveryAttemptCatalogService;

  constructor(private readonly dependencies: RecoveryExecutionDependencies) {
    this.catalog = new RecoveryCatalogService(dependencies.storage);
    this.attachmentCatalog = new AttachmentRecoveryCatalogService(
      dependencies.storage,
      this.catalog,
    );
    this.attemptCatalog = new RecoveryAttemptCatalogService(dependencies.storage);
  }

  async prepare(recoveryPointId: string): Promise<RecoveryExecutionResult> {
    this.assertLocalExecutionBoundary();
    const databaseEntry = await this.catalog.readVerifiedRecoveryPoint(recoveryPointId);
    const attachmentManifest = await this.attachmentCatalog.readVerifiedManifest(
      recoveryPointId,
      databaseEntry ?? undefined,
    );
    if (!databaseEntry || !attachmentManifest) {
      throw new Error('A coherent verified recovery point is required.');
    }
    const sourceMigrations = await readVerifiedMigrationState(
      this.dependencies.adminConnectionString,
    );
    if (
      sourceMigrations.appliedCount !== databaseEntry.manifest.migrations.appliedCount ||
      sourceMigrations.latestFilename !== databaseEntry.manifest.migrations.latestFilename ||
      sourceMigrations.checksumAggregateSha256 !==
        databaseEntry.manifest.migrations.checksumAggregateSha256 ||
      sourceMigrations.latestFilename !== REQUIRED_RECOVERY_MIGRATION
    ) {
      throw new Error('Recovery point is not compatible with the current recovery authority.');
    }
    const sourceAuthority = await readRecoveryControl(this.dependencies.migrationConnectionString);
    if (sourceAuthority.serviceState !== 'ACTIVE') {
      throw new Error('Recovery preparation requires the current platform authority to be ACTIVE.');
    }

    const lockToken = await this.catalog.acquireJobLock();
    const attemptId = randomUUID();
    const targetDatabaseName = targetName(attemptId);
    try {
      const state = await this.attemptCatalog.writePrepared({
        attemptVersion: '1',
        attemptId,
        recoveryPointId,
        phase: 'PREPARED',
        recordedAt: new Date().toISOString(),
        previousRecordSha256: null,
        lockToken,
        sourceDatabaseName: databaseName(this.dependencies.migrationConnectionString),
        targetDatabaseName,
        sourceRecoveryGenerationId: sourceAuthority.recoveryGenerationId,
        databaseManifestSha256: databaseEntry.manifestSha256,
        attachmentManifestSha256: attachmentRecoveryManifestDigest(attachmentManifest),
        recoveryPointCreatedAt: databaseEntry.manifest.createdAt,
        recoveryPointVerifiedAt: databaseEntry.manifest.verification.verifiedAt,
        migrationCount: databaseEntry.manifest.migrations.appliedCount,
        latestMigration: databaseEntry.manifest.migrations.latestFilename,
        sourceRevision: databaseEntry.manifest.sourceRevision,
      });
      return result(state.current, targetDatabaseName);
    } catch (error) {
      await this.catalog.releaseJobLock(lockToken).catch(() => undefined);
      throw error;
    }
  }

  async restoreDatabase(attemptId: string): Promise<RecoveryExecutionResult> {
    this.assertLocalExecutionBoundary();
    let state = await this.requiredAttempt(attemptId);
    if (hasReached(state.records, 'DATABASE_RESTORED')) {
      return result(state.current, state.prepared.targetDatabaseName);
    }
    if (!['PREPARED', 'SOURCE_FENCED'].includes(state.current.phase)) {
      throw new Error('Recovery attempt is not ready for database restore.');
    }
    await this.assertAttemptLock(state.prepared.lockToken);
    this.assertSourceIdentity(state.prepared.sourceDatabaseName);

    if (state.current.phase === 'PREPARED') {
      const fenced = await this.ensureSourceFenced(state.prepared.sourceRecoveryGenerationId);
      state = await this.attemptCatalog.append({
        attemptVersion: '1',
        attemptId,
        recoveryPointId: state.prepared.recoveryPointId,
        phase: 'SOURCE_FENCED',
        recordedAt: new Date().toISOString(),
        previousRecordSha256: state.recordSha256,
        recoveryGenerationId: fenced.recoveryGenerationId,
        fencedAt: requiredTimestamp(fenced.fencedAt, 'Source recovery fence timestamp is missing.'),
      });
    }

    const targetDatabaseName = state.prepared.targetDatabaseName;
    await this.removeUncommittedTarget(targetDatabaseName);
    let targetCreated = false;
    try {
      await this.createTarget(targetDatabaseName);
      targetCreated = true;
      await withLatestVerifiedArtifact({
        storage: this.dependencies.storage,
        toolchain: this.dependencies.toolchain,
        recoveryPointId: state.prepared.recoveryPointId,
        work: async ({ artifactPath, manifest }) => {
          if (
            sha256(serializeRecoveryManifest(manifest)) !== state.prepared.databaseManifestSha256
          ) {
            throw new Error('Recovery database manifest changed after preparation.');
          }
          await restoreCustomFormatDump(
            this.dependencies.toolchain,
            this.targetAdminUrl(targetDatabaseName),
            artifactPath,
          );
        },
      });

      const targetMigrationUrl = this.targetMigrationUrl(targetDatabaseName);
      const targetAuthority = await readRecoveryControl(targetMigrationUrl);
      if (
        targetAuthority.serviceState !== 'ACTIVE' ||
        targetAuthority.recoveryGenerationId !== state.prepared.sourceRecoveryGenerationId
      ) {
        throw new Error('Restored recovery authority does not match the selected source lineage.');
      }
      const targetFenced = await fenceRecoveryControl(
        targetMigrationUrl,
        targetAuthority.recoveryGenerationId,
      );
      const migrationState = await readVerifiedMigrationState(
        this.targetAdminUrl(targetDatabaseName),
      );
      if (
        migrationState.appliedCount !== state.prepared.migrationCount ||
        migrationState.latestFilename !== state.prepared.latestMigration ||
        migrationState.checksumAggregateSha256 !==
          (await this.requiredDatabaseManifest(state.prepared.recoveryPointId)).migrations
            .checksumAggregateSha256
      ) {
        throw new Error('Restored migration state does not match the recovery point.');
      }
      const targetPool = recoveryPool(
        this.targetAdminUrl(targetDatabaseName),
        'dokana_recovery_restore_counts',
      );
      let representativeCounts: Record<string, string>;
      try {
        representativeCounts = await readRepresentativeRecoveryCounts(targetPool);
      } finally {
        await targetPool.end();
      }
      state = await this.attemptCatalog.append({
        attemptVersion: '1',
        attemptId,
        recoveryPointId: state.prepared.recoveryPointId,
        phase: 'DATABASE_RESTORED',
        recordedAt: new Date().toISOString(),
        previousRecordSha256: state.recordSha256,
        targetRecoveryGenerationId: targetFenced.recoveryGenerationId,
        targetFencedAt: requiredTimestamp(
          targetFenced.fencedAt,
          'Target recovery fence timestamp is missing.',
        ),
        migrationCount: migrationState.appliedCount,
        latestMigration: migrationState.latestFilename,
        representativeCounts,
      });
      return result(state.current, targetDatabaseName);
    } catch (error) {
      if (targetCreated) await this.dropTarget(targetDatabaseName).catch(() => undefined);
      throw error;
    }
  }

  async restoreAttachments(attemptId: string): Promise<RecoveryExecutionResult> {
    this.assertLocalExecutionBoundary();
    let state = await this.requiredAttempt(attemptId);
    if (hasReached(state.records, 'ATTACHMENTS_RESTORED')) {
      return result(state.current, state.prepared.targetDatabaseName);
    }
    if (state.current.phase !== 'DATABASE_RESTORED') {
      throw new Error('Recovery attempt is not ready for attachment restore.');
    }
    await this.assertAttemptLock(state.prepared.lockToken);
    const databaseRecord = requiredRecord(state.records, 'DATABASE_RESTORED');
    await this.assertTargetFenced(state.prepared.targetDatabaseName, databaseRecord);
    const attachmentManifest = await this.attachmentCatalog.readVerifiedManifest(
      state.prepared.recoveryPointId,
    );
    if (
      !attachmentManifest ||
      attachmentRecoveryManifestDigest(attachmentManifest) !==
        state.prepared.attachmentManifestSha256
    ) {
      throw new Error('Recovery attachment manifest changed after preparation.');
    }
    const restored = await this.restoreAttachmentSet({
      attemptId,
      recoveryPointId: state.prepared.recoveryPointId,
      targetDatabaseName: state.prepared.targetDatabaseName,
      entriesKey: attachmentManifest.entries.key,
      entriesSha256: attachmentManifest.entries.sha256,
      expectedEntryCount: attachmentManifest.attachmentEntryCount,
      expectedTotalBytes: attachmentManifest.totalProtectedBytes,
    });
    state = await this.attemptCatalog.append({
      attemptVersion: '1',
      attemptId,
      recoveryPointId: state.prepared.recoveryPointId,
      phase: 'ATTACHMENTS_RESTORED',
      recordedAt: new Date().toISOString(),
      previousRecordSha256: state.recordSha256,
      attachmentEntryCount: restored.entryCount,
      totalProtectedBytes: restored.totalBytes,
      attachmentManifestSha256: state.prepared.attachmentManifestSha256,
    });
    return result(state.current, state.prepared.targetDatabaseName);
  }

  async verify(attemptId: string): Promise<RecoveryExecutionResult> {
    this.assertLocalExecutionBoundary();
    let state = await this.requiredAttempt(attemptId);
    if (hasReached(state.records, 'VERIFIED')) {
      return result(state.current, state.prepared.targetDatabaseName);
    }
    if (state.current.phase !== 'ATTACHMENTS_RESTORED') {
      throw new Error('Recovery attempt is not ready for verification.');
    }
    await this.assertAttemptLock(state.prepared.lockToken);
    const verification = await this.verifyAttemptState(state.records);
    const auditClassification = classifyAuditGap(
      verification.auditMissingDeviceReferenceCount,
      this.dependencies.environmentId,
    );
    state = await this.attemptCatalog.append({
      attemptVersion: '1',
      attemptId,
      recoveryPointId: state.prepared.recoveryPointId,
      phase: 'VERIFIED',
      recordedAt: new Date().toISOString(),
      previousRecordSha256: state.recordSha256,
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
      auditMissingDeviceReferenceCount: verification.auditMissingDeviceReferenceCount,
      auditMissingDeviceClassification: auditClassification,
    });
    return result(state.current, state.prepared.targetDatabaseName);
  }

  async approve(attemptId: string, recoveryPointId: string): Promise<RecoveryExecutionResult> {
    let state = await this.requiredAttempt(attemptId);
    if (hasReached(state.records, 'APPROVED')) {
      return result(state.current, state.prepared.targetDatabaseName);
    }
    if (state.current.phase !== 'VERIFIED' || recoveryPointId !== state.prepared.recoveryPointId) {
      throw new Error('Recovery approval is not bound to the verified recovery point.');
    }
    await this.assertAttemptLock(state.prepared.lockToken);
    state = await this.attemptCatalog.append({
      attemptVersion: '1',
      attemptId,
      recoveryPointId,
      phase: 'APPROVED',
      recordedAt: new Date().toISOString(),
      previousRecordSha256: state.recordSha256,
      approvedRecoveryPointId: recoveryPointId,
      verificationRecordSha256: state.recordSha256,
    });
    return result(state.current, state.prepared.targetDatabaseName);
  }

  async activate(attemptId: string, recoveryPointId: string): Promise<RecoveryExecutionResult> {
    this.assertLocalExecutionBoundary();
    let state = await this.requiredAttempt(attemptId);
    if (state.current.phase === 'ACTIVATED') {
      await this.catalog.releaseJobLock(state.prepared.lockToken);
      return result(state.current, state.prepared.targetDatabaseName);
    }
    if (state.current.phase !== 'APPROVED' || recoveryPointId !== state.prepared.recoveryPointId) {
      throw new Error('Recovery activation is not bound to an approved recovery attempt.');
    }
    await this.assertAttemptLock(state.prepared.lockToken);
    await this.verifyAttemptState(state.records);
    const databaseRecord = requiredRecord(state.records, 'DATABASE_RESTORED');
    const targetUrl = this.targetMigrationUrl(state.prepared.targetDatabaseName);
    let targetAuthority = await readRecoveryControl(targetUrl);
    if (targetAuthority.serviceState === 'FENCED') {
      if (targetAuthority.recoveryGenerationId !== databaseRecord.targetRecoveryGenerationId) {
        throw new Error('Recovery target generation changed before activation.');
      }
      targetAuthority = await activateRecoveryControl(
        targetUrl,
        databaseRecord.targetRecoveryGenerationId,
      );
    } else if (
      targetAuthority.recoveryGenerationId === databaseRecord.targetRecoveryGenerationId ||
      !targetAuthority.authorityNotBefore
    ) {
      throw new Error('Recovery target activation state is invalid.');
    }
    const source = await readRecoveryControl(this.dependencies.migrationConnectionString);
    if (
      source.serviceState !== 'FENCED' ||
      source.recoveryGenerationId !== state.prepared.sourceRecoveryGenerationId
    ) {
      throw new Error('Original platform authority is no longer safely fenced.');
    }
    state = await this.attemptCatalog.append({
      attemptVersion: '1',
      attemptId,
      recoveryPointId,
      phase: 'ACTIVATED',
      recordedAt: new Date().toISOString(),
      previousRecordSha256: state.recordSha256,
      previousRecoveryGenerationId: databaseRecord.targetRecoveryGenerationId,
      recoveryGenerationId: targetAuthority.recoveryGenerationId,
      authorityNotBefore: requiredTimestamp(
        targetAuthority.authorityNotBefore,
        'Recovery activation cutoff is missing.',
      ),
    });
    await this.catalog.releaseJobLock(state.prepared.lockToken);
    return result(
      state.current,
      state.prepared.targetDatabaseName,
      targetAuthority.recoveryGenerationId,
      targetAuthority.authorityNotBefore ?? undefined,
    );
  }

  async abortPrepared(attemptId: string): Promise<RecoveryExecutionResult> {
    let state = await this.requiredAttempt(attemptId);
    if (state.current.phase === 'ABORTED') {
      await this.catalog.releaseJobLock(state.prepared.lockToken);
      return result(state.current, state.prepared.targetDatabaseName);
    }
    if (state.current.phase !== 'PREPARED') {
      throw new Error('A fenced or restored recovery attempt cannot be cancelled automatically.');
    }
    await this.assertAttemptLock(state.prepared.lockToken);
    if (await this.targetExists(state.prepared.targetDatabaseName)) {
      throw new Error('Recovery target exists and cannot be cancelled as an unstarted attempt.');
    }
    state = await this.attemptCatalog.append({
      attemptVersion: '1',
      attemptId,
      recoveryPointId: state.prepared.recoveryPointId,
      phase: 'ABORTED',
      recordedAt: new Date().toISOString(),
      previousRecordSha256: state.recordSha256,
      reasonCode: 'PREPARE_CANCELLED',
    });
    await this.catalog.releaseJobLock(state.prepared.lockToken);
    return result(state.current, state.prepared.targetDatabaseName);
  }

  private async verifyAttemptState(records: readonly RecoveryAttemptRecord[]) {
    const prepared = requiredRecord(records, 'PREPARED');
    const databaseRecord = requiredRecord(records, 'DATABASE_RESTORED');
    const attachmentRecord = requiredRecord(records, 'ATTACHMENTS_RESTORED');
    await this.assertTargetFenced(prepared.targetDatabaseName, databaseRecord);
    const source = await readRecoveryControl(this.dependencies.migrationConnectionString);
    if (
      source.serviceState !== 'FENCED' ||
      source.recoveryGenerationId !== prepared.sourceRecoveryGenerationId
    ) {
      throw new Error('Original platform authority is not safely fenced.');
    }
    const migrations = await readVerifiedMigrationState(
      this.targetAdminUrl(prepared.targetDatabaseName),
    );
    const manifest = await this.requiredDatabaseManifest(prepared.recoveryPointId);
    if (
      migrations.appliedCount !== prepared.migrationCount ||
      migrations.latestFilename !== prepared.latestMigration ||
      migrations.checksumAggregateSha256 !== manifest.migrations.checksumAggregateSha256
    ) {
      throw new Error('Recovery target migration checksum verification failed.');
    }
    const verification = await verifyRecoveryTargetDatabase({
      adminConnectionString: this.targetAdminUrl(prepared.targetDatabaseName),
      runtimeConnectionString: this.targetRuntimeUrl(prepared.targetDatabaseName),
      expectedMigrationCount: prepared.migrationCount,
      expectedLatestMigration: prepared.latestMigration,
      expectedRecoveryGenerationId: databaseRecord.targetRecoveryGenerationId,
    });
    if (!equalCounts(verification.representativeCounts, databaseRecord.representativeCounts)) {
      throw new Error('Recovery verification detected an unexpected accounting data change.');
    }
    if (
      verification.auditMissingDeviceReferenceCount > 0 &&
      !isTestEnvironment(this.dependencies.environmentId)
    ) {
      throw new Error('Recovery verification detected a runtime audit device integrity defect.');
    }
    await this.verifyStagedAttachments({
      attemptId: prepared.attemptId,
      recoveryPointId: prepared.recoveryPointId,
      targetDatabaseName: prepared.targetDatabaseName,
      expectedEntryCount: attachmentRecord.attachmentEntryCount,
      expectedTotalBytes: attachmentRecord.totalProtectedBytes,
    });
    return verification;
  }

  private async restoreAttachmentSet(input: {
    attemptId: string;
    recoveryPointId: string;
    targetDatabaseName: string;
    entriesKey: string;
    entriesSha256: string;
    expectedEntryCount: number;
    expectedTotalBytes: string;
  }): Promise<{ entryCount: number; totalBytes: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'dokana-recovery-attachments-'));
    await chmod(directory, 0o700);
    const entriesPath = join(directory, 'entries.ndjson');
    const pool = recoveryPool(
      this.targetAdminUrl(input.targetDatabaseName),
      'dokana_recovery_attachment_restore',
    );
    try {
      const downloaded = await this.dependencies.storage.downloadToFile(
        input.entriesKey,
        entriesPath,
        ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
      );
      if (!downloaded) throw new Error('Recovery attachment entries are unavailable.');
      const metadata = await this.dependencies.storage.headObject(input.entriesKey);
      if (metadata?.checksumSha256 !== input.entriesSha256) {
        throw new Error('Recovery attachment entries failed integrity verification.');
      }
      let entryCount = 0;
      let totalBytes = 0n;
      for await (const entry of readAttachmentRecoveryEntries(entriesPath, input.recoveryPointId)) {
        await this.assertActiveAttachmentMetadata(pool, entry);
        const body = await this.dependencies.storage.readBuffer(
          entry.protectedObjectKey,
          ATTACHMENT_MAX_BYTES,
        );
        if (body?.byteLength !== Number(entry.sizeBytes) || sha256(body) !== entry.sha256) {
          throw new Error('Protected attachment failed recovery integrity verification.');
        }
        await this.putOrVerifyStagedAttachment({
          key: recoveryAttemptAttachmentKey({
            attemptId: input.attemptId,
            attachmentId: entry.attachmentId,
            sha256: entry.sha256,
          }),
          body,
          sha256: entry.sha256,
        });
        entryCount += 1;
        totalBytes += BigInt(entry.sizeBytes);
      }
      const active = await pool.query<{ count: number }>(`
        select count(*)::integer as count from ledger.attachments where removed_at is null
      `);
      if (
        active.rows[0]?.count !== entryCount ||
        input.expectedEntryCount !== entryCount ||
        input.expectedTotalBytes !== totalBytes.toString()
      ) {
        throw new Error('Recovery attachment set is incomplete.');
      }
      return { entryCount, totalBytes: totalBytes.toString() };
    } finally {
      await Promise.all([pool.end(), rm(directory, { recursive: true, force: true })]);
    }
  }

  private async verifyStagedAttachments(input: {
    attemptId: string;
    recoveryPointId: string;
    targetDatabaseName: string;
    expectedEntryCount: number;
    expectedTotalBytes: string;
  }): Promise<void> {
    const manifest = await this.attachmentCatalog.readVerifiedManifest(input.recoveryPointId);
    if (!manifest) throw new Error('Recovery attachment manifest is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'dokana-recovery-attachment-verify-'));
    await chmod(directory, 0o700);
    const entriesPath = join(directory, 'entries.ndjson');
    const pool = recoveryPool(
      this.targetAdminUrl(input.targetDatabaseName),
      'dokana_recovery_attachment_verify',
    );
    try {
      const downloaded = await this.dependencies.storage.downloadToFile(
        manifest.entries.key,
        entriesPath,
        ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
      );
      if (!downloaded) throw new Error('Recovery attachment entries are unavailable.');
      let entryCount = 0;
      let totalBytes = 0n;
      for await (const entry of readAttachmentRecoveryEntries(entriesPath, input.recoveryPointId)) {
        await this.assertActiveAttachmentMetadata(pool, entry);
        const key = recoveryAttemptAttachmentKey({
          attemptId: input.attemptId,
          attachmentId: entry.attachmentId,
          sha256: entry.sha256,
        });
        const object = await this.dependencies.storage.headObject(key);
        if (
          object?.contentLength !== Number(entry.sizeBytes) ||
          object.checksumSha256 !== entry.sha256 ||
          !object.encryption
        ) {
          throw new Error('Staged recovery attachment failed integrity verification.');
        }
        entryCount += 1;
        totalBytes += BigInt(entry.sizeBytes);
      }
      const active = await pool.query<{ count: number }>(`
        select count(*)::integer as count from ledger.attachments where removed_at is null
      `);
      if (
        active.rows[0]?.count !== entryCount ||
        entryCount !== input.expectedEntryCount ||
        totalBytes.toString() !== input.expectedTotalBytes
      ) {
        throw new Error('Staged recovery attachment set is incomplete.');
      }
    } finally {
      await Promise.all([pool.end(), rm(directory, { recursive: true, force: true })]);
    }
  }

  private async assertActiveAttachmentMetadata(
    pool: Pool,
    entry: {
      attachmentId: string;
      mediaType: string;
      sizeBytes: string;
      sha256: string;
    },
  ): Promise<void> {
    const result = await pool.query<{
      mediaType: string | null;
      sizeBytes: string | null;
      sha256: string | null;
      removed: boolean;
    }>(
      `
      select mime_type as "mediaType", file_size_bytes::text as "sizeBytes",
             checksum_sha256 as sha256, removed_at is not null as removed
      from ledger.attachments where id=$1
    `,
      [entry.attachmentId],
    );
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      !row ||
      row.removed ||
      row.mediaType !== entry.mediaType ||
      row.sizeBytes !== entry.sizeBytes ||
      row.sha256 !== entry.sha256
    ) {
      throw new Error('Recovery attachment does not match active restored metadata.');
    }
  }

  private async putOrVerifyStagedAttachment(input: {
    key: string;
    body: Buffer;
    sha256: string;
  }): Promise<void> {
    const existing = await this.dependencies.storage.headObject(input.key);
    if (existing) {
      if (
        existing.contentLength !== input.body.byteLength ||
        existing.checksumSha256 !== input.sha256 ||
        !existing.encryption
      ) {
        throw new Error('Staged recovery attachment conflicts with existing evidence.');
      }
      return;
    }
    await this.dependencies.storage.putBuffer({
      key: input.key,
      body: input.body,
      contentType: 'application/octet-stream',
      contentLength: input.body.byteLength,
      checksumSha256: input.sha256,
    });
  }

  private async ensureSourceFenced(expectedGenerationId: string): Promise<RecoveryControlState> {
    const current = await readRecoveryControl(this.dependencies.migrationConnectionString);
    if (current.recoveryGenerationId !== expectedGenerationId) {
      throw new Error('Source recovery generation changed after preparation.');
    }
    if (current.serviceState === 'FENCED') return current;
    return fenceRecoveryControl(this.dependencies.migrationConnectionString, expectedGenerationId);
  }

  private async assertTargetFenced(
    targetDatabaseName: string,
    record: DatabaseRestoredRecoveryAttemptRecord,
  ): Promise<void> {
    const target = await readRecoveryControl(this.targetMigrationUrl(targetDatabaseName));
    if (
      target.serviceState !== 'FENCED' ||
      target.recoveryGenerationId !== record.targetRecoveryGenerationId
    ) {
      throw new Error('Recovery target is not safely fenced.');
    }
  }

  private async requiredDatabaseManifest(recoveryPointId: string) {
    const entry = await this.catalog.readVerifiedRecoveryPoint(recoveryPointId);
    if (!entry) throw new Error('Verified recovery point is unavailable.');
    return entry.manifest;
  }

  private async requiredAttempt(attemptId: string) {
    const state = await this.attemptCatalog.readAttempt(attemptId);
    if (!state) throw new Error('Recovery attempt is unavailable.');
    return state;
  }

  private assertSourceIdentity(expectedDatabaseName: string): void {
    if (databaseName(this.dependencies.migrationConnectionString) !== expectedDatabaseName) {
      throw new Error('Recovery source database identity changed after preparation.');
    }
  }

  private async assertAttemptLock(token: string): Promise<void> {
    await this.catalog.assertJobLockOwnership(token);
  }

  private assertLocalExecutionBoundary(): void {
    if (this.dependencies.applicationEnvironment === 'production') {
      throw new Error('Production cutover execution remains an S23 deployment gate.');
    }
    const urls = [
      this.dependencies.adminConnectionString,
      this.dependencies.migrationConnectionString,
      this.dependencies.runtimeConnectionString,
    ].map((value) => new URL(value));
    const names = urls.map((value) => decodeURIComponent(value.pathname.slice(1)));
    if (
      urls.some(
        (value) =>
          !['postgres:', 'postgresql:'].includes(value.protocol) ||
          !LOCAL_HOSTS.has(value.hostname),
      ) ||
      names.some((value) => !value || value !== names[0]) ||
      decodeURIComponent(urls[1]?.username ?? '') !== 'dokana_migration_login' ||
      decodeURIComponent(urls[2]?.username ?? '') !== 'dokana_runtime_login'
    ) {
      throw new Error('Recovery execution requires the approved local role-separated database.');
    }
  }

  private targetAdminUrl(targetDatabaseName: string): string {
    return withDatabase(this.dependencies.adminConnectionString, targetDatabaseName);
  }

  private targetMigrationUrl(targetDatabaseName: string): string {
    return withDatabase(this.dependencies.migrationConnectionString, targetDatabaseName);
  }

  private targetRuntimeUrl(targetDatabaseName: string): string {
    return withDatabase(this.dependencies.runtimeConnectionString, targetDatabaseName);
  }

  private async createTarget(targetDatabaseName: string): Promise<void> {
    assertTargetName(targetDatabaseName);
    const management = recoveryPool(
      withDatabase(this.dependencies.adminConnectionString, 'postgres'),
      'dokana_recovery_target_create',
    );
    try {
      if (await databaseExists(management, targetDatabaseName)) {
        throw new Error('Recovery target database already exists.');
      }
      await management.query(`create database "${targetDatabaseName}" template template0`);
    } finally {
      await management.end();
    }
  }

  private async removeUncommittedTarget(targetDatabaseName: string): Promise<void> {
    if (await this.targetExists(targetDatabaseName)) await this.dropTarget(targetDatabaseName);
  }

  private async targetExists(targetDatabaseName: string): Promise<boolean> {
    assertTargetName(targetDatabaseName);
    const management = recoveryPool(
      withDatabase(this.dependencies.adminConnectionString, 'postgres'),
      'dokana_recovery_target_exists',
    );
    try {
      return await databaseExists(management, targetDatabaseName);
    } finally {
      await management.end();
    }
  }

  private async dropTarget(targetDatabaseName: string): Promise<void> {
    assertTargetName(targetDatabaseName);
    if (targetDatabaseName === databaseName(this.dependencies.adminConnectionString)) {
      throw new Error('Recovery target collides with the current authoritative database.');
    }
    const management = recoveryPool(
      withDatabase(this.dependencies.adminConnectionString, 'postgres'),
      'dokana_recovery_target_cleanup',
    );
    try {
      await management.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where datname=$1 and pid<>pg_backend_pid()`,
        [targetDatabaseName],
      );
      await management.query(`drop database if exists "${targetDatabaseName}"`);
    } finally {
      await management.end();
    }
  }
}

function requiredRecord<P extends RecoveryAttemptRecord['phase']>(
  records: readonly RecoveryAttemptRecord[],
  phase: P,
): Extract<RecoveryAttemptRecord, { phase: P }> {
  const record = records.find((item) => item.phase === phase);
  if (!record) throw new Error(`Recovery attempt is missing ${phase} evidence.`);
  return record as Extract<RecoveryAttemptRecord, { phase: P }>;
}

function hasReached(
  records: readonly RecoveryAttemptRecord[],
  phase: RecoveryAttemptRecord['phase'],
): boolean {
  return records.some((record) => record.phase === phase);
}

function targetName(attemptId: string): string {
  return `dokana_recovery_${attemptId.replaceAll('-', '')}`;
}

function assertTargetName(value: string): void {
  if (!/^dokana_recovery_[0-9a-f]{32}$/.test(value)) {
    throw new Error('Recovery target database identity is invalid.');
  }
}

async function databaseExists(pool: Pool, value: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `select exists(select 1 from pg_database where datname=$1) as exists`,
    [value],
  );
  return result.rows[0]?.exists === true;
}

function requiredTimestamp(value: string | null, message: string): string {
  if (!value) throw new Error(message);
  return new Date(value).toISOString();
}

function equalCounts(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => left[key] === right[key]);
}

function classifyAuditGap(
  count: number,
  environmentId: string,
): 'NONE' | 'OPTIONAL_HISTORICAL_REFERENCE' | 'TEST_FIXTURE_DEFECT' {
  if (count === 0) return 'NONE';
  if (isTestEnvironment(environmentId)) return 'TEST_FIXTURE_DEFECT';
  return 'OPTIONAL_HISTORICAL_REFERENCE';
}

function isTestEnvironment(environmentId: string): boolean {
  return /(^|[-_.])(test|integration)([-_.]|$)/i.test(environmentId);
}

function result(
  record: RecoveryAttemptRecord,
  targetDatabaseName: string,
  recoveryGenerationId?: string,
  authorityNotBefore?: string,
): RecoveryExecutionResult {
  return {
    recoveryAttemptId: record.attemptId,
    recoveryPointId: record.recoveryPointId,
    phase: record.phase,
    targetDatabaseName,
    ...(recoveryGenerationId ? { recoveryGenerationId } : {}),
    ...(authorityNotBefore ? { authorityNotBefore } : {}),
  };
}
