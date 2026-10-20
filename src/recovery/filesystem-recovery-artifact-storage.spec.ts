import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemRecoveryArtifactStorage } from './filesystem-recovery-artifact-storage';
import {
  RecoveryStorageConflictError,
  RecoveryStorageUnavailableError,
} from './recovery-artifact-storage.port';
import { sha256 } from './recovery-manifest';

describe('FilesystemRecoveryArtifactStorage', () => {
  let root: string;
  let storage: FilesystemRecoveryArtifactStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dokana-recovery-storage-'));
    storage = new FilesystemRecoveryArtifactStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects keys outside the dedicated recovery namespace', async () => {
    await expect(storage.readBuffer('attachments/v1/item', 10)).rejects.toBeInstanceOf(
      RecoveryStorageUnavailableError,
    );
    await expect(
      storage.listObjects({ prefix: 'recovery/', limit: 10, continuationToken: null }),
    ).rejects.toBeInstanceOf(RecoveryStorageUnavailableError);
  });

  it('stores immutable private test objects and supports bounded prefix reads', async () => {
    const body = Buffer.from('verified manifest');
    const input = {
      key: 'recovery/v1/manifests/verified/item.json',
      body,
      contentType: 'application/json',
      contentLength: body.byteLength,
      checksumSha256: sha256(body),
    };
    await storage.putBuffer(input);
    await expect(storage.putBuffer({ ...input, body: Buffer.from(body) })).rejects.toBeInstanceOf(
      RecoveryStorageConflictError,
    );
    await expect(storage.readBuffer(input.key, 1_024)).resolves.toEqual(body);
    await expect(
      storage.listObjects({
        prefix: 'recovery/v1/manifests/verified/',
        limit: 10,
        continuationToken: null,
      }),
    ).resolves.toMatchObject({
      objects: [
        {
          key: input.key,
          contentLength: body.byteLength,
          checksumSha256: input.checksumSha256,
          encryption: 'test-only-filesystem',
        },
      ],
      nextToken: null,
    });
    expect(await readFile(join(root, ...input.key.split('/')))).toEqual(body);
  });

  it('does not delete an existing immutable object when a concurrent write conflicts', async () => {
    const key = 'recovery/v1/database/existing.dump';
    const original = Buffer.from('original');
    await storage.putBuffer({
      key,
      body: original,
      contentType: 'application/octet-stream',
      contentLength: original.byteLength,
      checksumSha256: sha256(original),
    });
    await expect(
      storage.putBuffer({
        key,
        body: Buffer.from('replacement'),
        contentType: 'application/octet-stream',
        contentLength: 11,
        checksumSha256: sha256(Buffer.from('replacement')),
      }),
    ).rejects.toBeInstanceOf(RecoveryStorageConflictError);
    await expect(storage.readBuffer(key, 100)).resolves.toEqual(original);
  });

  it('streams files to and from storage with exact declared lengths', async () => {
    const source = join(root, 'source.tmp');
    const target = join(root, 'download.tmp');
    const body = Buffer.from('database archive');
    await writeFile(source, body);
    await storage.putFile({
      key: 'recovery/v1/database/archive.dump',
      sourcePath: source,
      contentType: 'application/vnd.postgresql.custom',
      contentLength: body.byteLength,
      checksumSha256: sha256(body),
    });
    await expect(
      storage.downloadToFile('recovery/v1/database/archive.dump', target, 100),
    ).resolves.toBe(true);
    expect(await readFile(target)).toEqual(body);
  });
});
