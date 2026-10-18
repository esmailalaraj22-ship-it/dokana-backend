import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../auth/auth.types';
import type { TenantTransactionContext } from '../database/database.types';
import {
  ATTACHMENT_MALWARE_SCANNER,
  AttachmentScannerUnavailableError,
  type AttachmentMalwareScannerPort,
} from './attachment-malware-scanner.port';
import {
  AttachmentLimitReachedError,
  AttachmentParentNotFoundError,
  AttachmentParentNotWritableError,
  AttachmentRepository,
} from './attachment.repository';
import {
  ATTACHMENT_STORAGE,
  AttachmentStorageUnavailableError,
  type AttachmentStoragePort,
} from './attachment-storage.port';
import {
  ATTACHMENT_ORPHAN_RETENTION_MS,
  ATTACHMENT_REMOVED_BINARY_RETENTION_MS,
  type AttachmentCleanupResult,
  type AttachmentDownloadedFile,
  type AttachmentEntityType,
  type AttachmentListResponse,
  type AttachmentMetadataRecord,
  type AttachmentMetadataResponse,
} from './attachment.types';
import { validateAttachmentFile } from './attachment-file-validation';

type AttachmentPrincipal = Pick<
  AuthenticatedPrincipal,
  'membershipRole' | 'storeId' | 'userId' | 'deviceId'
>;

@Injectable()
export class AttachmentService {
  constructor(
    private readonly repository: AttachmentRepository,
    @Inject(ATTACHMENT_STORAGE)
    private readonly storage: AttachmentStoragePort,
    @Inject(ATTACHMENT_MALWARE_SCANNER)
    private readonly scanner: AttachmentMalwareScannerPort,
  ) {}

  async upload(
    principal: AttachmentPrincipal,
    context: TenantTransactionContext,
    parent: { entityType: AttachmentEntityType; entityId: string },
    file: Express.Multer.File | undefined,
  ): Promise<AttachmentMetadataResponse> {
    this.assertOwner(principal, context);
    if (!file) {
      throw new BadRequestException({
        code: 'ATTACHMENT_FILE_REQUIRED',
        message: 'Exactly one attachment file is required.',
      });
    }
    const validated = validateAttachmentFile(file);
    await this.preflightUpload(context, parent.entityType, parent.entityId);
    await this.scan(validated.buffer);

    const attachmentId = randomUUID();
    const remoteKey = this.objectKey(context.storeId, attachmentId);
    await this.putObject(remoteKey, validated);
    try {
      const metadata = await this.repository.create(context, {
        id: attachmentId,
        entityType: parent.entityType,
        entityId: parent.entityId,
        fileName: validated.fileName,
        mediaType: validated.mediaType,
        sizeBytes: validated.sizeBytes,
        checksumSha256: validated.checksumSha256,
        remoteKey,
      });
      return this.response(metadata);
    } catch (error) {
      try {
        await this.storage.deleteObject(remoteKey);
      } catch {
        // The private object remains inaccessible and becomes orphan-cleanup eligible.
      }
      this.throwRepositoryError(error);
    }
  }

  async list(
    principal: AttachmentPrincipal,
    context: TenantTransactionContext,
    parent: { entityType: AttachmentEntityType; entityId: string },
  ): Promise<AttachmentListResponse> {
    this.assertOwner(principal, context);
    try {
      const rows = await this.repository.listActive(context, parent.entityType, parent.entityId);
      return { items: rows.map((row) => this.response(row)) };
    } catch (error) {
      this.throwRepositoryError(error);
    }
  }

  async getMetadata(
    principal: AttachmentPrincipal,
    context: TenantTransactionContext,
    attachmentId: string,
  ): Promise<AttachmentMetadataResponse> {
    this.assertOwner(principal, context);
    return this.response(await this.requireActive(context, attachmentId));
  }

  async download(
    principal: AttachmentPrincipal,
    context: TenantTransactionContext,
    attachmentId: string,
  ): Promise<AttachmentDownloadedFile> {
    this.assertOwner(principal, context);
    const metadata = await this.requireActive(context, attachmentId);
    let object;
    try {
      object = await this.storage.getObject(metadata.remoteKey);
    } catch (error) {
      if (error instanceof AttachmentStorageUnavailableError) this.storageUnavailable();
      throw error;
    }
    if (
      !object ||
      BigInt(object.contentLength) !== metadata.sizeBytes ||
      createHash('sha256').update(object.body).digest('hex') !== metadata.checksumSha256
    ) {
      throw new ServiceUnavailableException({
        code: 'ATTACHMENT_BINARY_UNAVAILABLE',
        message: 'Attachment content is temporarily unavailable.',
      });
    }
    return { metadata: this.response(metadata), body: object.body };
  }

  async remove(
    principal: AttachmentPrincipal,
    context: TenantTransactionContext,
    attachmentId: string,
  ): Promise<AttachmentMetadataResponse> {
    this.assertOwner(principal, context);
    try {
      const result = await this.repository.remove(context, attachmentId);
      if (!result) this.notFound();
      return this.response(result);
    } catch (error) {
      this.throwRepositoryError(error);
    }
  }

