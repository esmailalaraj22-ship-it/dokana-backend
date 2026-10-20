import { Inject, Injectable } from '@nestjs/common';

import {
  ATTACHMENT_RECOVERY_MANIFEST_MAXIMUM_BYTES,
  attachmentRecoveryEntriesKey,
  attachmentRecoveryInventoryKey,
  attachmentRecoveryManifestKey,
  parseAttachmentRecoveryManifest,
  serializeAttachmentRecoveryManifest,
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
}
