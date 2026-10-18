import { randomUUID } from 'node:crypto';

import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import type {
  AttachmentMalwareScannerPort,
  AttachmentScanResult,
} from './attachment-malware-scanner.port';
import { AttachmentLimitReachedError, type AttachmentRepository } from './attachment.repository';
import type {
  AttachmentObjectPage,
  AttachmentStoragePort,
  PutAttachmentObjectInput,
  StoredAttachmentObject,
} from './attachment-storage.port';
import { AttachmentService } from './attachment.service';
import type { AttachmentMetadataRecord } from './attachment.types';

const context: TenantTransactionContext = {
  storeId: 'b1100000-0000-4000-8000-000000000001',
  userId: 'b1200000-0000-4000-8000-000000000001',
  deviceId: 'b1300000-0000-4000-8000-000000000001',
  requestId: 'b1400000-0000-4000-8000-000000000001',
};
const owner = {
  membershipRole: 'owner',
  storeId: context.storeId,
  userId: context.userId,
  deviceId: context.deviceId,
} satisfies Pick<AuthenticatedPrincipal, 'membershipRole' | 'storeId' | 'userId' | 'deviceId'>;

function pdf(): Buffer {
  return Buffer.from('%PDF-1.7\nbody\n%%EOF');
}

function file(): Express.Multer.File {
  const buffer = pdf();
  return {
    fieldname: 'file',
    originalname: 'receipt.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: buffer.byteLength,
    destination: '',
    filename: '',
    path: '',
    buffer,
    stream: undefined as unknown as Express.Multer.File['stream'],
  };
}

class MemoryAttachmentStorage implements AttachmentStoragePort {
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();
  failDelete = false;

  putObject(input: PutAttachmentObjectInput): Promise<void> {
    if (this.objects.has(input.key)) return Promise.reject(new Error('duplicate'));
    this.objects.set(input.key, { body: Buffer.from(input.body), lastModified: new Date() });
    return Promise.resolve();
  }

  getObject(key: string): Promise<StoredAttachmentObject | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { body: Buffer.from(object.body), contentLength: object.body.byteLength } : null,
    );
  }

  deleteObject(key: string): Promise<void> {
    if (this.failDelete) return Promise.reject(new Error('unavailable'));
    this.objects.delete(key);
    return Promise.resolve();
  }

  objectExists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<AttachmentObjectPage> {
    return Promise.resolve({
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(input.prefix))
        .slice(0, input.limit)
        .map(([key, object]) => ({ key, lastModified: object.lastModified })),
      nextToken: null,
    });
  }
}

class FixedScanner implements AttachmentMalwareScannerPort {
  constructor(public result: AttachmentScanResult = 'clean') {}
  scan(): Promise<AttachmentScanResult> {
    return Promise.resolve(this.result);
  }
}

function record(input: Partial<AttachmentMetadataRecord> = {}): AttachmentMetadataRecord {
  return {
    id: randomUUID(),
    entityType: 'expense',
    entityId: randomUUID(),
    fileName: 'receipt.pdf',
    mediaType: 'application/pdf',
    sizeBytes: BigInt(pdf().byteLength),
    checksumSha256: '0'.repeat(64),
    remoteKey: 'stores/test/attachments/test',
    createdAt: new Date('2026-10-18T12:00:00.000Z'),
    removedAt: null,
    ...input,
  };
}

function repositoryMock() {
  return {
    assertUploadAllowed: jest.fn<Promise<void>, [TenantTransactionContext, string, string]>(),
    create: jest.fn(),
    listActive: jest.fn(),
    findActiveById: jest.fn(),
    remove: jest.fn(),
    listRemovedForBinaryPurge: jest.fn(),
    referencedObjectKeys: jest.fn(),
  };
}

