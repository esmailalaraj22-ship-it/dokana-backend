import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import type { DatabaseTransaction, TenantTransactionContext } from '../database/database.types';
import {
  ATTACHMENT_MAX_ACTIVE_PER_PARENT,
  type AttachmentEntityType,
  type AttachmentMediaType,
  type AttachmentMetadataRecord,
} from './attachment.types';

interface AttachmentPhysicalRow extends Record<string, unknown> {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  mediaType: string | null;
  sizeBytes: string | null;
  checksumSha256: string | null;
  remoteKey: string | null;
  createdAt: string;
  removedAt: string | null;
}

interface ParentRow extends Record<string, unknown> {
  status: string;
}

export interface CreateAttachmentMetadataInput {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  checksumSha256: string;
  remoteKey: string;
}

export class AttachmentParentNotFoundError extends Error {
  constructor() {
    super('Attachment parent was not found.');
    this.name = 'AttachmentParentNotFoundError';
  }
}

export class AttachmentParentNotWritableError extends Error {
  constructor() {
    super('Attachment parent does not accept new attachments.');
    this.name = 'AttachmentParentNotWritableError';
  }
}

export class AttachmentLimitReachedError extends Error {
  constructor() {
    super('The active attachment limit was reached.');
    this.name = 'AttachmentLimitReachedError';
  }
}

@Injectable()
export class AttachmentRepository {
  constructor(private readonly database: DatabaseService) {}

