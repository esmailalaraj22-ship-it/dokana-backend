export const attachmentEntityTypes = ['customer', 'product', 'supplier', 'expense'] as const;
export type AttachmentEntityType = (typeof attachmentEntityTypes)[number];

export const attachmentMediaTypes = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AttachmentMediaType = (typeof attachmentMediaTypes)[number];

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_ACTIVE_PER_PARENT = 10;
export const ATTACHMENT_MAX_FILENAME_BYTES = 255;
export const ATTACHMENT_REMOVED_BINARY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTACHMENT_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AttachmentMetadataRecord {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mediaType: AttachmentMediaType;
  sizeBytes: bigint;
  checksumSha256: string;
  remoteKey: string;
  createdAt: Date;
  removedAt: Date | null;
}

export interface AttachmentMetadataResponse {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  originalFilename: string;
  mediaType: AttachmentMediaType;
  sizeBytes: string;
  createdAt: string;
}

export interface AttachmentListResponse {
  items: AttachmentMetadataResponse[];
}

export interface ValidatedAttachmentFile {
  buffer: Buffer;
  fileName: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  checksumSha256: string;
}

export interface AttachmentDownloadedFile {
  metadata: AttachmentMetadataResponse;
  body: Buffer;
}

export interface AttachmentCleanupResult {
  examined: number;
  deleted: number;
  failed: number;
  nextToken: string | null;
}