  async purgeRemovedBinaries(
    context: TenantTransactionContext,
    now: Date,
    limit = 100,
  ): Promise<AttachmentCleanupResult> {
    const cutoff = new Date(now.getTime() - ATTACHMENT_REMOVED_BINARY_RETENTION_MS);
    const rows = await this.repository.listRemovedForBinaryPurge(
      context,
      cutoff,
      this.limit(limit),
    );
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (await this.storage.objectExists(row.remoteKey)) {
          await this.storage.deleteObject(row.remoteKey);
          deleted += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { examined: rows.length, deleted, failed, nextToken: null };
  }

  async purgeOrphanBinaries(
    context: TenantTransactionContext,
    now: Date,
    limit = 100,
    continuationToken: string | null = null,
  ): Promise<AttachmentCleanupResult> {
    const prefix = this.storePrefix(context.storeId);
    let page;
    try {
      page = await this.storage.listObjects({
        prefix,
        limit: this.limit(limit),
        continuationToken,
      });
    } catch (error) {
      if (error instanceof AttachmentStorageUnavailableError) this.storageUnavailable();
      throw error;
    }
    const cutoff = new Date(now.getTime() - ATTACHMENT_ORPHAN_RETENTION_MS);
    const eligible = page.objects.filter(
      (object) => object.key.startsWith(prefix) && object.lastModified <= cutoff,
    );
    const referenced = await this.repository.referencedObjectKeys(
      context,
      eligible.map((object) => object.key),
    );
    let deleted = 0;
    let failed = 0;
    for (const object of eligible) {
      if (referenced.has(object.key)) continue;
      try {
        await this.storage.deleteObject(object.key);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { examined: page.objects.length, deleted, failed, nextToken: page.nextToken };
  }

  private async requireActive(
    context: TenantTransactionContext,
    attachmentId: string,
  ): Promise<AttachmentMetadataRecord> {
    try {
      const result = await this.repository.findActiveById(context, attachmentId);
      if (!result) this.notFound();
      return result;
    } catch (error) {
      this.throwRepositoryError(error);
    }
  }

  private async preflightUpload(
    context: TenantTransactionContext,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<void> {
    try {
      await this.repository.assertUploadAllowed(context, entityType, entityId);
    } catch (error) {
      this.throwRepositoryError(error);
    }
  }

  private async scan(buffer: Buffer): Promise<void> {
    try {
      const result = await this.scanner.scan(buffer);
      if (result === 'infected') {
        throw new UnprocessableEntityException({
          code: 'ATTACHMENT_MALWARE_DETECTED',
          message: 'The attachment was rejected by security scanning.',
        });
      }
      if (result !== 'clean') this.scannerUnavailable();
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      if (error instanceof AttachmentScannerUnavailableError) this.scannerUnavailable();
      this.scannerUnavailable();
    }
  }

  private async putObject(
    remoteKey: string,
    file: ReturnType<typeof validateAttachmentFile>,
  ): Promise<void> {
    try {
      await this.storage.putObject({
        key: remoteKey,
        body: file.buffer,
        mediaType: file.mediaType,
        checksumSha256: file.checksumSha256,
      });
    } catch {
      this.storageUnavailable();
    }
  }

  private response(record: AttachmentMetadataRecord): AttachmentMetadataResponse {
    return {
      id: record.id,
      entityType: record.entityType,
      entityId: record.entityId,
      originalFilename: record.fileName,
      mediaType: record.mediaType,
      sizeBytes: record.sizeBytes.toString(),
      createdAt: record.createdAt.toISOString(),
    };
  }

  private objectKey(storeId: string, attachmentId: string): string {
    return `${this.storePrefix(storeId)}${attachmentId}`;
  }

  private storePrefix(storeId: string): string {
    return `stores/${storeId}/attachments/`;
  }

  private limit(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new TypeError('Attachment cleanup limit must be between 1 and 100.');
    }
    return value;
  }

  private assertOwner(principal: AttachmentPrincipal, context: TenantTransactionContext): void {
    if (
      principal.membershipRole !== 'owner' ||
      principal.storeId !== context.storeId ||
      principal.userId !== context.userId ||
      principal.deviceId !== context.deviceId
    ) {
      throw new ForbiddenException({
        code: 'ATTACHMENT_ACCESS_NOT_ALLOWED',
        message: 'Attachment access is not allowed.',
      });
    }
  }

  private throwRepositoryError(error: unknown): never {
    if (error instanceof AttachmentParentNotFoundError) {
      throw new NotFoundException({
        code: 'ATTACHMENT_PARENT_NOT_FOUND',
        message: 'Attachment parent was not found.',
      });
    }
    if (error instanceof AttachmentParentNotWritableError) {
      throw new ConflictException({
        code: 'ATTACHMENT_PARENT_NOT_WRITABLE',
        message: 'The parent does not accept new attachments.',
      });
    }
    if (error instanceof AttachmentLimitReachedError) {
      throw new ConflictException({
        code: 'ATTACHMENT_LIMIT_REACHED',
        message: 'The parent already has 10 active attachments.',
      });
    }
    throw error;
  }

  private notFound(): never {
    throw new NotFoundException({
      code: 'ATTACHMENT_NOT_FOUND',
      message: 'Attachment not found.',
    });
  }

  private scannerUnavailable(): never {
    throw new ServiceUnavailableException({
      code: 'ATTACHMENT_SCANNER_UNAVAILABLE',
      message: 'Attachment security scanning is temporarily unavailable.',
    });
  }

  private storageUnavailable(): never {
    throw new ServiceUnavailableException({
      code: 'ATTACHMENT_STORAGE_UNAVAILABLE',
      message: 'Attachment storage is temporarily unavailable.',
    });
  }
}