  assertUploadAllowed(
    context: TenantTransactionContext,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<void> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      await this.lockWritableParent(transaction, context.storeId, entityType, entityId);
      const count = await transaction.execute<{ count: string }>(sql`
        select count(*)::text as count from ledger.attachments
        where store_id=${context.storeId}::uuid and entity_type=${entityType}
          and entity_id=${entityId}::uuid and removed_at is null
      `);
      if (BigInt(count.rows[0]?.count ?? '0') >= BigInt(ATTACHMENT_MAX_ACTIVE_PER_PARENT)) {
        throw new AttachmentLimitReachedError();
      }
    });
  }

  create(
    context: TenantTransactionContext,
    input: CreateAttachmentMetadataInput,
  ): Promise<AttachmentMetadataRecord> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      await this.lockWritableParent(transaction, context.storeId, input.entityType, input.entityId);
      const count = await transaction.execute<{ count: string }>(sql`
        select count(*)::text as count
        from ledger.attachments
        where store_id=${context.storeId}::uuid
          and entity_type=${input.entityType}
          and entity_id=${input.entityId}::uuid
          and removed_at is null
      `);
      if (BigInt(count.rows[0]?.count ?? '0') >= BigInt(ATTACHMENT_MAX_ACTIVE_PER_PARENT)) {
        throw new AttachmentLimitReachedError();
      }

      const kind =
        input.entityType === 'expense'
          ? 'receipt'
          : input.mediaType === 'application/pdf'
            ? 'document'
            : 'image';
      const result = await transaction.execute<AttachmentPhysicalRow>(sql`
        insert into ledger.attachments (
          id,store_id,entity_type,entity_id,kind,file_name,mime_type,
          remote_key,file_size_bytes,checksum_sha256,sync_status
        ) values (
          ${input.id}::uuid,${context.storeId}::uuid,${input.entityType},${input.entityId}::uuid,
          ${kind},${input.fileName},${input.mediaType},${input.remoteKey},
          ${input.sizeBytes}::bigint,${input.checksumSha256},'uploaded'
        )
        returning id,entity_type as "entityType",entity_id as "entityId",
          file_name as "fileName",mime_type as "mediaType",
          file_size_bytes::text as "sizeBytes",checksum_sha256 as "checksumSha256",
          remote_key as "remoteKey",created_at as "createdAt",removed_at as "removedAt"
      `);
      return this.mapRow(this.requireRow(result.rows[0]));
    });
  }

  listActive(
    context: TenantTransactionContext,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<AttachmentMetadataRecord[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      await this.assertReadableParent(transaction, context.storeId, entityType, entityId);
      const result = await transaction.execute<AttachmentPhysicalRow>(sql`
        select id,entity_type as "entityType",entity_id as "entityId",
          file_name as "fileName",mime_type as "mediaType",
          file_size_bytes::text as "sizeBytes",checksum_sha256 as "checksumSha256",
          remote_key as "remoteKey",created_at as "createdAt",removed_at as "removedAt"
        from ledger.attachments
        where store_id=${context.storeId}::uuid
          and entity_type=${entityType}
          and entity_id=${entityId}::uuid
          and removed_at is null
        order by created_at asc,id asc
        limit ${ATTACHMENT_MAX_ACTIVE_PER_PARENT}
      `);
      return result.rows.map((row) => this.mapRow(row));
    });
  }

  findActiveById(
    context: TenantTransactionContext,
    attachmentId: string,
  ): Promise<AttachmentMetadataRecord | undefined> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await this.selectActiveById(transaction, context.storeId, attachmentId);
      const row = result.rows[0];
      if (!row) return undefined;
      const attachment = this.mapRow(row);
      await this.assertReadableParent(
        transaction,
        context.storeId,
        attachment.entityType,
        attachment.entityId,
      );
      return attachment;
    });
  }

  remove(
    context: TenantTransactionContext,
    attachmentId: string,
  ): Promise<AttachmentMetadataRecord | undefined> {
    return this.database.withBusinessWriteTransaction(context, async (transaction) => {
      const initial = await this.selectActiveById(transaction, context.storeId, attachmentId);
      const initialRow = initial.rows[0];
      if (!initialRow) return undefined;
      const attachment = this.mapRow(initialRow);
      await this.lockParent(
        transaction,
        context.storeId,
        attachment.entityType,
        attachment.entityId,
      );
      const removed = await transaction.execute<{ attachmentId: string }>(sql`
        select attachment_id as "attachmentId"
        from ledger.remove_attachment_v1(${attachmentId}::uuid)
      `);
      if (!removed.rows[0]) return undefined;
      return attachment;
    });
  }

  listRemovedForBinaryPurge(
    context: TenantTransactionContext,
    cutoff: Date,
    limit: number,
  ): Promise<AttachmentMetadataRecord[]> {
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute<AttachmentPhysicalRow>(sql`
        select id,entity_type as "entityType",entity_id as "entityId",
          file_name as "fileName",mime_type as "mediaType",
          file_size_bytes::text as "sizeBytes",checksum_sha256 as "checksumSha256",
          remote_key as "remoteKey",created_at as "createdAt",removed_at as "removedAt"
        from ledger.attachments
        where store_id=${context.storeId}::uuid
          and removed_at is not null and removed_at<=${cutoff}::timestamptz
          and remote_key is not null
        order by removed_at asc,id asc
        limit ${limit}
      `);
      return result.rows.map((row) => this.mapRow(row));
    });
  }

  referencedObjectKeys(
    context: TenantTransactionContext,
    keys: readonly string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return Promise.resolve(new Set());
    return this.database.withTenantTransaction(context, async (transaction) => {
      const result = await transaction.execute<{ remoteKey: string }>(sql`
        select remote_key as "remoteKey"
        from ledger.attachments
        where store_id=${context.storeId}::uuid
          and remote_key in (${sql.join(
            keys.map((key) => sql`${key}`),
            sql`,`,
          )})
      `);
      return new Set(result.rows.map((row) => row.remoteKey));
    });
  }

  private selectActiveById(
    transaction: DatabaseTransaction,
    storeId: string,
    attachmentId: string,
  ) {
    return transaction.execute<AttachmentPhysicalRow>(sql`
      select id,entity_type as "entityType",entity_id as "entityId",
        file_name as "fileName",mime_type as "mediaType",
        file_size_bytes::text as "sizeBytes",checksum_sha256 as "checksumSha256",
        remote_key as "remoteKey",created_at as "createdAt",removed_at as "removedAt"
      from ledger.attachments
      where store_id=${storeId}::uuid and id=${attachmentId}::uuid and removed_at is null
      limit 1
    `);
  }

  private async lockWritableParent(
    transaction: DatabaseTransaction,
    storeId: string,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<void> {
    const row = await this.lockParent(transaction, storeId, entityType, entityId);
    const writable = entityType === 'expense' ? row.status === 'posted' : row.status === 'active';
    if (!writable) throw new AttachmentParentNotWritableError();
  }

  private async assertReadableParent(
    transaction: DatabaseTransaction,
    storeId: string,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<void> {
    const result = await this.parentQuery(transaction, storeId, entityType, entityId, false);
    if (!result.rows[0]) throw new AttachmentParentNotFoundError();
  }

  private async lockParent(
    transaction: DatabaseTransaction,
    storeId: string,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<ParentRow> {
    const result = await this.parentQuery(transaction, storeId, entityType, entityId, true);
    const row = result.rows[0];
    if (!row) throw new AttachmentParentNotFoundError();
    return row;
  }

  private parentQuery(
    transaction: DatabaseTransaction,
    storeId: string,
    entityType: AttachmentEntityType,
    entityId: string,
    lock: boolean,
  ) {
    const suffix = lock ? sql` for update` : sql``;
    switch (entityType) {
      case 'customer':
        return transaction.execute<ParentRow>(sql`
          select status from ledger.customers
          where store_id=${storeId}::uuid and id=${entityId}::uuid${suffix}
        `);
      case 'product':
        return transaction.execute<ParentRow>(sql`
          select status from ledger.products
          where store_id=${storeId}::uuid and id=${entityId}::uuid${suffix}
        `);
      case 'supplier':
        return transaction.execute<ParentRow>(sql`
          select status from ledger.suppliers
          where store_id=${storeId}::uuid and id=${entityId}::uuid${suffix}
        `);
      case 'expense':
        return transaction.execute<ParentRow>(sql`
          select status from ledger.expenses
          where store_id=${storeId}::uuid and id=${entityId}::uuid${suffix}
        `);
    }
  }

  private requireRow(row: AttachmentPhysicalRow | undefined): AttachmentPhysicalRow {
    if (!row) throw new Error('Attachment metadata insert returned no row.');
    return row;
  }

  private mapRow(row: AttachmentPhysicalRow): AttachmentMetadataRecord {
    if (
      !['customer', 'product', 'supplier', 'expense'].includes(row.entityType) ||
      !['application/pdf', 'image/jpeg', 'image/png'].includes(row.mediaType ?? '') ||
      row.sizeBytes === null ||
      row.checksumSha256 === null ||
      row.remoteKey === null
    ) {
      throw new Error('Attachment metadata is invalid.');
    }
    const createdAt = new Date(row.createdAt);
    const removedAt = row.removedAt === null ? null : new Date(row.removedAt);
    if (Number.isNaN(createdAt.getTime()) || (removedAt && Number.isNaN(removedAt.getTime()))) {
      throw new Error('Attachment metadata timestamp is invalid.');
    }
    return {
      id: row.id,
      entityType: row.entityType as AttachmentEntityType,
      entityId: row.entityId,
      fileName: row.fileName,
      mediaType: row.mediaType as AttachmentMediaType,
      sizeBytes: BigInt(row.sizeBytes),
      checksumSha256: row.checksumSha256,
      remoteKey: row.remoteKey,
      createdAt,
      removedAt,
    };
  }
}
