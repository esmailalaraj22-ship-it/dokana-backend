import type { Pool } from 'pg';

import type { MigrationFile } from './migration-files';

export interface MigrationIdentity {
  filename: string;
  checksumSha256: string;
}

export interface ReleaseBaselineProvenance {
  formatVersion: number;
  baselineIdentifier: string;
  sourceGitHead: string;
  artifactSha256: string;
  catalogFingerprintSha256: string;
  migrationCeiling: string;
  migrationChecksumManifest: readonly MigrationIdentity[];
  registeredAt: string;
}

export interface EffectiveMigrationState {
  executed: readonly MigrationIdentity[];
  baseline: ReleaseBaselineProvenance | null;
  effective: readonly MigrationIdentity[];
  pending: readonly MigrationFile[];
}

export interface MigrationStateQuery {
  query: Pool['query'];
}

interface ProvenanceRow {
  formatVersion: number;
  baselineIdentifier: string;
  sourceGitHead: string;
  artifactSha256: string;
  catalogFingerprintSha256: string;
  migrationCeiling: string;
  migrationChecksumManifest: unknown;
  registeredAt: string;
}

export async function readEffectiveMigrationState(
  client: MigrationStateQuery,
  files: readonly MigrationFile[],
): Promise<EffectiveMigrationState> {
  const ledger = await client.query<{ ledger: string | null; owner: string | null }>(`
    select
      to_regclass('platform.schema_migrations')::text as ledger,
      case
        when to_regclass('platform.schema_migrations') is null then null
        else pg_get_userbyid(
          (select relowner from pg_class where oid = 'platform.schema_migrations'::regclass)
        )
      end as owner
  `);
  const ledgerState = ledger.rows[0];
  if (
    ledgerState?.ledger !== 'platform.schema_migrations' ||
    ledgerState.owner !== 'shop_app_migrator'
  ) {
    throw new Error('The verified migration foundation is not installed.');
  }

  const executed = (
    await client.query<MigrationIdentity>(`
      select filename, checksum_sha256 as "checksumSha256"
      from platform.schema_migrations
      order by filename
    `)
  ).rows;
  verifyMigrationChecksums(files, executed);

  const provenanceRelation = await client.query<{ relation: string | null }>(
    `select to_regclass('platform.release_baseline_provenance')::text as relation`,
  );
  let baseline: ReleaseBaselineProvenance | null = null;
  if (provenanceRelation.rows[0]?.relation === 'platform.release_baseline_provenance') {
    const rows = await client.query<ProvenanceRow>(`
      select
        format_version as "formatVersion",
        baseline_identifier as "baselineIdentifier",
        source_git_head as "sourceGitHead",
        artifact_sha256 as "artifactSha256",
        catalog_fingerprint_sha256 as "catalogFingerprintSha256",
        migration_ceiling as "migrationCeiling",
        migration_checksum_manifest as "migrationChecksumManifest",
        registered_at::text as "registeredAt"
      from platform.release_baseline_provenance
      order by singleton_key
    `);
    if (rows.rows.length > 1) throw new Error('Multiple release baseline provenance rows exist.');
    const row = rows.rows[0];
    if (row) baseline = validateBaselineProvenance(row, files);
  }

  if (baseline && executed.some((migration) => migration.filename <= baseline.migrationCeiling)) {
    throw new Error('Executed migration history overlaps the release baseline ceiling.');
  }

  const effective = [...(baseline?.migrationChecksumManifest ?? []), ...executed].sort(
    (left, right) => left.filename.localeCompare(right.filename, 'en'),
  );
  const effectiveNames = new Set(effective.map((migration) => migration.filename));
  const pending = files.filter((file) => !effectiveNames.has(file.filename));

  return { executed, baseline, effective, pending };
}

export function verifyMigrationChecksums(
  files: readonly MigrationIdentity[],
  recorded: readonly MigrationIdentity[],
): void {
  const filesByName = new Map(files.map((file) => [file.filename, file]));
  for (const migration of recorded) {
    const file = filesByName.get(migration.filename);
    if (!file) throw new Error(`Recorded migration file is missing: ${migration.filename}.`);
    if (file.checksumSha256 !== migration.checksumSha256) {
      throw new Error(`Migration checksum mismatch: ${migration.filename}.`);
    }
  }
}

function validateBaselineProvenance(
  row: ProvenanceRow,
  files: readonly MigrationFile[],
): ReleaseBaselineProvenance {
  if (
    row.formatVersion !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row.baselineIdentifier) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(row.sourceGitHead) ||
    !/^[0-9a-f]{64}$/.test(row.artifactSha256) ||
    !/^[0-9a-f]{64}$/.test(row.catalogFingerprintSha256)
  ) {
    throw new Error('Release baseline provenance is invalid.');
  }
  const manifest = parseManifest(row.migrationChecksumManifest);
  const expected = files.filter((file) => file.filename <= row.migrationCeiling);
  if (
    expected.length === 0 ||
    expected.at(-1)?.filename !== row.migrationCeiling ||
    manifest.length !== expected.length
  ) {
    throw new Error('Release baseline migration ceiling is invalid.');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = manifest[index];
    const repository = expected[index];
    if (
      !actual ||
      actual.filename !== repository?.filename ||
      actual.checksumSha256 !== repository.checksumSha256
    ) {
      throw new Error('Release baseline migration manifest does not match repository truth.');
    }
  }
  return { ...row, migrationChecksumManifest: manifest };
}

function parseManifest(value: unknown): MigrationIdentity[] {
  if (!Array.isArray(value)) throw new Error('Release baseline migration manifest is invalid.');
  const entries: unknown[] = value;
  return entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Object.keys(entry).sort().join(',') !== 'checksumSha256,filename'
    ) {
      throw new Error('Release baseline migration manifest is invalid.');
    }
    const record = entry as Record<string, unknown>;
    const filename = record.filename;
    const checksumSha256 = record.checksumSha256;
    if (
      typeof filename !== 'string' ||
      !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(filename) ||
      typeof checksumSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(checksumSha256)
    ) {
      throw new Error('Release baseline migration manifest is invalid.');
    }
    return { filename, checksumSha256 };
  });
}
