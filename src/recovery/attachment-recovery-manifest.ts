import { z } from 'zod';

import { attachmentMediaTypes } from '../attachments/attachment.types';
import { RECOVERY_CATALOG_PREFIX, sha256 } from './recovery-manifest';

export const ATTACHMENT_RECOVERY_MANIFEST_VERSION = '1' as const;
export const ATTACHMENT_RECOVERY_INVENTORY_VERSION = '1' as const;
export const ATTACHMENT_RECOVERY_MANIFEST_MAXIMUM_BYTES = 64 * 1024;
export const ATTACHMENT_RECOVERY_ENTRIES_MAXIMUM_BYTES = 1024 * 1024 * 1024;
export const ATTACHMENT_RECOVERY_ORPHAN_DELETE_LIMIT = 25;

const uuidSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const byteCountSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const sourceObjectKeySchema = z
  .string()
  .regex(/^stores\/[0-9a-f-]{36}\/attachments\/[0-9a-f-]{36}$/);
const protectedObjectKeySchema = z
  .string()
  .regex(/^recovery\/v1\/protected-attachments\/[0-9a-f-]{36}\/[0-9a-f]{64}\.bin$/);

export const attachmentInventoryHeaderSchema = z.object({
  recordType: z.literal('header'),
  inventoryVersion: z.literal(ATTACHMENT_RECOVERY_INVENTORY_VERSION),
  recoveryPointId: uuidSchema,
  createdAt: timestampSchema,
  snapshotInventoryMethod: z.literal('SHARED_POSTGRESQL_SNAPSHOT'),
});

export const attachmentInventoryEntrySchema = z
  .object({
    recordType: z.literal('attachment'),
    storeId: uuidSchema,
    attachmentId: uuidSchema,
    sourceObjectKey: sourceObjectKeySchema,
    mediaType: z.enum(attachmentMediaTypes),
    sizeBytes: byteCountSchema,
    sha256: sha256Schema,
  })
  .superRefine((entry, context) => {
    if (entry.sourceObjectKey !== `stores/${entry.storeId}/attachments/${entry.attachmentId}`) {
      context.addIssue({
        code: 'custom',
        path: ['sourceObjectKey'],
        message: 'must match the attachment tenant and identity',
      });
    }
  });

export const attachmentInventoryFooterSchema = z.object({
  recordType: z.literal('footer'),
  attachmentEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: byteCountSchema,
});

export const attachmentRecoveryEntryHeaderSchema = z.object({
  recordType: z.literal('header'),
  entriesVersion: z.literal(ATTACHMENT_RECOVERY_MANIFEST_VERSION),
  recoveryPointId: uuidSchema,
});

export const attachmentRecoveryEntrySchema = z.object({
  recordType: z.literal('attachment'),
  attachmentId: uuidSchema,
  protectedObjectKey: protectedObjectKeySchema,
  mediaType: z.enum(attachmentMediaTypes),
  sizeBytes: byteCountSchema,
  sha256: sha256Schema,
});

export const attachmentRecoveryEntryFooterSchema = z.object({
  recordType: z.literal('footer'),
  attachmentEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalProtectedBytes: byteCountSchema,
});

export const verifiedAttachmentRecoveryManifestSchema = z.object({
  manifestVersion: z.literal(ATTACHMENT_RECOVERY_MANIFEST_VERSION),
  recoveryPointId: uuidSchema,
  databaseManifest: z.object({
    key: z.string().regex(/^recovery\/v1\/manifests\/verified\/[0-9a-f-]{36}\.json$/),
    sha256: sha256Schema,
  }),
  databaseArtifactSha256: sha256Schema,
  snapshotInventory: z.object({
    method: z.literal('SHARED_POSTGRESQL_SNAPSHOT'),
    key: z.string().regex(/^recovery\/v1\/attachments\/inventory\/[0-9a-f-]{36}\.ndjson$/),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
  }),
  createdAt: timestampSchema,
  verifiedAt: timestampSchema,
  digestAlgorithm: z.literal('SHA-256'),
  verificationStatus: z.literal('VERIFIED'),
  attachmentEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalProtectedBytes: byteCountSchema,
  entries: z.object({
    key: z.string().regex(/^recovery\/v1\/attachments\/entries\/[0-9a-f-]{36}\.ndjson$/),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
  }),
});

export type AttachmentInventoryHeader = z.infer<typeof attachmentInventoryHeaderSchema>;
export type AttachmentInventoryEntry = z.infer<typeof attachmentInventoryEntrySchema>;
export type AttachmentInventoryFooter = z.infer<typeof attachmentInventoryFooterSchema>;
export type AttachmentRecoveryEntry = z.infer<typeof attachmentRecoveryEntrySchema>;
export type VerifiedAttachmentRecoveryManifest = z.infer<
  typeof verifiedAttachmentRecoveryManifestSchema
>;

export function attachmentRecoveryInventoryKey(recoveryPointId: string): string {
  return `${RECOVERY_CATALOG_PREFIX}/attachments/inventory/${uuidSchema.parse(recoveryPointId)}.ndjson`;
}

export function attachmentRecoveryEntriesKey(recoveryPointId: string): string {
  return `${RECOVERY_CATALOG_PREFIX}/attachments/entries/${uuidSchema.parse(recoveryPointId)}.ndjson`;
}

export function attachmentRecoveryManifestKey(recoveryPointId: string): string {
  return `${RECOVERY_CATALOG_PREFIX}/manifests/attachments/verified/${uuidSchema.parse(recoveryPointId)}.json`;
}

export function protectedAttachmentObjectKey(input: {
  attachmentId: string;
  sha256: string;
}): string {
  return `${RECOVERY_CATALOG_PREFIX}/protected-attachments/${uuidSchema.parse(input.attachmentId)}/${sha256Schema.parse(input.sha256)}.bin`;
}

export function protectedAttachmentPrefix(attachmentId: string): string {
  return `${RECOVERY_CATALOG_PREFIX}/protected-attachments/${uuidSchema.parse(attachmentId)}/`;
}

export function serializeNdjsonRecord(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export function serializeAttachmentRecoveryManifest(
  manifest: VerifiedAttachmentRecoveryManifest,
): Buffer {
  const parsed = verifiedAttachmentRecoveryManifestSchema.parse(manifest);
  const body = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
  if (body.byteLength > ATTACHMENT_RECOVERY_MANIFEST_MAXIMUM_BYTES) {
    throw new Error('Attachment recovery manifest exceeds the bounded size.');
  }
  return body;
}

export function parseAttachmentRecoveryManifest(body: Buffer): VerifiedAttachmentRecoveryManifest {
  if (body.byteLength > ATTACHMENT_RECOVERY_MANIFEST_MAXIMUM_BYTES) {
    throw new Error('Attachment recovery manifest exceeds the bounded size.');
  }
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  return verifiedAttachmentRecoveryManifestSchema.parse(parsed);
}

export function attachmentRecoveryManifestDigest(
  manifest: VerifiedAttachmentRecoveryManifest,
): string {
  return sha256(serializeAttachmentRecoveryManifest(manifest));
}
