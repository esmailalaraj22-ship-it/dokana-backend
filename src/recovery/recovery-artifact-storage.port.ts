export const RECOVERY_ARTIFACT_STORAGE = Symbol('RECOVERY_ARTIFACT_STORAGE');

const RECOVERY_STORAGE_PREFIX = 'recovery/v1/';

export function isRecoveryStorageKey(value: string, allowTrailingSlash = false): boolean {
  if (
    value.length < RECOVERY_STORAGE_PREFIX.length ||
    value.length > 1_024 ||
    !value.startsWith(RECOVERY_STORAGE_PREFIX)
  ) {
    return false;
  }

  const candidate = allowTrailingSlash && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!candidate || candidate.endsWith('/')) return false;

  return candidate
    .split('/')
    .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..');
}

export interface RecoveryStoredObject {
  key: string;
  contentLength: number;
  checksumSha256: string | null;
  encryption: 'AES256' | 'aws:kms' | 'test-only-filesystem' | null;
  lastModified: Date;
}

export interface RecoveryObjectPage {
  objects: RecoveryStoredObject[];
  nextToken: string | null;
}

export interface RecoveryPutInput {
  key: string;
  contentType: string;
  contentLength: number;
  checksumSha256: string;
}

export interface RecoveryArtifactStoragePort {
  readonly configured: boolean;
  putBuffer(input: RecoveryPutInput & { body: Buffer }): Promise<void>;
  putFile(input: RecoveryPutInput & { sourcePath: string }): Promise<void>;
  readBuffer(key: string, maximumBytes: number): Promise<Buffer | null>;
  downloadToFile(key: string, targetPath: string, maximumBytes: number): Promise<boolean>;
  headObject(key: string): Promise<RecoveryStoredObject | null>;
  deleteObject(key: string): Promise<void>;
  listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<RecoveryObjectPage>;
}

export class RecoveryStorageUnavailableError extends Error {
  constructor() {
    super('Recovery artifact storage is unavailable.');
    this.name = 'RecoveryStorageUnavailableError';
  }
}

export class RecoveryStorageConflictError extends Error {
  constructor() {
    super('Recovery artifact already exists.');
    this.name = 'RecoveryStorageConflictError';
  }
}

export class UnavailableRecoveryArtifactStorage implements RecoveryArtifactStoragePort {
  readonly configured = false;

  putBuffer(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }

  putFile(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }

  readBuffer(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }

  downloadToFile(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }

  headObject(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }

  deleteObject(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }

  listObjects(): Promise<never> {
    return Promise.reject(new RecoveryStorageUnavailableError());
  }
}
