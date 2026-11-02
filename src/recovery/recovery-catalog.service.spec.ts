import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemRecoveryArtifactStorage } from './filesystem-recovery-artifact-storage';
import {
  RECOVERY_JOB_LOCK_STALE_AFTER_MS,
  RecoveryCatalogService,
} from './recovery-catalog.service';
import {
  recoveryArtifactKey,
  recoveryManifestKey,
  sha256,
  type VerifiedRecoveryManifest,
} from './recovery-manifest';

describe('RecoveryCatalogService', () => {
  let root: string;
  let storage: FilesystemRecoveryArtifactStorage;
  let catalog: RecoveryCatalogService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dokana-recovery-catalog-'));
    storage = new FilesystemRecoveryArtifactStorage(root);
    catalog = new RecoveryCatalogService(storage);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rediscovers the latest complete verified point and ignores incomplete state', async () => {
    await catalog.writeManifest({
      manifestVersion: '1',
      recoveryPointId: '42000000-0000-4000-8000-000000000001',
      state: 'CREATING',
      createdAt: '2026-10-18T00:00:00.000Z',
      environmentId: 'test',
      sourceRevision: null,
      backupType: 'postgresql-custom',
    });
    const first = await storeVerified(
      storage,
      catalog,
      '42000000-0000-4000-8000-000000000002',
      '2026-10-18T00:00:00.000Z',
      'MONTHLY',
    );
    const latest = await storeVerified(
      storage,
      catalog,
      '42000000-0000-4000-8000-000000000003',
      '2026-10-19T00:00:00.000Z',
      'DAILY',
    );

    await expect(
      new RecoveryCatalogService(storage).inspectVerifiedCatalog(),
    ).resolves.toMatchObject({ latestVerified: latest, verifiedCount: 2, invalidCount: 0 });
    expect(first.recoveryPointId).not.toBe(latest.recoveryPointId);
  });

  it('does not count a verified manifest whose artifact is missing or replaced', async () => {
    const manifest = verified(
      '42000000-0000-4000-8000-000000000004',
      '2026-10-19T00:00:00.000Z',
      'DAILY',
      Buffer.from('expected'),
    );
    await catalog.writeManifest(manifest);
    await expect(catalog.inspectVerifiedCatalog()).resolves.toMatchObject({
      latestVerified: null,
      verifiedCount: 0,
      invalidCount: 1,
    });
  });

  it('classifies one monthly generation and applies bounded fail-safe retention', async () => {
    await expect(catalog.classifyRetention(new Date('2026-10-19T00:00:00.000Z'))).resolves.toBe(
      'MONTHLY',
    );
    await storeVerified(
      storage,
      catalog,
      '42000000-0000-4000-8000-000000000005',
      '2025-09-01T00:00:00.000Z',
      'MONTHLY',
    );
    await storeVerified(
      storage,
      catalog,
      '42000000-0000-4000-8000-000000000006',
      '2026-08-01T00:00:00.000Z',
      'DAILY',
    );
    const newest = await storeVerified(
      storage,
      catalog,
      '42000000-0000-4000-8000-000000000007',
      '2026-10-19T00:00:00.000Z',
      'DAILY',
    );
    await expect(catalog.classifyRetention(new Date('2025-09-15T00:00:00.000Z'))).resolves.toBe(
      'DAILY',
    );
    const plan = await catalog.planRetention(new Date('2026-10-19T12:00:00.000Z'));
    expect(plan.expired.map((manifest) => manifest.recoveryPointId)).toEqual([
      '42000000-0000-4000-8000-000000000005',
      '42000000-0000-4000-8000-000000000006',
    ]);
    expect(plan.retained.map((manifest) => manifest.recoveryPointId)).toEqual([
      newest.recoveryPointId,
    ]);
    for (const manifest of plan.expired) await catalog.deleteRecoveryPoint(manifest);
    await expect(storage.headObject(newest.artifact.key)).resolves.not.toBeNull();
    await expect(storage.headObject(recoveryManifestKey(newest))).resolves.not.toBeNull();
  });

  it('does not let an incomplete monthly manifest reserve the monthly retention slot', async () => {
    await catalog.writeManifest(
      verified(
        '42000000-0000-4000-8000-000000000008',
        '2026-10-01T00:00:00.000Z',
        'MONTHLY',
        Buffer.from('missing-artifact'),
      ),
    );

    await expect(catalog.classifyRetention(new Date('2026-10-19T00:00:00.000Z'))).resolves.toBe(
      'MONTHLY',
    );
  });

  it('uses an external immutable lock for cross-process exclusion', async () => {
    const token = await catalog.acquireJobLock();
    await expect(catalog.acquireJobLock()).rejects.toThrow('already active');
    await expect(catalog.releaseJobLock('wrong-token')).rejects.toThrow('ownership');
    await catalog.releaseJobLock(token);
    await expect(catalog.acquireJobLock()).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('recovers an abandoned stale lock without trusting its client-supplied acquiredAt', async () => {
    const oldBodyTime = new Date('2020-01-01T00:00:00.000Z');
    const token = await catalog.acquireJobLock(oldBodyTime);
    const lockPath = join(root, 'recovery', 'v1', 'locks', 'logical-backup.json');
    const now = new Date('2026-10-20T00:00:00.000Z');

    await expect(catalog.acquireJobLock(now)).rejects.toThrow('already active');

    const staleTime = new Date(now.getTime() - RECOVERY_JOB_LOCK_STALE_AFTER_MS - 1);
    await utimes(lockPath, staleTime, staleTime);
    const replacement = await catalog.acquireJobLock(now);
    expect(replacement).not.toBe(token);
    await expect(catalog.releaseJobLock(token)).rejects.toThrow('ownership');
    await catalog.releaseJobLock(replacement);
  });

  it('allows only one contender to recover the same stale lock', async () => {
    await catalog.acquireJobLock();
    const lockPath = join(root, 'recovery', 'v1', 'locks', 'logical-backup.json');
    const now = new Date('2026-10-20T00:00:00.000Z');
    const staleTime = new Date(now.getTime() - RECOVERY_JOB_LOCK_STALE_AFTER_MS - 1);
    await utimes(lockPath, staleTime, staleTime);

    const contenders = await Promise.allSettled([
      new RecoveryCatalogService(storage).acquireJobLock(now),
      new RecoveryCatalogService(storage).acquireJobLock(now),
    ]);
    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled',
    );
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) throw new Error('Expected one stale-lock recovery winner.');
    await catalog.releaseJobLock(winner.value);
  });
});