describe('AttachmentService', () => {
  it('stores clean content privately and returns metadata without the object key', async () => {
    const repository = repositoryMock();
    const storage = new MemoryAttachmentStorage();
    const scanner = new FixedScanner();
    repository.create.mockImplementation((_context: unknown, input: Record<string, unknown>) =>
      Promise.resolve(
        record({
          id: String(input.id),
          entityId: String(input.entityId),
          remoteKey: String(input.remoteKey),
          checksumSha256: String(input.checksumSha256),
        }),
      ),
    );
    const service = new AttachmentService(
      repository as unknown as AttachmentRepository,
      storage,
      scanner,
    );

    const result = await service.upload(
      owner,
      context,
      { entityType: 'expense', entityId: randomUUID() },
      file(),
    );

    expect(result).toMatchObject({ originalFilename: 'receipt.pdf', mediaType: 'application/pdf' });
    expect(result).not.toHaveProperty('remoteKey');
    expect(storage.objects.size).toBe(1);
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it.each<AttachmentScanResult>(['infected', 'unknown'])(
    'fails closed for %s scan results without storing metadata or content',
    async (scanResult) => {
      const repository = repositoryMock();
      const storage = new MemoryAttachmentStorage();
      const service = new AttachmentService(
        repository as unknown as AttachmentRepository,
        storage,
        new FixedScanner(scanResult),
      );
      await expect(
        service.upload(owner, context, { entityType: 'customer', entityId: randomUUID() }, file()),
      ).rejects.toMatchObject({ status: scanResult === 'infected' ? 422 : 503 });
      expect(storage.objects.size).toBe(0);
      expect(repository.create).not.toHaveBeenCalled();
    },
  );

  it('compensates a private object when metadata persistence fails', async () => {
    const repository = repositoryMock();
    repository.create.mockRejectedValue(new AttachmentLimitReachedError());
    const storage = new MemoryAttachmentStorage();
    const service = new AttachmentService(
      repository as unknown as AttachmentRepository,
      storage,
      new FixedScanner(),
    );
    await expect(
      service.upload(owner, context, { entityType: 'product', entityId: randomUUID() }, file()),
    ).rejects.toMatchObject({ status: 409 });
    expect(storage.objects.size).toBe(0);
  });

  it('does not weaken owner authorization or expose missing binary as empty content', async () => {
    const repository = repositoryMock();
    repository.findActiveById.mockResolvedValue(record());
    const storage = new MemoryAttachmentStorage();
    const service = new AttachmentService(
      repository as unknown as AttachmentRepository,
      storage,
      new FixedScanner(),
    );
    const manager = { ...owner, membershipRole: 'manager' as const };
    await expect(service.getMetadata(manager, context, randomUUID())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.download(owner, context, randomUUID())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('purges only old unreferenced objects and preserves referenced or recent objects', async () => {
    const repository = repositoryMock();
    const storage = new MemoryAttachmentStorage();
    const prefix = `stores/${context.storeId}/attachments/`;
    storage.objects.set(`${prefix}old-orphan`, {
      body: Buffer.from('old'),
      lastModified: new Date('2026-10-16T00:00:00.000Z'),
    });
    storage.objects.set(`${prefix}old-referenced`, {
      body: Buffer.from('referenced'),
      lastModified: new Date('2026-10-16T00:00:00.000Z'),
    });
    storage.objects.set(`${prefix}recent`, {
      body: Buffer.from('recent'),
      lastModified: new Date('2026-10-18T11:30:00.000Z'),
    });
    storage.objects.set('other/content', {
      body: Buffer.from('other'),
      lastModified: new Date('2020-01-01T00:00:00.000Z'),
    });
    repository.referencedObjectKeys.mockResolvedValue(new Set([`${prefix}old-referenced`]));
    const service = new AttachmentService(
      repository as unknown as AttachmentRepository,
      storage,
      new FixedScanner(),
    );

    const result = await service.purgeOrphanBinaries(context, new Date('2026-10-18T12:00:00.000Z'));
    expect(result).toMatchObject({ examined: 3, deleted: 1, failed: 0 });
    expect(storage.objects.has(`${prefix}old-orphan`)).toBe(false);
    expect(storage.objects.has(`${prefix}old-referenced`)).toBe(true);
    expect(storage.objects.has(`${prefix}recent`)).toBe(true);
    expect(storage.objects.has('other/content')).toBe(true);
  });
});
