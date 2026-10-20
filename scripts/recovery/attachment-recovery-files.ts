import { createReadStream } from 'node:fs';

import {
  attachmentInventoryEntrySchema,
  attachmentInventoryFooterSchema,
  attachmentInventoryHeaderSchema,
  attachmentRecoveryEntryFooterSchema,
  attachmentRecoveryEntryHeaderSchema,
  attachmentRecoveryEntrySchema,
  type AttachmentInventoryEntry,
  type AttachmentRecoveryEntry,
} from '../../src/recovery/attachment-recovery-manifest';

const MAXIMUM_NDJSON_LINE_BYTES = 16 * 1024;

export async function* readAttachmentInventory(
  path: string,
  recoveryPointId: string,
): AsyncGenerator<AttachmentInventoryEntry> {
  const records = readNdjsonRecords(path);
  const header = await records.next();
  if (header.done) throw new Error('Attachment recovery inventory is empty.');
  const parsedHeader = attachmentInventoryHeaderSchema.parse(header.value);
  if (parsedHeader.recoveryPointId !== recoveryPointId) {
    throw new Error('Attachment recovery inventory identity does not match the recovery point.');
  }

  let count = 0;
  let totalBytes = 0n;
  let previousIdentity: string | null = null;
  for (;;) {
    const record = await records.next();
    if (record.done) throw new Error('Attachment recovery inventory footer is missing.');
    if (isFooterRecord(record.value)) {
      const footer = attachmentInventoryFooterSchema.parse(record.value);
      if (footer.attachmentEntryCount !== count || BigInt(footer.totalBytes) !== totalBytes) {
        throw new Error('Attachment recovery inventory totals are invalid.');
      }
      if (!(await records.next()).done) {
        throw new Error('Attachment recovery inventory contains records after its footer.');
      }
      return;
    }

    const entry = attachmentInventoryEntrySchema.parse(record.value);
    const identity = `${entry.storeId}/${entry.attachmentId}`;
    if (previousIdentity !== null && identity <= previousIdentity) {
      throw new Error('Attachment recovery inventory order or uniqueness is invalid.');
    }
    previousIdentity = identity;
    count += 1;
    totalBytes += BigInt(entry.sizeBytes);
    yield entry;
  }
}

export async function* readAttachmentRecoveryEntries(
  path: string,
  recoveryPointId: string,
): AsyncGenerator<AttachmentRecoveryEntry> {
  const records = readNdjsonRecords(path);
  const header = await records.next();
  if (header.done) throw new Error('Attachment recovery entries are empty.');
  const parsedHeader = attachmentRecoveryEntryHeaderSchema.parse(header.value);
  if (parsedHeader.recoveryPointId !== recoveryPointId) {
    throw new Error('Attachment recovery entry identity does not match the recovery point.');
  }

  let count = 0;
  let totalBytes = 0n;
  for (;;) {
    const record = await records.next();
    if (record.done) throw new Error('Attachment recovery entry footer is missing.');
    if (isFooterRecord(record.value)) {
      const footer = attachmentRecoveryEntryFooterSchema.parse(record.value);
      if (
        footer.attachmentEntryCount !== count ||
        BigInt(footer.totalProtectedBytes) !== totalBytes
      ) {
        throw new Error('Attachment recovery entry totals are invalid.');
      }
      if (!(await records.next()).done) {
        throw new Error('Attachment recovery entries contain records after their footer.');
      }
      return;
    }

    const entry = attachmentRecoveryEntrySchema.parse(record.value);
    count += 1;
    totalBytes += BigInt(entry.sizeBytes);
    yield entry;
  }
}

async function* readNdjsonRecords(path: string) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > MAXIMUM_NDJSON_LINE_BYTES) {
        throw new Error('Attachment recovery NDJSON record exceeds the bounded size.');
      }
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.byteLength === 0) throw new Error('Attachment recovery NDJSON has an empty record.');
      yield parseJson(line);
    }
    if (pending.byteLength > MAXIMUM_NDJSON_LINE_BYTES) {
      throw new Error('Attachment recovery NDJSON record exceeds the bounded size.');
    }
  }
  if (pending.byteLength !== 0) {
    throw new Error('Attachment recovery NDJSON must end with a newline.');
  }
}

function parseJson(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString('utf8')) as unknown;
  } catch {
    throw new Error('Attachment recovery NDJSON contains invalid JSON.');
  }
}

function isFooterRecord(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && 'recordType' in value && value.recordType === 'footer',
  );
}
