import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AttachmentObjectPage,
  AttachmentStoragePort,
  PutAttachmentObjectInput,
  StoredAttachmentObject,
} from '../attachments/attachment-storage.port';
import {
  attachmentInventoryEntrySchema,
  attachmentInventoryFooterSchema,
  attachmentInventoryHeaderSchema,
  attachmentRecoveryManifestKey,
  protectedAttachmentObjectKey,
  serializeNdjsonRecord,
  type AttachmentInventoryEntry,
} from './attachment-recovery-manifest';
import type { RecoveryArtifactStoragePort } from './recovery-artifact-storage.port';
import { RecoveryCatalogService } from './recovery-catalog.service';
import type { RecoveryRuntimeConfig } from './recovery-config';
import { FilesystemRecoveryArtifactStorage } from './filesystem-recovery-artifact-storage';
import { recoveryArtifactKey, sha256, type VerifiedRecoveryManifest } from './recovery-manifest';
import {
  protectAttachmentRecoveryPoint,
  verifyAttachmentRecoveryPoint,
} from '../../scripts/recovery/attachment-recovery-job';
import { cleanupAttachmentRecovery } from '../../scripts/recovery/attachment-recovery-retention';

const storeA = '51000000-0000-4000-8000-000000000001';
const storeB = '51000000-0000-4000-8000-000000000002';
const attachmentA = '52000000-0000-4000-8000-000000000001';
const attachmentB = '52000000-0000-4000-8000-000000000002';

