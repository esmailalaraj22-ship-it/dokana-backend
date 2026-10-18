import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import type { AttachmentStorageConfig } from '../config/app-config.service';
import { ATTACHMENT_MAX_BYTES } from './attachment.types';
import {
  AttachmentStorageConflictError,
  AttachmentStorageUnavailableError,
} from './attachment-storage.port';
import { S3AttachmentStorage } from './s3-attachment-storage';

type SendArguments = [unknown, { abortSignal?: AbortSignal }?];

const config: AttachmentStorageConfig = {
  endpoint: 'https://objects.example.test',
  region: 'test-region-1',
  bucket: 'private-attachments',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
  timeoutMs: 50,
};

function storageWith(send: jest.Mock<Promise<unknown>, SendArguments>, timeoutMs = 50) {
  return new S3AttachmentStorage({ ...config, timeoutMs }, { send } as unknown as Pick<
    S3Client,
    'send'
  >);
}

describe('S3AttachmentStorage', () => {
  it('writes private, encrypted, immutable-key objects without a public ACL', async () => {
    const send = jest.fn<Promise<unknown>, SendArguments>().mockResolvedValue({});
    const storage = storageWith(send);
    const body = Buffer.from('private content');

    await storage.putObject({
      key: 'stores/store-id/attachments/attachment-id',
      body,
      mediaType: 'application/pdf',
      checksumSha256: 'a'.repeat(64),
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: config.bucket,
      Key: 'stores/store-id/attachments/attachment-id',
      Body: body,
      ContentLength: body.byteLength,
      ContentType: 'application/pdf',
      IfNoneMatch: '*',
      Metadata: { sha256: 'a'.repeat(64) },
      ServerSideEncryption: 'AES256',
    });
    expect((command as PutObjectCommand).input).not.toHaveProperty('ACL');
  });

  it('maps immutable-key conflicts and provider failures to sanitized errors', async () => {
    const conflict = Object.assign(new Error('provider detail'), {
      $metadata: { httpStatusCode: 412 },
    });
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(new Error('provider secret'));
    const storage = storageWith(send);
    const input = {
      key: 'key',
      body: Buffer.from('content'),
      mediaType: 'application/pdf',
      checksumSha256: 'b'.repeat(64),
    };

    await expect(storage.putObject(input)).rejects.toBeInstanceOf(AttachmentStorageConflictError);
    await expect(storage.putObject(input)).rejects.toMatchObject({
      name: 'AttachmentStorageUnavailableError',
      message: 'Secure attachment storage is unavailable.',
    });
  });

  it('reads bounded content and rejects length mismatches or oversized bodies', async () => {
    const body = Buffer.from('content');
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockResolvedValueOnce({ Body: chunks(body), ContentLength: body.byteLength })
      .mockResolvedValueOnce({ Body: chunks(body), ContentLength: body.byteLength + 1 })
      .mockResolvedValueOnce({ Body: chunks(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)) });
    const storage = storageWith(send, 5_000);

    await expect(storage.getObject('key')).resolves.toEqual({
      body,
      contentLength: body.byteLength,
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    await expect(storage.getObject('key')).rejects.toBeInstanceOf(
      AttachmentStorageUnavailableError,
    );
    await expect(storage.getObject('key')).rejects.toBeInstanceOf(
      AttachmentStorageUnavailableError,
    );
  });

  it('bounds the complete download, including response-body consumption', async () => {
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockResolvedValue({ Body: stalledBody(), ContentLength: 1 });
    const storage = storageWith(send, 20);

    await expect(storage.getObject('key')).rejects.toBeInstanceOf(
      AttachmentStorageUnavailableError,
    );
  });

  it('supports private existence, deletion, and bounded prefix listing', async () => {
    const modified = new Date('2026-10-18T00:00:00.000Z');
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'stores/store-id/attachments/a', LastModified: modified },
          { Key: undefined, LastModified: modified },
        ],
        IsTruncated: true,
        NextContinuationToken: 'next',
      });
    const storage = storageWith(send);

    await expect(storage.objectExists('key')).resolves.toBe(true);
    await expect(storage.deleteObject('key')).resolves.toBeUndefined();
    await expect(
      storage.listObjects({
        prefix: 'stores/store-id/attachments/',
        limit: 100,
        continuationToken: null,
      }),
    ).resolves.toEqual({
      objects: [{ key: 'stores/store-id/attachments/a', lastModified: modified }],
      nextToken: 'next',
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(ListObjectsV2Command);
  });

  it('maps missing objects to absence without exposing provider detail', async () => {
    const missing = Object.assign(new Error('provider detail'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing);
    const storage = storageWith(send);

    await expect(storage.getObject('missing')).resolves.toBeNull();
    await expect(storage.objectExists('missing')).resolves.toBe(false);
  });
});

async function* chunks(value: Buffer): AsyncIterable<Uint8Array> {
  yield value;
}

async function* stalledBody(): AsyncIterable<Uint8Array> {
  yield Buffer.from('x');
  await new Promise<void>(() => undefined);
}
