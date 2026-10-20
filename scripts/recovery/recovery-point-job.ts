import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RecoveryRuntimeConfig } from '../../src/recovery/recovery-config';
import type { RecoveryArtifactStoragePort } from '../../src/recovery/recovery-artifact-storage.port';
import { RecoveryCatalogService } from '../../src/recovery/recovery-catalog.service';
import {
  ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
  attachmentRecoveryInventoryKey,
} from '../../src/recovery/attachment-recovery-manifest';
import {
  RECOVERY_ARTIFACT_MAXIMUM_BYTES,
  recoveryArtifactKey,
  type FailedRecoveryManifest,
  type VerifiedRecoveryManifest,
} from '../../src/recovery/recovery-manifest';
import {
  assertCompleteDokanaArchiveList,
  listCustomFormatDump,
  readPgDumpVersion,
  type PostgresToolchain,
} from './postgres-tools';
import { createDumpWithAttachmentSnapshot } from './attachment-recovery-inventory';
import {
  equalMigrationState,
  readVerifiedMigrationState,
  type VerifiedMigrationState,
} from './migration-state';

export interface RecoveryPointJobInput {
  connectionString: string;
  config: RecoveryRuntimeConfig;
  storage: RecoveryArtifactStoragePort;
  toolchain: PostgresToolchain;
  now?: Date;
}

export async function createVerifiedRecoveryPoint(
  input: RecoveryPointJobInput,
): Promise<VerifiedRecoveryManifest> {
  const catalog = new RecoveryCatalogService(input.storage);
  const recoveryPointId = randomUUID();
  const createdAt = input.now ?? new Date();
  const base = {
    manifestVersion: '1' as const,
    recoveryPointId,
    createdAt: createdAt.toISOString(),
    environmentId: input.config.environmentId,
    sourceRevision: input.config.sourceRevision,
    backupType: 'postgresql-custom' as const,
  };
  const lockToken = await catalog.acquireJobLock();
  let temporaryDirectory: string | null = null;
  let phase: FailedRecoveryManifest['failureClass'] = 'POSTGRES_BACKUP_FAILED';
  try {
    await catalog.writeManifest({ ...base, state: 'CREATING' });
    const before = await readVerifiedMigrationState(input.connectionString);
    const toolVersion = await readPgDumpVersion(input.toolchain);
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'dokana-recovery-'));
    await chmod(temporaryDirectory, 0o700);
    const localArtifact = join(temporaryDirectory, `${recoveryPointId}.dump`);
    const localInventory = join(temporaryDirectory, `${recoveryPointId}.attachments.ndjson`);
    phase = 'ATTACHMENT_INVENTORY_CAPTURE_FAILED';
    await createDumpWithAttachmentSnapshot({
      connectionString: input.connectionString,
      toolchain: input.toolchain,
      dumpPath: localArtifact,
      inventoryPath: localInventory,
      recoveryPointId,
      createdAt,
      batchSize: input.config.attachmentBatchSize,
    });
    phase = 'BACKUP_ARTIFACT_INVALID';
    const details = await stat(localArtifact);
    if (!details.isFile() || details.size <= 0 || details.size > RECOVERY_ARTIFACT_MAXIMUM_BYTES) {
      throw new Error('PostgreSQL backup artifact has an invalid size.');
    }
    const digest = await sha256File(localArtifact);
    const list = await listCustomFormatDump(input.toolchain, localArtifact);
    assertCompleteDokanaArchiveList(list);
    const after = await readVerifiedMigrationState(input.connectionString);
    if (!equalMigrationState(before, after)) {
      throw new Error('Migration state changed while the recovery point was created.');
    }

    phase = 'BACKUP_UPLOAD_FAILED';
    const artifactKey = recoveryArtifactKey(recoveryPointId);
    await input.storage.putFile({
      key: artifactKey,
      sourcePath: localArtifact,
      contentType: 'application/vnd.postgresql.custom',
      contentLength: details.size,
      checksumSha256: digest,
    });

    phase = 'BACKUP_INTEGRITY_FAILED';
    const downloadedArtifact = join(temporaryDirectory, `${recoveryPointId}.stored.dump`);
    const downloaded = await input.storage.downloadToFile(
      artifactKey,
      downloadedArtifact,
      RECOVERY_ARTIFACT_MAXIMUM_BYTES,
    );
    if (!downloaded || (await sha256File(downloadedArtifact)) !== digest) {
      throw new Error('Stored PostgreSQL recovery artifact failed digest verification.');
    }
    assertCompleteDokanaArchiveList(
      await listCustomFormatDump(input.toolchain, downloadedArtifact),
    );

    phase = 'ATTACHMENT_INVENTORY_UPLOAD_FAILED';
    const inventoryDetails = await stat(localInventory);
    if (
      !inventoryDetails.isFile() ||
      inventoryDetails.size <= 0 ||
      inventoryDetails.size > ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES
    ) {
      throw new Error('Attachment recovery inventory has an invalid size.');
    }
    const inventoryDigest = await sha256File(localInventory);
    const inventoryKey = attachmentRecoveryInventoryKey(recoveryPointId);
    await input.storage.putFile({
      key: inventoryKey,
      sourcePath: localInventory,
      contentType: 'application/x-ndjson',
      contentLength: inventoryDetails.size,
      checksumSha256: inventoryDigest,
    });
    const downloadedInventory = join(
      temporaryDirectory,
      `${recoveryPointId}.stored.attachments.ndjson`,
    );
    const inventoryDownloaded = await input.storage.downloadToFile(
      inventoryKey,
      downloadedInventory,
      ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
    );
    if (!inventoryDownloaded || (await sha256File(downloadedInventory)) !== inventoryDigest) {
      throw new Error('Stored attachment recovery inventory failed digest verification.');
    }

    const retentionClass = await catalog.classifyRetention(createdAt);
    const verifiedAt = new Date();
    const manifest: VerifiedRecoveryManifest = {
      ...base,
      state: 'VERIFIED',
      completedAt: verifiedAt.toISOString(),
      artifact: { key: artifactKey, sizeBytes: details.size, sha256: digest },
      postgres: { serverVersion: after.serverVersion, toolVersion },
      migrations: migrationManifest(after),
      verification: {
        status: 'VERIFIED',
        structuralCheck: 'PASS',
        verifiedAt: verifiedAt.toISOString(),
      },
      retentionClass,
    };
    phase = 'BACKUP_MANIFEST_FAILED';
    await catalog.writeManifest(manifest);
    return manifest;
  } catch (error) {
    await catalog
      .writeManifest({
        ...base,
        state: 'FAILED',
        failedAt: new Date().toISOString(),
        failureClass: phase,
      })
      .catch(() => undefined);
    throw error;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await catalog.releaseJobLock(lockToken);
  }
}

export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    let bytesRead: number;
    do {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      bytesRead = result.bytesRead;
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function migrationManifest(state: VerifiedMigrationState): VerifiedRecoveryManifest['migrations'] {
  return {
    appliedCount: state.appliedCount,
    latestFilename: state.latestFilename,
    checksumStatus: 'PASS',
    checksumAggregateSha256: state.checksumAggregateSha256,
  };
}
