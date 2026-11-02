import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATTACHMENT_MAX_BYTES } from '../attachments/attachment.types';
import {
  readAttachmentInventory,
  readAttachmentRecoveryEntries,
} from './attachment-recovery-files';
import {
  ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
  ATTACHMENT_RECOVERY_MANIFEST_MAXIMUM_BYTES,
  attachmentRecoveryEntriesKey,
  attachmentRecoveryInventoryKey,
  attachmentRecoveryManifestKey,
  parseAttachmentRecoveryManifest,
  protectedAttachmentObjectKey,
  serializeAttachmentRecoveryManifest,
  type AttachmentInventoryEntry,
  type AttachmentRecoveryEntry,
  type VerifiedAttachmentRecoveryManifest,
} from './attachment-recovery-manifest';
import {
  RECOVERY_ARTIFACT_STORAGE,
  type RecoveryArtifactStoragePort,
} from './recovery-artifact-storage.port';
import {
  RecoveryCatalogService,
  type VerifiedRecoveryPointCatalogEntry,
} from './recovery-catalog.service';
import { RECOVERY_CATALOG_PREFIX, sha256 } from './recovery-manifest';

const VERIFIED_ATTACHMENT_MANIFEST_PREFIX = `${RECOVERY_CATALOG_PREFIX}/manifests/attachments/verified/`;
const CATALOG_SCAN_LIMIT = 1_000;

export interface CoherentRecoveryCatalogState {
  latestVerified: VerifiedAttachmentRecoveryManifest | null;
  verifiedCount: number;
  invalidCount: number;
}

export interface AttachmentRecoveryVerificationResult {
  recoveryPointId: string;
  attachmentEntryCount: number;
  totalProtectedBytes: string;
  verifiedAt: string;
}

@Injectable()
export class AttachmentRecoveryCatalogService {
  constructor(
    @Inject(RECOVERY_ARTIFACT_STORAGE)
    private readonly storage: RecoveryArtifactStoragePort,
    private readonly databaseCatalog: RecoveryCatalogService,
  ) {}

  get configured(): boolean {
    return this.storage.configured;
  }

  async writeVerifiedManifest(manifest: VerifiedAttachmentRecoveryManifest): Promise<void> {
    const body = serializeAttachmentRecoveryManifest(manifest);
    await this.storage.putBuffer({
      key: attachmentRecoveryManifestKey(manifest.recoveryPointId),
      body,
      contentType: 'application/json',
      contentLength: body.byteLength,
      checksumSha256: sha256(body),
    });
  }

  async readVerifiedManifest(
    recoveryPointId: string,
    databaseEntry?: VerifiedRecoveryPointCatalogEntry,
  ): Promise<VerifiedAttachmentRecoveryManifest | null> {
    const database =
      databaseEntry ?? (await this.databaseCatalog.readVerifiedRecoveryPoint(recoveryPointId));
    if (!database) return null;
    const key = attachmentRecoveryManifestKey(recoveryPointId);
    try {
      const body = await this.storage.readBuffer(key, ATTACHMENT_RECOVERY_MANIFEST_MAXIMUM_BYTES);
      const metadata = await this.storage.headObject(key);
      if (!body || metadata?.checksumSha256 !== sha256(body) || !metadata.encryption) {
        return null;
      }
      const manifest = parseAttachmentRecoveryManifest(body);
      if (
        manifest.recoveryPointId !== recoveryPointId ||
        manifest.snapshotInventory.key !== attachmentRecoveryInventoryKey(recoveryPointId) ||
        manifest.entries.key !== attachmentRecoveryEntriesKey(recoveryPointId) ||
        manifest.databaseManifest.sha256 !== database.manifestSha256 ||
        manifest.databaseArtifactSha256 !== database.manifest.artifact.sha256
      ) {
        return null;
      }
      const [inventory, entries] = await Promise.all([
        this.storage.headObject(manifest.snapshotInventory.key),
        this.storage.headObject(manifest.entries.key),
      ]);
      if (
        inventory?.contentLength !== manifest.snapshotInventory.sizeBytes ||
        inventory.checksumSha256 !== manifest.snapshotInventory.sha256 ||
        !inventory.encryption ||
        entries?.contentLength !== manifest.entries.sizeBytes ||
        entries.checksumSha256 !== manifest.entries.sha256 ||
        !entries.encryption
      ) {
        return null;
      }
      return manifest;
    } catch {
      return null;
    }
  }

