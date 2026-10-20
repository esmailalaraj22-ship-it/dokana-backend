import {
  parseRecoveryManifest,
  recoveryArtifactKey,
  recoveryManifestKey,
  serializeRecoveryManifest,
  type VerifiedRecoveryManifest,
} from './recovery-manifest';

const manifest: VerifiedRecoveryManifest = {
  manifestVersion: '1',
  recoveryPointId: '41000000-0000-4000-8000-000000000001',
  state: 'VERIFIED',
  createdAt: '2026-10-19T00:00:00.000Z',
  completedAt: '2026-10-19T00:01:00.000Z',
  environmentId: 'test',
  sourceRevision: 'abcdef1',
  backupType: 'postgresql-custom',
  artifact: {
    key: 'recovery/v1/database/41000000-0000-4000-8000-000000000001.dump',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
  },
  postgres: { serverVersion: '18.0', toolVersion: 'pg_dump 18.0' },
  migrations: {
    appliedCount: 32,
    latestFilename: '0032_attachment_lifecycle_audit.sql',
    checksumStatus: 'PASS',
    checksumAggregateSha256: 'b'.repeat(64),
  },
  verification: {
    status: 'VERIFIED',
    structuralCheck: 'PASS',
    verifiedAt: '2026-10-19T00:02:00.000Z',
  },
  retentionClass: 'DAILY',
};

describe('recovery manifest', () => {
  it('round-trips only the bounded versioned safe contract', () => {
    expect(parseRecoveryManifest(serializeRecoveryManifest(manifest))).toEqual(manifest);
    expect(recoveryManifestKey(manifest)).toBe(
      'recovery/v1/manifests/verified/41000000-0000-4000-8000-000000000001.json',
    );
    expect(recoveryArtifactKey(manifest.recoveryPointId)).toBe(manifest.artifact.key);
    expect(JSON.stringify(manifest)).not.toMatch(/password|secret|connectionString|rawSql/iu);
  });

  it('rejects malformed identities, digests, and verification state', () => {
    expect(() =>
      parseRecoveryManifest(
        Buffer.from(JSON.stringify({ ...manifest, recoveryPointId: '../escape' })),
      ),
    ).toThrow();
    expect(() =>
      parseRecoveryManifest(
        Buffer.from(
          JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, sha256: 'weak' } }),
        ),
      ),
    ).toThrow();
  });
});
