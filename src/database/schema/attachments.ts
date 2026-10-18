import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { ledgerSchema, stores } from './ledger';
import { users } from './platform';

export const attachments = ledgerSchema.table(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    kind: text('kind').$type<'image' | 'document' | 'receipt' | 'other'>().notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type'),
    localUri: text('local_uri'),
    remoteKey: text('remote_key'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'bigint' }),
    checksumSha256: text('checksum_sha256'),
    syncStatus: text('sync_status')
      .$type<'local' | 'pending' | 'uploaded' | 'failed' | 'deleted'>()
      .notNull()
      .default('local'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    removedByUserId: uuid('removed_by_user_id'),
  },
  (table) => [
    unique('attachments_store_id_id_key').on(table.storeId, table.id),
    foreignKey({
      name: 'attachments_store_id_fkey',
      columns: [table.storeId],
      foreignColumns: [stores.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      name: 'attachments_removed_by_user_id_fkey',
      columns: [table.removedByUserId],
      foreignColumns: [users.id],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check('attachments_kind_check', sql`${table.kind} in ('image','document','receipt','other')`),
    check('attachments_file_name_check', sql`length(trim(${table.fileName})) > 0`),
    check(
      'attachments_file_size_bytes_check',
      sql`${table.fileSizeBytes} is null or ${table.fileSizeBytes} >= 0`,
    ),
    check(
      'attachments_sync_status_check',
      sql`${table.syncStatus} in ('local','pending','uploaded','failed','deleted')`,
    ),
    check(
      'attachments_removal_evidence_check',
      sql`(${table.removedAt} is null and ${table.removedByUserId} is null)
          or (${table.removedAt} is not null and ${table.removedByUserId} is not null)`,
    ),
    index('idx_attachments_active_entity')
      .on(table.storeId, table.entityType, table.entityId, table.createdAt, table.id)
      .where(sql`${table.removedAt} is null`),
  ],
);
