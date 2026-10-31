import {
  isRecoveryMigrationCompatible,
  REQUIRED_RECOVERY_MIGRATION,
  verifyAppliedMigrationLedger,
  type RecoveryManifestMigrationState,
  type VerifiedMigrationState,
} from '../../scripts/recovery/migration-state';

const migration0034 = '0034_retire_broken_recovery_session_wrapper.sql';

describe('recovery migration compatibility', () => {
  it('accepts an exact post-0033 source and manifest state', () => {
    const source = migrationState([REQUIRED_RECOVERY_MIGRATION, migration0034], 'a');

    expect(isRecoveryMigrationCompatible(source, manifestState(source))).toBe(true);
  });

  it('rejects every material source and manifest migration mismatch', () => {
    const source = migrationState([REQUIRED_RECOVERY_MIGRATION, migration0034], 'a');
    const manifest = manifestState(source);

    expect(
      isRecoveryMigrationCompatible(source, {
        ...manifest,
        appliedCount: manifest.appliedCount - 1,
      }),
    ).toBe(false);
    expect(
      isRecoveryMigrationCompatible(source, {
        ...manifest,
        latestFilename: REQUIRED_RECOVERY_MIGRATION,
      }),
    ).toBe(false);
    expect(
      isRecoveryMigrationCompatible(source, {
        ...manifest,
        checksumAggregateSha256: 'b'.repeat(64),
      }),
    ).toBe(false);
  });

  it('rejects a migration state without the required recovery capability', () => {
    const source = migrationState(['0032_attachment_lifecycle_audit.sql', migration0034], 'a');

    expect(isRecoveryMigrationCompatible(source, manifestState(source))).toBe(false);
    expect(() =>
      verifyAppliedMigrationLedger(
        [
          migrationIdentity(REQUIRED_RECOVERY_MIGRATION, '1'),
          migrationIdentity(migration0034, '2'),
        ],
        [
          migrationIdentity('0032_attachment_lifecycle_audit.sql', '1'),
          migrationIdentity(migration0034, '2'),
        ],
      ),
    ).toThrow('Required recovery migration is missing.');
  });

  it('rejects an invalid checksum for the required recovery migration', () => {
    expect(() =>
      verifyAppliedMigrationLedger(
        [
          migrationIdentity(REQUIRED_RECOVERY_MIGRATION, '1'),
          migrationIdentity(migration0034, '2'),
        ],
        [
          migrationIdentity(REQUIRED_RECOVERY_MIGRATION, '9'),
          migrationIdentity(migration0034, '2'),
        ],
      ),
    ).toThrow('Migration checksum verification failed for recovery.');
  });

  it('accepts an exact hypothetical later state without changing the capability floor', () => {
    const source = migrationState(
      [REQUIRED_RECOVERY_MIGRATION, migration0034, '0099_hypothetical_later_migration.sql'],
      'c',
    );

    expect(isRecoveryMigrationCompatible(source, manifestState(source))).toBe(true);
  });
});

function migrationState(
  appliedFilenames: readonly string[],
  checksumCharacter: string,
): VerifiedMigrationState {
  const latestFilename = appliedFilenames.at(-1);
  if (!latestFilename) throw new Error('The test migration state must not be empty.');
  return {
    appliedCount: appliedFilenames.length,
    latestFilename,
    checksumAggregateSha256: checksumCharacter.repeat(64),
    serverVersion: '18.0',
    appliedFilenames,
  };
}

function manifestState(source: VerifiedMigrationState): RecoveryManifestMigrationState {
  return {
    appliedCount: source.appliedCount,
    latestFilename: source.latestFilename,
    checksumAggregateSha256: source.checksumAggregateSha256,
  };
}

function migrationIdentity(filename: string, checksumCharacter: string) {
  return { filename, checksumSha256: checksumCharacter.repeat(64) };
}
