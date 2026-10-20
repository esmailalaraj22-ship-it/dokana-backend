import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATTACHMENT_MAX_BYTES } from '../../src/attachments/attachment.types';
import type { AttachmentStoragePort } from '../../src/attachments/attachment-storage.port';
import {
  ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
  attachmentRecoveryEntriesKey,
  attachmentRecoveryInventoryKey,
  attachmentRecoveryEntryFooterSchema,
  attachmentRecoveryEntryHeaderSchema,
  attachmentRecoveryEntrySchema,
  protectedAttachmentObjectKey,
  protectedAttachmentPrefix,
  serializeNdjsonRecord,
  type AttachmentInventoryEntry,
  type AttachmentRecoveryEntry,
  type VerifiedAttachmentRecoveryManifest,
} from '../../src/recovery/attachment-recovery-manifest';
import { AttachmentRecoveryCatalogService } from '../../src/recovery/attachment-recovery-catalog.service';
import {
  RecoveryStorageConflictError,
  type RecoveryArtifactStoragePort,
} from '../../src/recovery/recovery-artifact-storage.port';
import { RecoveryCatalogService } from '../../src/recovery/recovery-catalog.service';
import type { RecoveryRuntimeConfig } from '../../src/recovery/recovery-config';
import { sha256, verifiedRecoveryManifestKey } from '../../src/recovery/recovery-manifest';
import {
  readAttachmentInventory,
  readAttachmentRecoveryEntries,
} from './attachment-recovery-files';
import { sha256File } from './recovery-point-job';

export interface AttachmentRecoveryJobInput {
  recoveryPointId: string;
  config: RecoveryRuntimeConfig;
  recoveryStorage: RecoveryArtifactStoragePort;
  sourceStorage: AttachmentStoragePort;
  now?: Date;
}

export interface AttachmentRecoveryVerificationResult {
  recoveryPointId: string;
  attachmentEntryCount: number;
  totalProtectedBytes: string;
  verifiedAt: string;
}

