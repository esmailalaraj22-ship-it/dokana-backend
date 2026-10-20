import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';

import type { RecoveryS3StorageConfig } from './recovery-config';
import {
  isRecoveryStorageKey,
  RecoveryStorageConflictError,
  RecoveryStorageUnavailableError,
  type RecoveryArtifactStoragePort,
  type RecoveryObjectPage,
  type RecoveryPutInput,
  type RecoveryStoredObject,
} from './recovery-artifact-storage.port';

type RecoveryS3Client = Pick<S3Client, 'send'>;

export class S3RecoveryArtifactStorage implements RecoveryArtifactStoragePort {
  readonly configured = true;
  private readonly client: RecoveryS3Client;

  constructor(
    private readonly config: RecoveryS3StorageConfig,
    client?: RecoveryS3Client,
  ) {
    const clientConfig: S3ClientConfig = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
    };
    if (config.endpoint) clientConfig.endpoint = config.endpoint;
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }
    this.client = client ?? new S3Client(clientConfig);
  }

  putBuffer(input: RecoveryPutInput & { body: Buffer }): Promise<void> {
    if (input.body.byteLength !== input.contentLength) {
      return Promise.reject(new RecoveryStorageUnavailableError());
    }
    return this.put(input, input.body);
  }

  async putFile(input: RecoveryPutInput & { sourcePath: string }): Promise<void> {
    const source = await stat(input.sourcePath).catch(() => null);
    if (!source?.isFile() || source.size !== input.contentLength) {
      throw new RecoveryStorageUnavailableError();
    }
    await this.put(input, createReadStream(input.sourcePath));
  }

  async readBuffer(key: string, maximumBytes: number): Promise<Buffer | null> {
    this.assertKey(key);
    return this.withTimeout(async (abortSignal) => {
      const result = await this.get(key, abortSignal);
      if (!result) return null;
      if ((result.ContentLength ?? maximumBytes + 1) > maximumBytes || !result.Body) {
        throw new RecoveryStorageUnavailableError();
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maximumBytes) throw new RecoveryStorageUnavailableError();
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    });
  }

  async downloadToFile(key: string, targetPath: string, maximumBytes: number): Promise<boolean> {
    this.assertKey(key);
    try {
      return await this.withTimeout(async (abortSignal) => {
        const result = await this.get(key, abortSignal);
        if (!result) return false;
        if ((result.ContentLength ?? maximumBytes + 1) > maximumBytes || !result.Body) {
          throw new RecoveryStorageUnavailableError();
        }
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        const target = await open(targetPath, 'wx', 0o600).catch((error: unknown) => {
          if (isAlreadyExists(error)) throw new RecoveryStorageConflictError();
          throw new RecoveryStorageUnavailableError();
        });
        let size = 0;
        try {
          for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength;
            if (size > maximumBytes) throw new RecoveryStorageUnavailableError();
            await target.write(Buffer.from(chunk));
          }
          if (result.ContentLength !== undefined && size !== result.ContentLength) {
            throw new RecoveryStorageUnavailableError();
          }
          await target.close();
          await chmod(targetPath, 0o600);
          return true;
        } catch (error) {
          await target.close().catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      if (error instanceof RecoveryStorageConflictError) throw error;
      if (error instanceof RecoveryStorageUnavailableError) throw error;
      throw new RecoveryStorageUnavailableError();
    }
  }

  async headObject(key: string): Promise<RecoveryStoredObject | null> {
    this.assertKey(key);
    try {
      const result = await this.withTimeout((abortSignal) =>
        this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }), {
          abortSignal,
        }),
      );
      return {
        key,
        contentLength: result.ContentLength ?? 0,
        checksumSha256: result.Metadata?.sha256 ?? null,
        encryption:
          result.ServerSideEncryption === 'AES256' || result.ServerSideEncryption === 'aws:kms'
            ? result.ServerSideEncryption
            : null,
        lastModified: result.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new RecoveryStorageUnavailableError();
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.assertKey(key);
    try {
      await this.withTimeout((abortSignal) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), {
          abortSignal,
        }),
      );
    } catch {
      throw new RecoveryStorageUnavailableError();
    }
  }

  async listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<RecoveryObjectPage> {
    if (!isRecoveryStorageKey(input.prefix, true) || input.limit < 1 || input.limit > 1_000) {
      throw new RecoveryStorageUnavailableError();
    }
    try {
      const result = await this.withTimeout((abortSignal) =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: input.prefix,
            MaxKeys: input.limit,
            ContinuationToken: input.continuationToken ?? undefined,
          }),
          { abortSignal },
        ),
      );
      return {
        objects: (result.Contents ?? []).flatMap((object) =>
          object.Key && isRecoveryStorageKey(object.Key) && object.LastModified
            ? [
                {
                  key: object.Key,
                  contentLength: object.Size ?? 0,
                  checksumSha256: null,
                  encryption: null,
                  lastModified: object.LastModified,
                } satisfies RecoveryStoredObject,
              ]
            : [],
        ),
        nextToken: result.IsTruncated ? (result.NextContinuationToken ?? null) : null,
      };
    } catch {
      throw new RecoveryStorageUnavailableError();
    }
  }

  private async put(input: RecoveryPutInput, body: Buffer | Readable): Promise<void> {
    this.assertKey(input.key);
    try {
      await this.withTimeout((abortSignal) =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: input.key,
            Body: body,
            ContentLength: input.contentLength,
            ContentType: input.contentType,
            IfNoneMatch: '*',
            Metadata: { sha256: input.checksumSha256 },
            ServerSideEncryption: this.config.kmsKeyId ? 'aws:kms' : 'AES256',
            SSEKMSKeyId: this.config.kmsKeyId,
          }),
          { abortSignal },
        ),
      );
    } catch (error) {
      if (httpStatus(error) === 409 || httpStatus(error) === 412) {
        throw new RecoveryStorageConflictError();
      }
      throw new RecoveryStorageUnavailableError();
    }
  }

  private async get(key: string, abortSignal: AbortSignal): Promise<GetObjectCommandOutput | null> {
    try {
      return await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal },
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new RecoveryStorageUnavailableError();
    }
  }

  private assertKey(key: string): void {
    if (!isRecoveryStorageKey(key)) throw new RecoveryStorageUnavailableError();
  }

  private async withTimeout<T>(work: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let rejectTimeout!: (reason: unknown) => void;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout(new RecoveryStorageUnavailableError());
    }, this.config.timeoutMs);
    try {
      return await Promise.race([work(controller.signal), timedOut]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return httpStatus(error) === 404 || name === 'NoSuchKey' || name === 'NotFound';
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
