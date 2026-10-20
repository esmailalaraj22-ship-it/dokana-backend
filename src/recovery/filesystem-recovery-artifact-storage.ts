import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  isRecoveryStorageKey,
  RecoveryStorageConflictError,
  RecoveryStorageUnavailableError,
  type RecoveryArtifactStoragePort,
  type RecoveryObjectPage,
  type RecoveryPutInput,
  type RecoveryStoredObject,
} from './recovery-artifact-storage.port';

interface FilesystemMetadata {
  key: string;
  checksumSha256: string;
  contentType: string;
  encryption: 'test-only-filesystem';
}

export class FilesystemRecoveryArtifactStorage implements RecoveryArtifactStoragePort {
  readonly configured = true;
  private readonly rootDirectory: string;
  private readonly metadataDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
    this.metadataDirectory = resolve(this.rootDirectory, '.metadata');
  }

  async putBuffer(input: RecoveryPutInput & { body: Buffer }): Promise<void> {
    if (input.body.byteLength !== input.contentLength) {
      throw new RecoveryStorageUnavailableError();
    }
    const target = this.pathFor(input.key);
    await this.prepareTarget(target);
    let objectCreated = false;
    try {
      await writeFile(target, input.body, { flag: 'wx', mode: 0o600 });
      objectCreated = true;
      await this.writeMetadata(input);
    } catch (error) {
      if (objectCreated) await rm(target, { force: true }).catch(() => undefined);
      if (isAlreadyExists(error)) throw new RecoveryStorageConflictError();
      if (error instanceof RecoveryStorageConflictError) throw error;
      throw new RecoveryStorageUnavailableError();
    }
  }

  async putFile(input: RecoveryPutInput & { sourcePath: string }): Promise<void> {
    const source = await stat(input.sourcePath).catch(() => null);
    if (!source?.isFile() || source.size !== input.contentLength) {
      throw new RecoveryStorageUnavailableError();
    }
    const target = this.pathFor(input.key);
    await this.prepareTarget(target);
    let objectCreated = false;
    try {
      await copyFile(input.sourcePath, target, constants.COPYFILE_EXCL);
      objectCreated = true;
      await chmod(target, 0o600);
      await this.writeMetadata(input);
    } catch (error) {
      if (objectCreated) await rm(target, { force: true }).catch(() => undefined);
      if (isAlreadyExists(error)) throw new RecoveryStorageConflictError();
      if (error instanceof RecoveryStorageConflictError) throw error;
      throw new RecoveryStorageUnavailableError();
    }
  }

  async readBuffer(key: string, maximumBytes: number): Promise<Buffer | null> {
    const target = this.pathFor(key);
    const details = await stat(target).catch(() => null);
    if (!details) return null;
    if (!details.isFile() || details.size > maximumBytes) {
      throw new RecoveryStorageUnavailableError();
    }
    return readFile(target).catch(() => {
      throw new RecoveryStorageUnavailableError();
    });
  }

  async downloadToFile(key: string, targetPath: string, maximumBytes: number): Promise<boolean> {
    const source = this.pathFor(key);
    const details = await stat(source).catch(() => null);
    if (!details) return false;
    if (!details.isFile() || details.size > maximumBytes) {
      throw new RecoveryStorageUnavailableError();
    }
    try {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await copyFile(source, targetPath, constants.COPYFILE_EXCL);
      await chmod(targetPath, 0o600);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) throw new RecoveryStorageConflictError();
      throw new RecoveryStorageUnavailableError();
    }
  }

  async headObject(key: string): Promise<RecoveryStoredObject | null> {
    const target = this.pathFor(key);
    const details = await stat(target).catch(() => null);
    if (!details) return null;
    const metadata = await this.readMetadata(key);
    return {
      key,
      contentLength: details.size,
      checksumSha256: metadata?.checksumSha256 ?? null,
      encryption: metadata?.encryption ?? null,
      lastModified: details.mtime,
    };
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await rm(this.pathFor(key), { force: true });
      await rm(this.metadataPath(key), { force: true });
    } catch {
      throw new RecoveryStorageUnavailableError();
    }
  }

  async listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<RecoveryObjectPage> {
    if (input.limit < 1 || input.limit > 1_000) {
      throw new RecoveryStorageUnavailableError();
    }
    const prefixPath = this.pathForPrefix(input.prefix);
    const keys = await this.listFiles(prefixPath);
    const after = input.continuationToken;
    const pageKeys = keys.filter((key) => after === null || key > after).slice(0, input.limit + 1);
    const hasMore = pageKeys.length > input.limit;
    const selected = pageKeys.slice(0, input.limit);
    const objects = await Promise.all(selected.map((key) => this.headObject(key)));
    return {
      objects: objects.filter((value): value is RecoveryStoredObject => value !== null),
      nextToken: hasMore ? (selected.at(-1) ?? null) : null,
    };
  }

  private pathFor(key: string): string {
    if (!isRecoveryStorageKey(key)) throw new RecoveryStorageUnavailableError();
    const target = resolve(this.rootDirectory, ...key.split('/'));
    if (target !== this.rootDirectory && !target.startsWith(this.rootDirectory + sep)) {
      throw new RecoveryStorageUnavailableError();
    }
    return target;
  }

  private pathForPrefix(prefix: string): string {
    if (!isRecoveryStorageKey(prefix, true)) throw new RecoveryStorageUnavailableError();
    const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const target = resolve(this.rootDirectory, ...normalized.split('/'));
    if (target !== this.rootDirectory && !target.startsWith(this.rootDirectory + sep)) {
      throw new RecoveryStorageUnavailableError();
    }
    return target;
  }

  private async prepareTarget(target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }).catch(() => {
      throw new RecoveryStorageUnavailableError();
    });
  }

  private metadataPath(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex');
    return resolve(this.metadataDirectory, `${digest}.json`);
  }

  private async writeMetadata(input: RecoveryPutInput): Promise<void> {
    await mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    const metadata: FilesystemMetadata = {
      key: input.key,
      checksumSha256: input.checksumSha256,
      contentType: input.contentType,
      encryption: 'test-only-filesystem',
    };
    await writeFile(this.metadataPath(input.key), JSON.stringify(metadata), {
      flag: 'wx',
      mode: 0o600,
    });
  }

  private async readMetadata(key: string): Promise<FilesystemMetadata | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.metadataPath(key), 'utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('key' in value) ||
        value.key !== key ||
        !('checksumSha256' in value) ||
        typeof value.checksumSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.checksumSha256) ||
        !('contentType' in value) ||
        typeof value.contentType !== 'string' ||
        !('encryption' in value) ||
        value.encryption !== 'test-only-filesystem'
      ) {
        return null;
      }
      return value as FilesystemMetadata;
    } catch {
      return null;
    }
  }

  private async listFiles(directory: string): Promise<string[]> {
    const details = await stat(directory).catch(() => null);
    if (!details) return [];
    if (!details.isDirectory()) throw new RecoveryStorageUnavailableError();
    const found: string[] = [];
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile())
          found.push(relative(this.rootDirectory, path).split(sep).join('/'));
      }
    }
    return found.sort((left, right) => left.localeCompare(right, 'en'));
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
