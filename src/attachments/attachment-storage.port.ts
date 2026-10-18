export const ATTACHMENT_STORAGE = Symbol('ATTACHMENT_STORAGE');

export interface PutAttachmentObjectInput {
  key: string;
  body: Buffer;
  mediaType: string;
  checksumSha256: string;
}

export interface StoredAttachmentObject {
  body: Buffer;
  contentLength: number;
}

export interface AttachmentObjectSummary {
  key: string;
  lastModified: Date;
}

export interface AttachmentObjectPage {
  objects: AttachmentObjectSummary[];
  nextToken: string | null;
}

export interface AttachmentStoragePort {
  putObject(input: PutAttachmentObjectInput): Promise<void>;
  getObject(key: string): Promise<StoredAttachmentObject | null>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<AttachmentObjectPage>;
}

export class AttachmentStorageUnavailableError extends Error {
  constructor() {
    super('Secure attachment storage is unavailable.');
    this.name = 'AttachmentStorageUnavailableError';
  }
}

export class AttachmentStorageConflictError extends Error {
  constructor() {
    super('The attachment object already exists.');
    this.name = 'AttachmentStorageConflictError';
  }
}

export class UnavailableAttachmentStorage implements AttachmentStoragePort {
  putObject(): Promise<void> {
    return Promise.reject(new AttachmentStorageUnavailableError());
  }

  getObject(): Promise<never> {
    return Promise.reject(new AttachmentStorageUnavailableError());
  }

  deleteObject(): Promise<void> {
    return Promise.reject(new AttachmentStorageUnavailableError());
  }

  objectExists(): Promise<never> {
    return Promise.reject(new AttachmentStorageUnavailableError());
  }

  listObjects(): Promise<never> {
    return Promise.reject(new AttachmentStorageUnavailableError());
  }
}