  async inspectCoherentCatalog(): Promise<CoherentRecoveryCatalogState> {
    const objects = await this.storage.listObjects({
      prefix: VERIFIED_ATTACHMENT_MANIFEST_PREFIX,
      limit: CATALOG_SCAN_LIMIT,
      continuationToken: null,
    });
    if (objects.nextToken !== null) {
      throw new Error('Attachment recovery catalog exceeds the bounded scan limit.');
    }
    const verified: VerifiedAttachmentRecoveryManifest[] = [];
    let invalidCount = 0;
    for (const object of objects.objects) {
      const match = /\/([0-9a-f-]{36})\.json$/.exec(object.key);
      if (!match?.[1]) continue;
      const manifest = await this.readVerifiedManifest(match[1]);
      if (manifest) verified.push(manifest);
      else invalidCount += 1;
    }
    verified.sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt));
    return { latestVerified: verified[0] ?? null, verifiedCount: verified.length, invalidCount };
  }

  async verifyRecoveryPoint(
    recoveryPointId: string,
  ): Promise<AttachmentRecoveryVerificationResult> {
    const database = await this.databaseCatalog.readVerifiedRecoveryPoint(recoveryPointId);
    if (!database) throw new Error('Verified database recovery point is unavailable.');
    const manifest = await this.readVerifiedManifest(recoveryPointId, database);
    if (!manifest) {
      throw new Error('Verified attachment recovery manifest is unavailable or invalid.');
    }

    const directory = await mkdtemp(join(tmpdir(), 'dokana-attachment-health-'));
    await chmod(directory, 0o700);
    try {
      const inventoryPath = join(directory, 'inventory.ndjson');
      await this.downloadVerifiedObject({
        key: manifest.snapshotInventory.key,
        targetPath: inventoryPath,
        expectedSize: manifest.snapshotInventory.sizeBytes,
        expectedSha256: manifest.snapshotInventory.sha256,
      });
      const entriesPath = join(directory, 'entries.ndjson');
      await this.downloadVerifiedObject({
        key: manifest.entries.key,
        targetPath: entriesPath,
        expectedSize: manifest.entries.sizeBytes,
        expectedSha256: manifest.entries.sha256,
      });

      const inventory = readAttachmentInventory(inventoryPath, recoveryPointId);
      const entries = readAttachmentRecoveryEntries(entriesPath, recoveryPointId);
      let count = 0;
      let totalBytes = 0n;
      for (;;) {
        const [inventoryItem, protectedItem] = await Promise.all([
          inventory.next(),
          entries.next(),
        ]);
        if (inventoryItem.done || protectedItem.done) {
          if (inventoryItem.done !== protectedItem.done) {
            throw new Error('Attachment recovery inventory and protected entries differ.');
          }
          break;
        }
        assertMatchingEntry(inventoryItem.value, protectedItem.value);
        await this.verifyProtectedObject(protectedItem.value);
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
        recoveryPointId,
        attachmentEntryCount: count,
        totalProtectedBytes: totalBytes.toString(),
        verifiedAt: manifest.verifiedAt,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async downloadVerifiedObject(input: {
    key: string;
    targetPath: string;
    expectedSize: number;
    expectedSha256: string;
  }): Promise<void> {
    const metadata = await this.storage.headObject(input.key);
    if (
      !metadata?.encryption ||
      metadata.contentLength !== input.expectedSize ||
      metadata.checksumSha256 !== input.expectedSha256
    ) {
      throw new Error('Recovery object metadata does not match its manifest.');
    }
    const downloaded = await this.storage.downloadToFile(
      input.key,
      input.targetPath,
      ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES,
    );
    if (!downloaded) throw new Error('Required recovery object is missing.');
    const details = await stat(input.targetPath);
    if (
      !details.isFile() ||
      details.size !== input.expectedSize ||
      (await sha256File(input.targetPath)) !== input.expectedSha256
    ) {
      throw new Error('Recovery object failed integrity verification.');
    }
  }

  private async verifyProtectedObject(entry: AttachmentRecoveryEntry): Promise<void> {
    const expectedSize = Number(entry.sizeBytes);
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > ATTACHMENT_MAX_BYTES
    ) {
      throw new Error('Protected attachment size is outside the approved bound.');
    }
    const metadata = await this.storage.headObject(entry.protectedObjectKey);
    const body = await this.storage.readBuffer(entry.protectedObjectKey, ATTACHMENT_MAX_BYTES);
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
}

function assertMatchingEntry(
  inventory: AttachmentInventoryEntry,
  protectedEntry: AttachmentRecoveryEntry,
): void {
  const expectedKey = protectedAttachmentObjectKey({
    attachmentId: inventory.attachmentId,
    sha256: inventory.sha256,
  });
  if (
    inventory.attachmentId !== protectedEntry.attachmentId ||
    protectedEntry.protectedObjectKey !== expectedKey ||
    inventory.mediaType !== protectedEntry.mediaType ||
    inventory.sizeBytes !== protectedEntry.sizeBytes ||
    inventory.sha256 !== protectedEntry.sha256
  ) {
    throw new Error('Attachment recovery inventory and protected entry do not match.');
  }
}

async function sha256File(path: string): Promise<string> {
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
