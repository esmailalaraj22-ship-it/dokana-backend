import {
  readEffectiveMigrationState,
  type MigrationStateQuery,
} from '../../scripts/migrations/effective-migration-state';
import { sha256, type MigrationFile } from '../../scripts/migrations/migration-files';

const files: MigrationFile[] = [1, 2, 3, 4].map((number) => ({
  filename: `${String(number).padStart(4, '0')}_test.sql`,
  absolutePath: '<test-only>',
  contents: 'select 1;',
  checksumSha256: sha256('select 1;'),
}));

function clientFor(executedIndexes: number[], baselineCount = 0): MigrationStateQuery {
  const identities = files.map(({ filename, checksumSha256 }) => ({ filename, checksumSha256 }));
  const query = jest
    .fn()
    .mockResolvedValueOnce({
      rows: [{ ledger: 'platform.schema_migrations', owner: 'shop_app_migrator' }],
    })
    .mockResolvedValueOnce({ rows: executedIndexes.map((index) => identities[index]) })
    .mockResolvedValueOnce({ rows: [{ relation: 'platform.release_baseline_provenance' }] })
    .mockResolvedValueOnce({
      rows: baselineCount
        ? [
            {
              formatVersion: 1,
              baselineIdentifier: 'test-baseline',
              sourceGitHead: '1'.repeat(40),
              artifactSha256: '2'.repeat(64),
              catalogFingerprintSha256: '3'.repeat(64),
              migrationCeiling: identities[baselineCount - 1]?.filename,
              migrationChecksumManifest: identities.slice(0, baselineCount),
              registeredAt: '2026-01-01T00:00:00Z',
            },
          ]
        : [],
    });
  return { query };
}

describe('effective migration history ordering', () => {
  it.each([
    [0, 2],
    [1, 2],
    [0, 1, 3],
  ])('rejects an executed history hole: %j', async (...indexes) => {
    await expect(readEffectiveMigrationState(clientFor(indexes), files)).rejects.toThrow(
      'not a contiguous repository prefix',
    );
  });

  it('rejects a hole between the baseline and later executed migrations', async () => {
    await expect(readEffectiveMigrationState(clientFor([3], 2), files)).rejects.toThrow(
      'not a contiguous repository prefix',
    );
  });

  it.each([0, 2])('accepts a valid prefix with %i baseline entries', async (baselineCount) => {
    const executed = baselineCount ? [2] : [0, 1, 2];
    const state = await readEffectiveMigrationState(clientFor(executed, baselineCount), files);
    expect(state.effective.map((entry) => entry.filename)).toEqual(
      files.slice(0, 3).map((entry) => entry.filename),
    );
    expect(state.executed).toHaveLength(executed.length);
    expect(state.pending).toEqual(files.slice(3));
  });
});