async function storeVerified(
  storage: FilesystemRecoveryArtifactStorage,
  catalog: RecoveryCatalogService,
  id: string,
  createdAt: string,
  retentionClass: 'DAILY' | 'MONTHLY',
): Promise<VerifiedRecoveryManifest> {
  const body = Buffer.from(`archive-${id}`);
  const manifest = verified(id, createdAt, retentionClass, body);
  await storage.putBuffer({
    key: manifest.artifact.key,
    body,
    contentType: 'application/vnd.postgresql.custom',
    contentLength: body.byteLength,
    checksumSha256: manifest.artifact.sha256,
  });
  await catalog.writeManifest(manifest);
  return manifest;
}

function verified(
  id: string,
  createdAt: string,
  retentionClass: 'DAILY' | 'MONTHLY',
  body: Buffer,
): VerifiedRecoveryManifest {
  return {
    manifestVersion: '1',
    recoveryPointId: id,
    state: 'VERIFIED',
    createdAt,
    completedAt: createdAt,
    environmentId: 'test',
    sourceRevision: null,
    backupType: 'postgresql-custom',
    artifact: {
      key: recoveryArtifactKey(id),
      sizeBytes: body.byteLength,
      sha256: sha256(body),
    },
    postgres: { serverVersion: '18.0', toolVersion: 'pg_dump 18.0' },
    migrations: {
      appliedCount: 32,
      latestFilename: '0032_attachment_lifecycle_audit.sql',
      checksumStatus: 'PASS',
      checksumAggregateSha256: 'd'.repeat(64),
    },
    verification: { status: 'VERIFIED', structuralCheck: 'PASS', verifiedAt: createdAt },
    retentionClass,
  };
}
