import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
  ATTACHMENT_RECOVERY_ORPHAN_DELETE_LIMIT,
  attachmentRecoveryEntriesKey,
  attachmentRecoveryInventoryKey,
  attachmentRecoveryManifestKey,
} from '../../src/recovery/attachment-recovery-manifest';
import { AttachmentRecoveryCatalogService } from '../../src/recovery/attachment-recovery-catalog.service';
import type { RecoveryArtifactStoragePort } from '../../src/recovery/recovery-artifact-storage.port';
import { RecoveryCatalogService } from '../../src/recovery/recovery-catalog.service';
import type { RecoveryRuntimeConfig } from '../../src/recovery/recovery-config';
import {
  RECOVERY_CATALOG_PREFIX,
  type VerifiedRecoveryManifest,
} from '../../src/recovery/recovery-manifest';
import { readAttachmentRecoveryEntries } from './attachment-recovery-files';
import { sha256File } from './recovery-point-job';

const RECOVERY_POINT_DELETE_LIMIT = 25;
const PROTECTED_OBJECT_SCAN_LIMIT = 10_000;
const STORAGE_PAGE_SIZE = 1_000;

export interface AttachmentRecoveryCleanupResult {
  recoveryPointsDeleted: number;
  recoveryPointsRetained: number;
  protectedObjectsDeleted: number;
  protectedObjectsExamined: number;
  protectedObjectScanComplete: boolean;
}

export async function cleanupAttachmentRecovery(input: {
  storage: RecoveryArtifactStoragePort;
  config: RecoveryRuntimeConfig;
  now?: Date;
}): Promise<AttachmentRecoveryCleanupResult> {
  const databaseCatalog = new RecoveryCatalogService(input.storage);
  const attachmentCatalog = new AttachmentRecoveryCatalogService(input.storage, databaseCatalog);
  const lockToken = await databaseCatalog.acquireJobLock();
  let directory: string | null = null;
  try {
    directory = await mkdtemp(join(tmpdir(), 'dokana-recovery-cleanup-'));
    await chmod(directory, 0o700);
    const plan = await databaseCatalog.planRetention(input.now ?? new Date());
    const deleting = plan.expired.slice(0, RECOVERY_POINT_DELETE_LIMIT);
    const survivors = [...plan.retained, ...plan.expired.slice(RECOVERY_POINT_DELETE_LIMIT)];
    const referencedProtectedObjects = await readProtectedReferences({
      directory,
      survivors,
      storage: input.storage,
      attachmentCatalog,
    });

    for (const manifest of deleting) {
      await input.storage.deleteObject(attachmentRecoveryManifestKey(manifest.recoveryPointId));
      await input.storage.deleteObject(attachmentRecoveryEntriesKey(manifest.recoveryPointId));
      await input.storage.deleteObject(attachmentRecoveryInventoryKey(manifest.recoveryPointId));
      await databaseCatalog.deleteRecoveryPoint(manifest);
    }

    const orphanResult = await deleteUnreferencedProtectedObjects({
      storage: input.storage,
      referencedProtectedObjects,
      now: input.now ?? new Date(),
      graceHours: input.config.attachmentOrphanGraceHours,
    });
    return {
      recoveryPointsDeleted: deleting.length,
      recoveryPointsRetained: survivors.length,
      protectedObjectsDeleted: orphanResult.deleted,
      protectedObjectsExamined: orphanResult.examined,
      protectedObjectScanComplete: orphanResult.complete,
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    await databaseCatalog.releaseJobLock(lockToken);
  }
}

async function readProtectedReferences(input: {
  directory: string;
  survivors: VerifiedRecoveryManifest[];
  storage: RecoveryArtifactStoragePort;
  attachmentCatalog: AttachmentRecoveryCatalogService;
}): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const databaseManifest of input.survivors) {
    const attachmentManifest = await input.attachmentCatalog.readVerifiedManifest(
      databaseManifest.recoveryPointId,
    );
    if (!attachmentManifest) {
      throw new Error('Retained database recovery point lacks a valid attachment manifest.');
    }
    const path = join(input.directory, `${databaseManifest.recoveryPointId}.entries.ndjson`);
    const downloaded = await input.storage.downloadToFile(
      attachmentManifest.entries.key,
      path,
      ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
    );
    if (!downloaded) throw new Error('Retained attachment recovery entries are missing.');
    const details = await stat(path);
    if (
      details.size !== attachmentManifest.entries.sizeBytes ||
      (await sha256File(path)) !== attachmentManifest.entries.sha256
    ) {
      throw new Error('Retained attachment recovery entries failed integrity verification.');
    }
    for await (const entry of readAttachmentRecoveryEntries(
      path,
      databaseManifest.recoveryPointId,
    )) {
      referenced.add(entry.protectedObjectKey);
    }
  }
  return referenced;
}

async function deleteUnreferencedProtectedObjects(input: {
  storage: RecoveryArtifactStoragePort;
  referencedProtectedObjects: ReadonlySet<string>;
  now: Date;
  graceHours: number;
}): Promise<{ deleted: number; examined: number; complete: boolean }> {
  const prefix = `${RECOVERY_CATALOG_PREFIX}/protected-attachments/`;
  const graceThreshold = input.now.getTime() - input.graceHours * 60 * 60 * 1_000;
  let continuationToken: string | null = null;
  let examined = 0;
  let deleted = 0;
  do {
    const page = await input.storage.listObjects({
      prefix,
      limit: STORAGE_PAGE_SIZE,
      continuationToken,
    });
    for (const object of page.objects) {
      examined += 1;
      if (
        deleted < ATTACHMENT_RECOVERY_ORPHAN_DELETE_LIMIT &&
        !input.referencedProtectedObjects.has(object.key) &&
        object.lastModified.getTime() <= graceThreshold
      ) {
        await input.storage.deleteObject(object.key);
        deleted += 1;
      }
      if (examined >= PROTECTED_OBJECT_SCAN_LIMIT) {
        return { deleted, examined, complete: page.nextToken === null };
      }
    }
    continuationToken = page.nextToken;
  } while (continuationToken !== null && deleted < ATTACHMENT_RECOVERY_ORPHAN_DELETE_LIMIT);
  return { deleted, examined, complete: continuationToken === null };
}
