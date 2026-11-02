import { createHash } from 'node:crypto';

import { Pool } from 'pg';

import {
  readEffectiveMigrationState,
  verifyMigrationChecksums,
  type MigrationIdentity,
} from '../migrations/effective-migration-state';
import { readMigrationFiles } from '../migrations/migration-files';

export const REQUIRED_RECOVERY_MIGRATION = '0033_platform_recovery_generation_fencing.sql';

export interface VerifiedMigrationState {
  appliedCount: number;
  latestFilename: string;
  checksumAggregateSha256: string;
  serverVersion: string;
  appliedFilenames: readonly string[];
}

export interface RecoveryManifestMigrationState {
  appliedCount: number;
  latestFilename: string;
  checksumAggregateSha256: string;
}

export async function readVerifiedMigrationState(
  connectionString: string,
): Promise<VerifiedMigrationState> {
  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL_MODE === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: 'dokana_recovery_migration_verification',
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    allowExitOnIdle: true,
  });
  try {
    const files = await readMigrationFiles();
    const [state, serverResult] = await Promise.all([
      readEffectiveMigrationState(pool, files),
      pool.query<{ version: string }>(`select current_setting('server_version') as version`),
    ]);
    if (state.pending.length !== 0) throw new Error('Recovery requires zero pending migrations.');
    const appliedFilenames = verifyEffectiveRecoveryMigrations(files, state.effective);
    const latestFilename = state.effective.at(-1)?.filename;
    const serverVersion = serverResult.rows[0]?.version;
    if (!latestFilename || !serverVersion) {
      throw new Error('Recovery migration identity is incomplete.');
    }
    const aggregate = state.effective
      .map((item) => `${item.filename}:${item.checksumSha256}\n`)
      .join('');
    return {
      appliedCount: state.effective.length,
      latestFilename,
      checksumAggregateSha256: createHash('sha256').update(aggregate).digest('hex'),
      serverVersion,
      appliedFilenames,
    };
  } finally {
    await pool.end();
  }
}

export function verifyAppliedMigrationLedger(
  files: readonly MigrationIdentity[],
  applied: readonly MigrationIdentity[],
): readonly string[] {
  return verifyEffectiveRecoveryMigrations(files, applied);
}

export function verifyEffectiveRecoveryMigrations(
  files: readonly MigrationIdentity[],
  effective: readonly MigrationIdentity[],
): readonly string[] {
  if (!effective.some((migration) => migration.filename === REQUIRED_RECOVERY_MIGRATION)) {
    throw new Error('Required recovery migration is missing.');
  }
  if (effective.length !== files.length || effective.length === 0) {
    throw new Error('Recovery requires zero pending migrations.');
  }
  try {
    verifyMigrationChecksums(files, effective);
  } catch {
    throw new Error('Migration checksum verification failed for recovery.');
  }
  return effective.map((migration) => migration.filename);
}

export function isRecoveryMigrationCompatible(
  source: VerifiedMigrationState,
  manifest: RecoveryManifestMigrationState,
): boolean {
  return (
    source.appliedFilenames.length === source.appliedCount &&
    source.appliedFilenames.at(-1) === source.latestFilename &&
    source.appliedFilenames.includes(REQUIRED_RECOVERY_MIGRATION) &&
    source.appliedCount === manifest.appliedCount &&
    source.latestFilename === manifest.latestFilename &&
    source.checksumAggregateSha256 === manifest.checksumAggregateSha256
  );
}

export function equalMigrationState(
  left: VerifiedMigrationState,
  right: VerifiedMigrationState,
): boolean {
  return (
    left.appliedCount === right.appliedCount &&
    left.latestFilename === right.latestFilename &&
    left.checksumAggregateSha256 === right.checksumAggregateSha256 &&
    left.serverVersion === right.serverVersion
  );
}
