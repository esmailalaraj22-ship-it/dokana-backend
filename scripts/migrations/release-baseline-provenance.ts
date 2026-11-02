import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { PoolClient } from 'pg';

import { verifyMigrationSession } from '../migrate';
import { readCatalogFingerprint } from './catalog-fingerprint';
import { readEffectiveMigrationState, type MigrationIdentity } from './effective-migration-state';
import { readMigrationFiles } from './migration-files';

export interface ReleaseBaselineRegistrationInput {
  formatVersion: number;
  baselineIdentifier: string;
  sourceGitHead: string;
  artifactPath: string;
  artifactSha256: string;
  catalogFingerprintSha256: string;
  migrationCeiling: string;
  migrationChecksumManifest: readonly MigrationIdentity[];
}

export interface ReleaseBaselineRegistrationResult {
  registeredAt: string;
  replayed: boolean;
  effectiveMigrationCount: number;
}

export async function registerReleaseBaseline(
  client: PoolClient,
  input: ReleaseBaselineRegistrationInput,
): Promise<ReleaseBaselineRegistrationResult> {
  validateInput(input);
  const artifact = await readFile(input.artifactPath);
  if (createHash('sha256').update(artifact).digest('hex') !== input.artifactSha256) {
    throw new Error('Release baseline artifact checksum does not match provenance.');
  }
  const files = await readMigrationFiles();
  const expectedManifest = files
    .filter((file) => file.filename <= input.migrationCeiling)
    .map(({ filename, checksumSha256 }) => ({ filename, checksumSha256 }));
  if (JSON.stringify(expectedManifest) !== JSON.stringify(input.migrationChecksumManifest)) {
    throw new Error('Release baseline migration manifest does not match repository truth.');
  }
  if (expectedManifest.at(-1)?.filename !== input.migrationCeiling) {
    throw new Error('Release baseline migration ceiling does not exist in repository truth.');
  }

  await verifyMigrationSession(client);
  let transactionStarted = false;
  try {
    const fingerprint = await readCatalogFingerprint(client);
    if (fingerprint.sha256 !== input.catalogFingerprintSha256) {
      throw new Error('Release baseline catalog fingerprint does not match the target database.');
    }

    await client.query('begin');
    transactionStarted = true;
    await client.query('set local role shop_app_migrator');
    const result = await client.query<{ registeredAt: string; replayed: boolean }>(
      `
        select registered_at::text as "registeredAt", replayed
        from platform.register_release_baseline_provenance_v1(
          $1, $2, $3, $4, $5, $6, $7::jsonb
        )
      `,
      [
        input.formatVersion,
        input.baselineIdentifier,
        input.sourceGitHead,
        input.artifactSha256,
        input.catalogFingerprintSha256,
        input.migrationCeiling,
        JSON.stringify(input.migrationChecksumManifest),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Release baseline registration returned no result.');
    await client.query('commit');
    transactionStarted = false;

    const state = await readEffectiveMigrationState(client, files);
    if (state.pending.length !== 0 || !state.baseline) {
      throw new Error('Release baseline registration did not establish effective migration state.');
    }
    return {
      registeredAt: row.registeredAt,
      replayed: row.replayed,
      effectiveMigrationCount: state.effective.length,
    };
  } catch (error) {
    if (transactionStarted) await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query('reset role').catch(() => undefined);
  }
}

export async function readReleaseBaselineRegistrationInput(
  path: string,
): Promise<ReleaseBaselineRegistrationInput> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Release baseline provenance document is invalid.');
  }
  const value = parsed as Record<string, unknown>;
  const input: ReleaseBaselineRegistrationInput = {
    formatVersion: value.formatVersion as number,
    baselineIdentifier: value.baselineIdentifier as string,
    sourceGitHead: value.sourceGitHead as string,
    artifactPath: value.artifactPath as string,
    artifactSha256: value.artifactSha256 as string,
    catalogFingerprintSha256: value.catalogFingerprintSha256 as string,
    migrationCeiling: value.migrationCeiling as string,
    migrationChecksumManifest: value.migrationChecksumManifest as readonly MigrationIdentity[],
  };
  validateInput(input);
  return input;
}

function validateInput(input: ReleaseBaselineRegistrationInput): void {
  if (
    input.formatVersion !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.baselineIdentifier) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.sourceGitHead) ||
    !/^[0-9a-f]{64}$/.test(input.artifactSha256) ||
    !/^[0-9a-f]{64}$/.test(input.catalogFingerprintSha256) ||
    !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(input.migrationCeiling) ||
    typeof input.artifactPath !== 'string' ||
    input.artifactPath.length === 0 ||
    !Array.isArray(input.migrationChecksumManifest)
  ) {
    throw new Error('Release baseline provenance document is invalid.');
  }
}
