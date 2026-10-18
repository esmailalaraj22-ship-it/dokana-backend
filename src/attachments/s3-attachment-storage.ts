import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

import type { AttachmentStorageConfig } from '../config/app-config.service';
import { ATTACHMENT_MAX_BYTES } from './attachment.types';
import {
  AttachmentStorageConflictError,
  AttachmentStorageUnavailableError,
  type AttachmentObjectPage,
  type AttachmentStoragePort,
  type PutAttachmentObjectInput,
  type StoredAttachmentObject,
} from './attachment-storage.port';

export class S3AttachmentStorage implements AttachmentStoragePort {
  private readonly client: Pick<S3Client, 'send'>;

  constructor(
    private readonly config: AttachmentStorageConfig,
    client?: Pick<S3Client, 'send'>,
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

  async putObject(input: PutAttachmentObjectInput): Promise<void> {
    try {
      await this.withTimeout((abortSignal) =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: input.key,
            Body: input.body,
            ContentLength: input.body.byteLength,
            ContentType: input.mediaType,
            IfNoneMatch: '*',
            Metadata: { sha256: input.checksumSha256 },
            ServerSideEncryption: 'AES256',
          }),
          { abortSignal },
        ),
      );
    } catch (error) {
      if (httpStatus(error) === 409 || httpStatus(error) === 412) {
        throw new AttachmentStorageConflictError();
      }
      throw new AttachmentStorageUnavailableError();
    }
  }

  async getObject(key: string): Promise<StoredAttachmentObject | null> {
    try {
      return await this.withTimeout(async (abortSignal) => {
        const result = await this.client.send(
          new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
          { abortSignal },
        );
        if (!result.Body) throw new AttachmentStorageUnavailableError();
        const body = await boundedBody(result.Body);
        if (result.ContentLength !== undefined && result.ContentLength !== body.byteLength) {
          throw new AttachmentStorageUnavailableError();
        }
        return { body, contentLength: body.byteLength };
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof AttachmentStorageUnavailableError) throw error;
      throw new AttachmentStorageUnavailableError();
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.withTimeout((abortSignal) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), {
          abortSignal,
        }),
      );
    } catch {
      throw new AttachmentStorageUnavailableError();
    }
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.withTimeout((abortSignal) =>
        this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }), {
          abortSignal,
        }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new AttachmentStorageUnavailableError();
    }
  }

  async listObjects(input: {
    prefix: string;
    limit: number;
    continuationToken: string | null;
  }): Promise<AttachmentObjectPage> {
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
          object.Key && object.LastModified
            ? [{ key: object.Key, lastModified: object.LastModified }]
            : [],
        ),
        nextToken: result.IsTruncated ? (result.NextContinuationToken ?? null) : null,
      };
    } catch {
      throw new AttachmentStorageUnavailableError();
    }
  }

  private async withTimeout<T>(work: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let rejectTimeout!: (reason: unknown) => void;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout(new AttachmentStorageUnavailableError());
    }, this.config.timeoutMs);
    try {
      return await Promise.race([work(controller.signal), timedOut]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function boundedBody(body: unknown): Promise<Buffer> {
  if (
    !body ||
    typeof body !== 'object' ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== 'function'
  ) {
    throw new AttachmentStorageUnavailableError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > ATTACHMENT_MAX_BYTES) throw new AttachmentStorageUnavailableError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
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
