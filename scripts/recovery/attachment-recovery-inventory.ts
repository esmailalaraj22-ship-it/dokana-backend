import { open } from 'node:fs/promises';

import { Pool, type PoolClient } from 'pg';

import {
  attachmentInventoryEntrySchema,
  attachmentInventoryFooterSchema,
  attachmentInventoryHeaderSchema,
  serializeNdjsonRecord,
  type AttachmentInventoryEntry,
} from '../../src/recovery/attachment-recovery-manifest';
import { createCustomFormatDump, type PostgresToolchain } from './postgres-tools';

interface AttachmentInventoryPhysicalRow {
  storeId: string;
  attachmentId: string;
  sourceObjectKey: string | null;
  mediaType: string | null;
  sizeBytes: string | null;
  sha256: string | null;
}

export interface AttachmentSnapshotCaptureResult {
  attachmentEntryCount: number;
  totalBytes: bigint;
}

export async function createDumpWithAttachmentSnapshot(input: {
  connectionString: string;
  toolchain: PostgresToolchain;
  dumpPath: string;
  inventoryPath: string;
  recoveryPointId: string;
  createdAt: Date;
  batchSize: number;
  onSnapshotExported?: () => Promise<void>;
}): Promise<AttachmentSnapshotCaptureResult> {
  assertBatchSize(input.batchSize);
  const pool = new Pool({
    connectionString: input.connectionString,
    ssl: process.env.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: 'dokana_recovery_snapshot_inventory',
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    allowExitOnIdle: true,
  });
  const client = await pool.connect();
  let transactionOpen = false;
  const inventory = await open(input.inventoryPath, 'wx', 0o600);
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    transactionOpen = true;
    await client.query(`set local idle_in_transaction_session_timeout = '30min'`);
    const snapshot = await client.query<{ snapshotId: string }>(
      `select pg_export_snapshot() as "snapshotId"`,
    );
    const snapshotId = snapshot.rows[0]?.snapshotId;
    if (!snapshotId) throw new Error('PostgreSQL did not provide a recovery snapshot.');

    await input.onSnapshotExported?.();
    await createCustomFormatDump(
      input.toolchain,
      input.connectionString,
      input.dumpPath,
      snapshotId,
    );

    const header = attachmentInventoryHeaderSchema.parse({
      recordType: 'header',
      inventoryVersion: '1',
      recoveryPointId: input.recoveryPointId,
      createdAt: input.createdAt.toISOString(),
      snapshotInventoryMethod: 'SHARED_POSTGRESQL_SNAPSHOT',
    });
    await inventory.write(serializeNdjsonRecord(header));

    let cursorStoreId: string | null = null;
    let cursorAttachmentId: string | null = null;
    let attachmentEntryCount = 0;
    let totalBytes = 0n;
    for (;;) {
      const page = await readInventoryPage(
        client,
        cursorStoreId,
        cursorAttachmentId,
        input.batchSize,
      );
      for (const row of page) {
        const entry = parseInventoryRow(row);
        await inventory.write(serializeNdjsonRecord(entry));
        attachmentEntryCount += 1;
        totalBytes += BigInt(entry.sizeBytes);
        cursorStoreId = entry.storeId;
        cursorAttachmentId = entry.attachmentId;
      }
      if (page.length < input.batchSize) break;
    }

    const footer = attachmentInventoryFooterSchema.parse({
      recordType: 'footer',
      attachmentEntryCount,
      totalBytes: totalBytes.toString(),
    });
    await inventory.write(serializeNdjsonRecord(footer));
    await inventory.sync();
    await client.query('commit');
    transactionOpen = false;
    return { attachmentEntryCount, totalBytes };
  } finally {
    await inventory.close().catch(() => undefined);
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function readInventoryPage(
  client: PoolClient,
  cursorStoreId: string | null,
  cursorAttachmentId: string | null,
  limit: number,
): Promise<AttachmentInventoryPhysicalRow[]> {
  const result = await client.query<AttachmentInventoryPhysicalRow>(
    `
      select
        store_id as "storeId",
        id as "attachmentId",
        remote_key as "sourceObjectKey",
        mime_type as "mediaType",
        file_size_bytes::text as "sizeBytes",
        checksum_sha256 as "sha256"
      from ledger.attachments
      where removed_at is null
        and (
          $1::uuid is null
          or (store_id, id) > ($1::uuid, $2::uuid)
        )
      order by store_id, id
      limit $3
    `,
    [cursorStoreId, cursorAttachmentId, limit],
  );
  return result.rows;
}

function parseInventoryRow(row: AttachmentInventoryPhysicalRow): AttachmentInventoryEntry {
  if (
    row.sourceObjectKey === null ||
    row.mediaType === null ||
    row.sizeBytes === null ||
    row.sha256 === null
  ) {
    throw new Error('An active attachment lacks mandatory recovery metadata.');
  }
  return attachmentInventoryEntrySchema.parse({
    recordType: 'attachment',
    storeId: row.storeId,
    attachmentId: row.attachmentId,
    sourceObjectKey: row.sourceObjectKey,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
  });
}

function assertBatchSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new TypeError('Attachment recovery inventory batch size must be between 1 and 500.');
  }
}