describe('attachment recovery protection', () => {
  let root: string;
  let recoveryStorage: FilesystemRecoveryArtifactStorage;
  let sourceStorage: MemoryAttachmentStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dokana-attachment-recovery-test-'));
    recoveryStorage = new FilesystemRecoveryArtifactStorage(root);
    sourceStorage = new MemoryAttachmentStorage();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes and verifies an empty companion manifest without business metadata', async () => {
    const recoveryPointId = '53000000-0000-4000-8000-000000000001';
    await storeDatabasePoint(recoveryPointId, '2026-10-19T00:00:00.000Z', []);

    const manifest = await protect(recoveryPointId);

    expect(manifest).toMatchObject({
      recoveryPointId,
      attachmentEntryCount: 0,
      totalProtectedBytes: '0',
      snapshotInventory: { method: 'SHARED_POSTGRESQL_SNAPSHOT' },
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /customer|supplier|product|expense|fileName|phone|description/i,
    );
    await expect(
      verifyAttachmentRecoveryPoint({ recoveryPointId, recoveryStorage }),
    ).resolves.toMatchObject({ attachmentEntryCount: 0, totalProtectedBytes: '0' });
  });

  it('protects active attachments across Stores without cross-attachment hash deduplication', async () => {
    const body = Buffer.from('same bytes, distinct attachment identities');
    const first = inventoryEntry(storeA, attachmentA, body);
    const second = inventoryEntry(storeB, attachmentB, body);
    sourceStorage.set(first.sourceObjectKey, body);
    sourceStorage.set(second.sourceObjectKey, body);
    const recoveryPointId = '53000000-0000-4000-8000-000000000002';
    await storeDatabasePoint(recoveryPointId, '2026-10-19T01:00:00.000Z', [first, second]);

    const manifest = await protect(recoveryPointId);

    expect(manifest.attachmentEntryCount).toBe(2);
    const objects = await recoveryStorage.listObjects({
      prefix: 'recovery/v1/protected-attachments/',
      limit: 10,
      continuationToken: null,
    });
    expect(objects.objects.map((object) => object.key)).toEqual([
      protectedAttachmentObjectKey({ attachmentId: attachmentA, sha256: first.sha256 }),
      protectedAttachmentObjectKey({ attachmentId: attachmentB, sha256: second.sha256 }),
    ]);
    await expect(
      verifyAttachmentRecoveryPoint({ recoveryPointId, recoveryStorage }),
    ).resolves.toMatchObject({ attachmentEntryCount: 2 });
  });

  it('reuses an immutable protected copy and can resume after final-manifest publication fails', async () => {
    const body = Buffer.from('immutable attachment');
    const entry = inventoryEntry(storeA, attachmentA, body);
    sourceStorage.set(entry.sourceObjectKey, body);
    const firstPoint = '53000000-0000-4000-8000-000000000003';
    await storeDatabasePoint(firstPoint, '2026-10-19T02:00:00.000Z', [entry]);
    const failingStorage = failFinalManifestOnce(recoveryStorage, firstPoint);

    await expect(
      protectAttachmentRecoveryPoint({
        recoveryPointId: firstPoint,
        config,
        recoveryStorage: failingStorage,
        sourceStorage,
      }),
    ).rejects.toThrow('simulated final publication failure');
    await expect(
      recoveryStorage.headObject(attachmentRecoveryManifestKey(firstPoint)),
    ).resolves.toBeNull();
    expect(sourceStorage.readCount).toBe(1);

    await protect(firstPoint);
    expect(sourceStorage.readCount).toBe(1);

    const secondPoint = '53000000-0000-4000-8000-000000000004';
    await storeDatabasePoint(secondPoint, '2026-10-19T03:00:00.000Z', [entry]);
    sourceStorage.objects.delete(entry.sourceObjectKey);
    await protect(secondPoint);
    expect(sourceStorage.readCount).toBe(1);
  });

  it('fails closed for missing, corrupt, and mutated attachment content', async () => {
    const expected = Buffer.from('expected attachment');
    const entry = inventoryEntry(storeA, attachmentA, expected);
    const missingPoint = '53000000-0000-4000-8000-000000000005';
    await storeDatabasePoint(missingPoint, '2026-10-19T04:00:00.000Z', [entry]);
    await expect(protect(missingPoint)).rejects.toThrow('source is missing');
    await expect(
      recoveryStorage.headObject(attachmentRecoveryManifestKey(missingPoint)),
    ).resolves.toBeNull();

    sourceStorage.set(entry.sourceObjectKey, expected);
    await protect(missingPoint);
    const protectedKey = protectedAttachmentObjectKey({
      attachmentId: entry.attachmentId,
      sha256: entry.sha256,
    });
    await recoveryStorage.deleteObject(protectedKey);
    await expect(
      verifyAttachmentRecoveryPoint({ recoveryPointId: missingPoint, recoveryStorage }),
    ).rejects.toThrow('integrity');
    await recoveryStorage.putBuffer({
      key: protectedKey,
      body: expected,
      contentType: entry.mediaType,
      contentLength: expected.byteLength,
      checksumSha256: entry.sha256,
    });
    await writeFile(join(root, ...protectedKey.split('/')), Buffer.from('corrupt attachment'));
    await expect(
      verifyAttachmentRecoveryPoint({ recoveryPointId: missingPoint, recoveryStorage }),
    ).rejects.toThrow('integrity');

    const changed = inventoryEntry(storeA, attachmentA, Buffer.from('changed attachment'));
    sourceStorage.set(changed.sourceObjectKey, Buffer.from('changed attachment'));
    const changedPoint = '53000000-0000-4000-8000-000000000006';
    await storeDatabasePoint(changedPoint, '2026-10-19T05:00:00.000Z', [changed]);
    await expect(protect(changedPoint)).rejects.toThrow('ATTACHMENT_BINARY_IMMUTABILITY_VIOLATION');
  });

  it('retains shared protected copies until the final retained reference expires', async () => {
    const body = Buffer.from('retained attachment');
    const entry = inventoryEntry(storeA, attachmentA, body);
    sourceStorage.set(entry.sourceObjectKey, body);
    const firstPoint = '53000000-0000-4000-8000-000000000007';
    const secondPoint = '53000000-0000-4000-8000-000000000008';
    await storeDatabasePoint(firstPoint, '2026-07-01T00:00:00.000Z', [entry]);
    await protect(firstPoint, new Date('2026-07-01T00:01:00.000Z'));
    await storeDatabasePoint(secondPoint, '2026-10-19T00:00:00.000Z', [entry]);
    await protect(secondPoint, new Date('2026-10-19T00:01:00.000Z'));
    const protectedKey = protectedAttachmentObjectKey({
      attachmentId: entry.attachmentId,
      sha256: entry.sha256,
    });
    const oldTime = new Date('2026-07-01T00:00:00.000Z');
    await utimes(join(root, ...protectedKey.split('/')), oldTime, oldTime);

    await expect(
      cleanupAttachmentRecovery({
        storage: recoveryStorage,
        config,
        now: new Date('2026-10-20T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ recoveryPointsDeleted: 1, protectedObjectsDeleted: 0 });
    await expect(recoveryStorage.headObject(protectedKey)).resolves.not.toBeNull();

    const emptyPoint = '53000000-0000-4000-8000-000000000009';
    await storeDatabasePoint(emptyPoint, '2026-12-01T00:00:00.000Z', []);
    await protect(emptyPoint, new Date('2026-12-01T00:01:00.000Z'));
    await expect(
      cleanupAttachmentRecovery({
        storage: recoveryStorage,
        config,
        now: new Date('2026-12-01T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ recoveryPointsDeleted: 1, protectedObjectsDeleted: 1 });
    await expect(recoveryStorage.headObject(protectedKey)).resolves.toBeNull();
  });

  async function protect(recoveryPointId: string, now?: Date) {
    return protectAttachmentRecoveryPoint({
      recoveryPointId,
      config,
      recoveryStorage,
      sourceStorage,
      now,
    });
  }

  async function storeDatabasePoint(
    recoveryPointId: string,
    createdAt: string,
    entries: AttachmentInventoryEntry[],
  ): Promise<void> {
    const databaseBody = Buffer.from(`database-${recoveryPointId}`);
    const manifest: VerifiedRecoveryManifest = {
      manifestVersion: '1',
      recoveryPointId,
      state: 'VERIFIED',
      createdAt,
      completedAt: createdAt,
      environmentId: 'test',
      sourceRevision: null,
      backupType: 'postgresql-custom',
      artifact: {
        key: recoveryArtifactKey(recoveryPointId),
        sizeBytes: databaseBody.byteLength,
        sha256: sha256(databaseBody),
      },
      postgres: { serverVersion: '18', toolVersion: 'pg_dump 18' },
      migrations: {
        appliedCount: 32,
        latestFilename: '0032_attachment_lifecycle_audit.sql',
        checksumStatus: 'PASS',
        checksumAggregateSha256: 'f'.repeat(64),
      },
      verification: { status: 'VERIFIED', structuralCheck: 'PASS', verifiedAt: createdAt },
      retentionClass: 'DAILY',
    };
    await recoveryStorage.putBuffer({
      key: manifest.artifact.key,
      body: databaseBody,
      contentType: 'application/vnd.postgresql.custom',
      contentLength: databaseBody.byteLength,
      checksumSha256: manifest.artifact.sha256,
    });
    await new RecoveryCatalogService(recoveryStorage).writeManifest(manifest);

    const totalBytes = entries.reduce((total, entry) => total + BigInt(entry.sizeBytes), 0n);
    const inventoryBody = Buffer.concat([
      serializeNdjsonRecord(
        attachmentInventoryHeaderSchema.parse({
          recordType: 'header',
          inventoryVersion: '1',
          recoveryPointId,
          createdAt,
          snapshotInventoryMethod: 'SHARED_POSTGRESQL_SNAPSHOT',
        }),
      ),
      ...entries.map((entry) => serializeNdjsonRecord(entry)),
      serializeNdjsonRecord(
        attachmentInventoryFooterSchema.parse({
          recordType: 'footer',
          attachmentEntryCount: entries.length,
          totalBytes: totalBytes.toString(),
        }),
      ),
    ]);
    const inventoryKey = `recovery/v1/attachments/inventory/${recoveryPointId}.ndjson`;
    await recoveryStorage.putBuffer({
      key: inventoryKey,
      body: inventoryBody,
      contentType: 'application/x-ndjson',
      contentLength: inventoryBody.byteLength,
      checksumSha256: sha256(inventoryBody),
    });
  }
});

const config: RecoveryRuntimeConfig = {
  applicationEnvironment: 'test',
  environmentId: 'test',
  sourceRevision: null,
  storage: { driver: 'unconfigured' },
  logicalMaximumAgeHours: 36,
  attachmentBatchSize: 2,
  attachmentConcurrency: 2,
  attachmentOrphanGraceHours: 168,
};

function inventoryEntry(
  storeId: string,
  attachmentId: string,
  body: Buffer,
): AttachmentInventoryEntry {
  return attachmentInventoryEntrySchema.parse({
    recordType: 'attachment',
    storeId,
    attachmentId,
    sourceObjectKey: `stores/${storeId}/attachments/${attachmentId}`,
    mediaType: 'application/pdf',
    sizeBytes: body.byteLength.toString(),
    sha256: sha256(body),
  });
}

class MemoryAttachmentStorage implements AttachmentStoragePort {
  readonly objects = new Map<string, Buffer>();
  readCount = 0;

  set(key: string, body: Buffer): void {
    this.objects.set(key, Buffer.from(body));
  }

  putObject(input: PutAttachmentObjectInput): Promise<void> {
    this.objects.set(input.key, Buffer.from(input.body));
    return Promise.resolve();
  }

  getObject(key: string): Promise<StoredAttachmentObject | null> {
    this.readCount += 1;
    const body = this.objects.get(key);
    return Promise.resolve(
      body ? { body: Buffer.from(body), contentLength: body.byteLength } : null,
    );
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  objectExists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  listObjects(): Promise<AttachmentObjectPage> {
    return Promise.resolve({ objects: [], nextToken: null });
  }
}

function failFinalManifestOnce(
  storage: RecoveryArtifactStoragePort,
  recoveryPointId: string,
): RecoveryArtifactStoragePort {
  let failed = false;
  return {
    configured: storage.configured,
    putBuffer: async (input) => {
      if (!failed && input.key === attachmentRecoveryManifestKey(recoveryPointId)) {
        failed = true;
        throw new Error('simulated final publication failure');
      }
      await storage.putBuffer(input);
    },
    putFile: (input) => storage.putFile(input),
    readBuffer: (key, maximumBytes) => storage.readBuffer(key, maximumBytes),
    downloadToFile: (key, targetPath, maximumBytes) =>
      storage.downloadToFile(key, targetPath, maximumBytes),
    headObject: (key) => storage.headObject(key),
    deleteObject: (key) => storage.deleteObject(key),
    listObjects: (input) => storage.listObjects(input),
  };
}