export async function protectAttachmentRecoveryPoint(
  input: AttachmentRecoveryJobInput,
): Promise<VerifiedAttachmentRecoveryManifest> {
  const databaseCatalog = new RecoveryCatalogService(input.recoveryStorage);
  const attachmentCatalog = new AttachmentRecoveryCatalogService(
    input.recoveryStorage,
    databaseCatalog,
  );
  const lockToken = await databaseCatalog.acquireJobLock();
  let temporaryDirectory: string | null = null;
  try {
    const database = await databaseCatalog.readVerifiedRecoveryPoint(input.recoveryPointId);
    if (!database) throw new Error('Verified database recovery point is unavailable.');

    const existing = await attachmentCatalog.readVerifiedManifest(input.recoveryPointId, database);
    if (existing) {
      await verifyAttachmentRecoveryPoint({
        recoveryPointId: input.recoveryPointId,
        recoveryStorage: input.recoveryStorage,
      });
      return existing;
    }

    temporaryDirectory = await mkdtemp(join(tmpdir(), 'dokana-attachment-recovery-'));
    await chmod(temporaryDirectory, 0o700);
    const inventoryPath = join(temporaryDirectory, 'inventory.ndjson');
    const inventory = await downloadVerifiedObject({
      storage: input.recoveryStorage,
      key: attachmentRecoveryInventoryKey(input.recoveryPointId),
      targetPath: inventoryPath,
      maximumBytes: ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
    });
    const entriesPath = join(temporaryDirectory, 'entries.ndjson');
    const entries = await open(entriesPath, 'wx', 0o600);
    let entryCount = 0;
    let totalProtectedBytes = 0n;
    try {
      await entries.write(
        serializeNdjsonRecord(
          attachmentRecoveryEntryHeaderSchema.parse({
            recordType: 'header',
            entriesVersion: '1',
            recoveryPointId: input.recoveryPointId,
          }),
        ),
      );
      let batch: AttachmentInventoryEntry[] = [];
      for await (const item of readAttachmentInventory(inventoryPath, input.recoveryPointId)) {
        batch.push(item);
        if (batch.length >= input.config.attachmentBatchSize) {
          const protectedEntries = await protectBatch(batch, input);
          for (const protectedEntry of protectedEntries) {
            await entries.write(serializeNdjsonRecord(protectedEntry));
            entryCount += 1;
            totalProtectedBytes += BigInt(protectedEntry.sizeBytes);
          }
          batch = [];
        }
      }
      if (batch.length > 0) {
        const protectedEntries = await protectBatch(batch, input);
        for (const protectedEntry of protectedEntries) {
          await entries.write(serializeNdjsonRecord(protectedEntry));
          entryCount += 1;
          totalProtectedBytes += BigInt(protectedEntry.sizeBytes);
        }
      }
      await entries.write(
        serializeNdjsonRecord(
          attachmentRecoveryEntryFooterSchema.parse({
            recordType: 'footer',
            attachmentEntryCount: entryCount,
            totalProtectedBytes: totalProtectedBytes.toString(),
          }),
        ),
      );
      await entries.sync();
    } finally {
      await entries.close();
    }

    const entriesDetails = await stat(entriesPath);
    if (
      !entriesDetails.isFile() ||
      entriesDetails.size <= 0 ||
      entriesDetails.size > ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES
    ) {
      throw new Error('Attachment recovery entries have an invalid size.');
    }
    const entriesSha256 = await sha256File(entriesPath);
    const entriesKey = attachmentRecoveryEntriesKey(input.recoveryPointId);
    try {
      await input.recoveryStorage.putFile({
        key: entriesKey,
        sourcePath: entriesPath,
        contentType: 'application/x-ndjson',
        contentLength: entriesDetails.size,
        checksumSha256: entriesSha256,
      });
    } catch (error) {
      if (!(error instanceof RecoveryStorageConflictError)) throw error;
    }
    const storedEntriesPath = join(temporaryDirectory, 'stored-entries.ndjson');
    await downloadVerifiedObject({
      storage: input.recoveryStorage,
      key: entriesKey,
      targetPath: storedEntriesPath,
      maximumBytes: ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
      expectedSha256: entriesSha256,
      expectedSize: entriesDetails.size,
    });
    for await (const entry of readAttachmentRecoveryEntries(
      storedEntriesPath,
      input.recoveryPointId,
    )) {
      // Exhaust the stream so its footer, totals, and trailing-data checks run.
      void entry;
    }

    const verifiedAt = (input.now ?? new Date()).toISOString();
    const manifest: VerifiedAttachmentRecoveryManifest = {
      manifestVersion: '1',
      recoveryPointId: input.recoveryPointId,
      databaseManifest: {
        key: verifiedRecoveryManifestKey(input.recoveryPointId),
        sha256: database.manifestSha256,
      },
      databaseArtifactSha256: database.manifest.artifact.sha256,
      snapshotInventory: {
        method: 'SHARED_POSTGRESQL_SNAPSHOT',
        key: attachmentRecoveryInventoryKey(input.recoveryPointId),
        sizeBytes: inventory.sizeBytes,
        sha256: inventory.sha256,
      },
      createdAt: database.manifest.createdAt,
      verifiedAt,
      digestAlgorithm: 'SHA-256',
      verificationStatus: 'VERIFIED',
      attachmentEntryCount: entryCount,
      totalProtectedBytes: totalProtectedBytes.toString(),
      entries: { key: entriesKey, sizeBytes: entriesDetails.size, sha256: entriesSha256 },
    };
    await attachmentCatalog.writeVerifiedManifest(manifest);
    await verifyAttachmentRecoveryPoint({
      recoveryPointId: input.recoveryPointId,
      recoveryStorage: input.recoveryStorage,
    });
    return manifest;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await databaseCatalog.releaseJobLock(lockToken);
  }
}

