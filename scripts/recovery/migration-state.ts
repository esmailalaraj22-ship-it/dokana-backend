import { createHash } from 'node:crypto';

import { Pool } from 'pg';

import { readMigrationFiles } from '../migrations/migration-files';

export interface VerifiedMigrationState {
  appliedCount: number;
  latestFilename: string;
  checksumAggregateSha256: string;
  serverVersion: string;
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
    const [files, appliedResult, serverResult] = await Promise.all([
      readMigrationFiles(),
      pool.query<{ filename: string; checksumSha256: string }>(`
        select filename, checksum_sha256 as "checksumSha256"
        from platform.schema_migrations
        order by filename
      `),
      pool.query<{ version: string }>(`select current_setting('server_version') as version`),
    ]);
    const applied = appliedResult.rows;
    if (applied.length !== files.length || applied.length === 0) {
      throw new Error('Recovery requires zero pending migrations.');
    }
    const filesByName = new Map(files.map((file) => [file.filename, file]));
    for (const migration of applied) {
      const file = filesByName.get(migration.filename);
      if (file?.checksumSha256 !== migration.checksumSha256) {
        throw new Error('Migration checksum verification failed for recovery.');
      }
    }
    const latestFilename = applied.at(-1)?.filename;
    const serverVersion = serverResult.rows[0]?.version;
    if (!latestFilename || !serverVersion) {
      throw new Error('Recovery migration identity is incomplete.');
    }
    const aggregate = applied.map((item) => `${item.filename}:${item.checksumSha256}\n`).join('');
    return {
      appliedCount: applied.length,
      latestFilename,
      checksumAggregateSha256: createHash('sha256').update(aggregate).digest('hex'),
      serverVersion,
    };
  } finally {
    await pool.end();
  }
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
