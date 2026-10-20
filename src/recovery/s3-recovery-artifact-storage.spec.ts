import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import type { RecoveryS3StorageConfig } from './recovery-config';
import {
  RecoveryStorageConflictError,
  RecoveryStorageUnavailableError,
} from './recovery-artifact-storage.port';
import { S3RecoveryArtifactStorage } from './s3-recovery-artifact-storage';

type SendArguments = [unknown, { abortSignal?: AbortSignal }?];

const config: RecoveryS3StorageConfig = {
  driver: 's3',
  endpoint: 'https://recovery.example.test',
  region: 'test-1',
  bucket: 'private-recovery',
  accessKeyId: 'test-id',
  secretAccessKey: 'test-secret',
  forcePathStyle: true,
  kmsKeyId: 'test-kms-key',
  timeoutMs: 50,
};

function storageWith(send: jest.Mock<Promise<unknown>, SendArguments>, timeoutMs = 50) {
  return new S3RecoveryArtifactStorage({ ...config, timeoutMs }, { send } as unknown as Pick<
    S3Client,
    'send'
  >);
}

describe('S3RecoveryArtifactStorage', () => {
  it('writes immutable encrypted objects without a public ACL', async () => {
    const send = jest.fn<Promise<unknown>, SendArguments>().mockResolvedValue({});
    const body = Buffer.from('recovery');
    await storageWith(send).putBuffer({
      key: 'recovery/v1/database/id.dump',
      body,
      contentType: 'application/vnd.postgresql.custom',
      contentLength: body.byteLength,
      checksumSha256: 'a'.repeat(64),
    });
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: config.bucket,
      IfNoneMatch: '*',
      Metadata: { sha256: 'a'.repeat(64) },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.kmsKeyId,
    });
    expect(command.input).not.toHaveProperty('ACL');
  });

  it('maps immutable conflicts and provider errors to sanitized errors', async () => {
    const conflict = Object.assign(new Error('provider detail'), {
      $metadata: { httpStatusCode: 412 },
    });
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(new Error('secret provider detail'));
    const storage = storageWith(send);
    const input = {
      key: 'recovery/v1/item',
      body: Buffer.from('x'),
      contentType: 'application/octet-stream',
      contentLength: 1,
      checksumSha256: 'b'.repeat(64),
    };
    await expect(storage.putBuffer(input)).rejects.toBeInstanceOf(RecoveryStorageConflictError);
    await expect(storage.putBuffer(input)).rejects.toEqual(new RecoveryStorageUnavailableError());
  });

  it('bounds response body consumption and exposes only integrity metadata', async () => {
    const modified = new Date('2026-10-19T00:00:00.000Z');
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockResolvedValueOnce({ Body: chunks(Buffer.from('abc')), ContentLength: 3 })
      .mockResolvedValueOnce({
        ContentLength: 3,
        Metadata: { sha256: 'c'.repeat(64) },
        ServerSideEncryption: 'aws:kms',
        LastModified: modified,
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'recovery/v1/item', Size: 3, LastModified: modified }],
        IsTruncated: false,
      });
    const storage = storageWith(send);
    await expect(storage.readBuffer('recovery/v1/item', 3)).resolves.toEqual(Buffer.from('abc'));
    await expect(storage.headObject('recovery/v1/item')).resolves.toMatchObject({
      checksumSha256: 'c'.repeat(64),
      encryption: 'aws:kms',
    });
    await expect(
      storage.listObjects({ prefix: 'recovery/v1/', limit: 10, continuationToken: null }),
    ).resolves.toMatchObject({ objects: [{ key: 'recovery/v1/item' }], nextToken: null });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(ListObjectsV2Command);
  });

  it('times out stalled downloads without exposing provider detail', async () => {
    const send = jest
      .fn<Promise<unknown>, SendArguments>()
      .mockResolvedValue({ Body: stalledBody(), ContentLength: 1 });
    await expect(storageWith(send, 20).readBuffer('recovery/v1/key', 10)).rejects.toBeInstanceOf(
      RecoveryStorageUnavailableError,
    );
  });

  it('rejects keys outside the dedicated recovery namespace before provider access', async () => {
    const send = jest.fn<Promise<unknown>, SendArguments>().mockResolvedValue({});
    const storage = storageWith(send);

    await expect(storage.readBuffer('attachments/v1/item', 10)).rejects.toBeInstanceOf(
      RecoveryStorageUnavailableError,
    );
    await expect(
      storage.listObjects({ prefix: 'recovery/', limit: 10, continuationToken: null }),
    ).rejects.toBeInstanceOf(RecoveryStorageUnavailableError);
    expect(send).not.toHaveBeenCalled();
  });
});

async function* chunks(value: Buffer): AsyncIterable<Uint8Array> {
  yield value;
}

async function* stalledBody(): AsyncIterable<Uint8Array> {
  yield Buffer.from('x');
  await new Promise<void>(() => undefined);
}