export async function verifyAttachmentRecoveryPoint(input: {
  recoveryPointId: string;
  recoveryStorage: RecoveryArtifactStoragePort;
}): Promise<AttachmentRecoveryVerificationResult> {
  const databaseCatalog = new RecoveryCatalogService(input.recoveryStorage);
  const attachmentCatalog = new AttachmentRecoveryCatalogService(
    input.recoveryStorage,
    databaseCatalog,
  );
  const database = await databaseCatalog.readVerifiedRecoveryPoint(input.recoveryPointId);
  if (!database) throw new Error('Verified database recovery point is unavailable.');
  const manifest = await attachmentCatalog.readVerifiedManifest(input.recoveryPointId, database);
  if (!manifest)
    throw new Error('Verified attachment recovery manifest is unavailable or invalid.');

  const directory = await mkdtemp(join(tmpdir(), 'dokana-attachment-verify-'));
  await chmod(directory, 0o700);
  try {
    const inventoryPath = join(directory, 'inventory.ndjson');
    await downloadVerifiedObject({
      storage: input.recoveryStorage,
      key: manifest.snapshotInventory.key,
      targetPath: inventoryPath,
      maximumBytes: ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
      expectedSha256: manifest.snapshotInventory.sha256,
      expectedSize: manifest.snapshotInventory.sizeBytes,
    });
    const entriesPath = join(directory, 'entries.ndjson');
    await downloadVerifiedObject({
      storage: input.recoveryStorage,
      key: manifest.entries.key,
      targetPath: entriesPath,
      maximumBytes: ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
      expectedSha256: manifest.entries.sha256,
      expectedSize: manifest.entries.sizeBytes,
    });

    const inventory = readAttachmentInventory(inventoryPath, input.recoveryPointId);
    const entries = readAttachmentRecoveryEntries(entriesPath, input.recoveryPointId);
    let count = 0;
    let totalBytes = 0n;
    for (;;) {
      const [inventoryItem, protectedItem] = await Promise.all([inventory.next(), entries.next()]);
      if (inventoryItem.done || protectedItem.done) {
        if (inventoryItem.done !== protectedItem.done) {
          throw new Error('Attachment recovery inventory and protected entries differ.');
        }
        break;
      }
      assertMatchingEntry(inventoryItem.value, protectedItem.value);
      await verifyProtectedObject(input.recoveryStorage, protectedItem.value);
      count += 1;
      totalBytes += BigInt(protectedItem.value.sizeBytes);
    }
    if (
      count !== manifest.attachmentEntryCount ||
      totalBytes !== BigInt(manifest.totalProtectedBytes)
    ) {
      throw new Error('Attachment recovery manifest totals do not match its entries.');
    }
    return {
      recoveryPointId: input.recoveryPointId,
      attachmentEntryCount: count,
      totalProtectedBytes: totalBytes.toString(),
      verifiedAt: manifest.verifiedAt,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function protectBatch(
  batch: AttachmentInventoryEntry[],
  input: AttachmentRecoveryJobInput,
): Promise<AttachmentRecoveryEntry[]> {
  const result: AttachmentRecoveryEntry[] = [];
  for (let index = 0; index < batch.length; index += input.config.attachmentConcurrency) {
    const slice = batch.slice(index, index + input.config.attachmentConcurrency);
    result.push(...(await Promise.all(slice.map((entry) => protectOne(entry, input)))));
  }
  return result;
}

async function protectOne(
  entry: AttachmentInventoryEntry,
  input: AttachmentRecoveryJobInput,
): Promise<AttachmentRecoveryEntry> {
  const protectedObjectKey = protectedAttachmentObjectKey({
    attachmentId: entry.attachmentId,
    sha256: entry.sha256,
  });
  const existingVersions = await input.recoveryStorage.listObjects({
    prefix: protectedAttachmentPrefix(entry.attachmentId),
    limit: 2,
    continuationToken: null,
  });
  if (
    existingVersions.nextToken !== null ||
    existingVersions.objects.some((object) => object.key !== protectedObjectKey)
  ) {
    throw new Error('ATTACHMENT_BINARY_IMMUTABILITY_VIOLATION');
  }

  if (existingVersions.objects.some((object) => object.key === protectedObjectKey)) {
    await verifyProtectedObject(input.recoveryStorage, {
      recordType: 'attachment',
      attachmentId: entry.attachmentId,
      protectedObjectKey,
      mediaType: entry.mediaType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    });
  } else {
    const source = await input.sourceStorage.getObject(entry.sourceObjectKey);
    if (
      source?.contentLength !== Number(entry.sizeBytes) ||
      source.body.byteLength !== Number(entry.sizeBytes) ||
      sha256(source.body) !== entry.sha256
    ) {
      throw new Error('Required attachment source is missing or failed integrity verification.');
    }
    try {
      await input.recoveryStorage.putBuffer({
        key: protectedObjectKey,
        body: source.body,
        contentType: entry.mediaType,
        contentLength: source.body.byteLength,
        checksumSha256: entry.sha256,
      });
    } catch (error) {
      if (!(error instanceof RecoveryStorageConflictError)) throw error;
    }
    await verifyProtectedObject(input.recoveryStorage, {
      recordType: 'attachment',
      attachmentId: entry.attachmentId,
      protectedObjectKey,
      mediaType: entry.mediaType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    });
  }

  return attachmentRecoveryEntrySchema.parse({
    recordType: 'attachment',
    attachmentId: entry.attachmentId,
    protectedObjectKey,
    mediaType: entry.mediaType,
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
  });
}

async function verifyProtectedObject(
  storage: RecoveryArtifactStoragePort,
  entry: AttachmentRecoveryEntry,
): Promise<void> {
  const expectedSize = Number(entry.sizeBytes);
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > ATTACHMENT_MAX_BYTES
  ) {
    throw new Error('Protected attachment size is outside the approved bound.');
  }
  const metadata = await storage.headObject(entry.protectedObjectKey);
  const body = await storage.readBuffer(entry.protectedObjectKey, ATTACHMENT_MAX_BYTES);
  if (
    !metadata ||
    !body ||
    metadata.contentLength !== expectedSize ||
    body.byteLength !== expectedSize ||
    metadata.checksumSha256 !== entry.sha256 ||
    metadata.encryption === null ||
    sha256(body) !== entry.sha256
  ) {
    throw new Error('Protected attachment failed integrity or encryption verification.');
  }
}

async function downloadVerifiedObject(input: {
  storage: RecoveryArtifactStoragePort;
  key: string;
  targetPath: string;
  maximumBytes: number;
  expectedSha256?: string;
  expectedSize?: number;
}): Promise<{ sha256: string; sizeBytes: number }> {
  const metadata = await input.storage.headObject(input.key);
  if (!metadata?.encryption) {
    throw new Error('Recovery object is missing or is not encrypted.');
  }
  if (input.expectedSize !== undefined && metadata.contentLength !== input.expectedSize) {
    throw new Error('Recovery object size does not match its manifest.');
  }
  const downloaded = await input.storage.downloadToFile(
    input.key,
    input.targetPath,
    input.maximumBytes,
  );
  if (!downloaded) throw new Error('Required recovery object is missing.');
  const details = await stat(input.targetPath);
  const digest = await sha256File(input.targetPath);
  if (
    !details.isFile() ||
    details.size !== metadata.contentLength ||
    metadata.checksumSha256 !== digest ||
    (input.expectedSha256 !== undefined && digest !== input.expectedSha256)
  ) {
    throw new Error('Recovery object failed digest verification.');
  }
  return { sha256: digest, sizeBytes: details.size };
}

function assertMatchingEntry(
  inventory: AttachmentInventoryEntry,
  entry: AttachmentRecoveryEntry,
): void {
  const expectedKey = protectedAttachmentObjectKey({
    attachmentId: inventory.attachmentId,
    sha256: inventory.sha256,
  });
  if (
    entry.attachmentId !== inventory.attachmentId ||
    entry.protectedObjectKey !== expectedKey ||
    entry.mediaType !== inventory.mediaType ||
    entry.sizeBytes !== inventory.sizeBytes ||
    entry.sha256 !== inventory.sha256
  ) {
    throw new Error('Attachment recovery inventory and protected entry do not match.');
  }
}
