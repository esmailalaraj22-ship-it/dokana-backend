import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { readCatalogFingerprint } from '../scripts/migrations/catalog-fingerprint';
import { readEffectiveMigrationState } from '../scripts/migrations/effective-migration-state';
import {
  sha256,
  readMigrationFiles,
  type MigrationFile,
} from '../scripts/migrations/migration-files';
import { registerReleaseBaseline } from '../scripts/migrations/release-baseline-provenance';
import { readVerifiedMigrationState } from '../scripts/recovery/migration-state';
import {
  createSchemaOnlyCustomFormatDump,
  resolvePostgresToolchain,
  restoreCustomFormatDump,
} from '../scripts/recovery/postgres-tools';
import { sha256File } from '../scripts/recovery/recovery-point-job';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

jest.setTimeout(180_000);

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;

describeDatabase('release baseline provenance with real PostgreSQL', () => {
  const databaseName = `dokana_s234_${crypto.randomUUID().replaceAll('-', '')}`;
  let directory = '';
  let management: Pool | null = null;
  let admin: Pool | null = null;
  let migration: Pool | null = null;
  let artifactPath = '';
  let created = false;

  beforeAll(async () => {
    if (!environment) return;
    directory = await mkdtemp(join(tmpdir(), 'dokana-s234-provenance-'));
    artifactPath = join(directory, 'synthetic-baseline.dump');
    const toolchain = await resolvePostgresToolchain(
      process.env.RECOVERY_POSTGRES_BIN_DIR,
      120_000,
    );
    await createSchemaOnlyCustomFormatDump(toolchain, environment.adminUrl, artifactPath);

    management = createTestPool(
      withDatabase(environment.adminUrl, 'postgres'),
      'dokana-s234-provenance-management',
      1,
    );
    await management.query(`create database "${databaseName}" template template0`);
    created = true;
    await management.query(
      `grant connect on database "${databaseName}" to dokana_migration_login, dokana_auth_login`,
    );

    const adminUrl = withDatabase(environment.adminUrl, databaseName);
    await restoreCustomFormatDump(toolchain, adminUrl, artifactPath);
    admin = createTestPool(adminUrl, 'dokana-s234-provenance-admin', 1);
    migration = createTestPool(
      withDatabase(environment.migrationUrl, databaseName),
      'dokana-s234-provenance-migration',
      1,
    );
  });

  afterAll(async () => {
    await Promise.all([admin?.end(), migration?.end()]);
    if (created && management) {
      await management.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
        [databaseName],
      );
      await management.query(`drop database if exists "${databaseName}"`);
    }
    await management?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('registers immutable baseline provenance and executes one future migration truthfully', async () => {
    if (!environment) throw new Error('PostgreSQL test environment is required.');
    if (!admin || !migration) throw new Error('Provenance test database is unavailable.');
    const files = await readMigrationFiles();
    const manifest = files.map(({ filename, checksumSha256 }) => ({ filename, checksumSha256 }));
    const fingerprint = await readCatalogFingerprint(admin);
    const source = createTestPool(environment.adminUrl, 'dokana-s234-provenance-source', 1);
    try {
      const sourceFingerprint = await readCatalogFingerprint(source);
      expect(
        catalogDifferences(sourceFingerprint.canonicalJson, fingerprint.canonicalJson),
      ).toEqual([]);
      await expect(
        source.query<{ migrations: number; provenance: number }>(`
          select
            (select count(*)::integer from platform.schema_migrations
             where filename='0035_release_baseline_provenance.sql') as migrations,
            (select count(*)::integer from platform.release_baseline_provenance) as provenance
        `),
      ).resolves.toMatchObject({ rows: [{ migrations: 1, provenance: 0 }] });
    } finally {
      await source.end();
    }

    await expect(
      admin.query<{
        owner: string;
        runtimeSelect: boolean;
        runtimeWrite: boolean;
        runtimeExecute: boolean;
        publicExecute: boolean;
      }>(`
        select
          pg_get_userbyid(c.relowner) as owner,
          has_table_privilege('shop_app_runtime', c.oid, 'SELECT') as "runtimeSelect",
          has_table_privilege('shop_app_runtime', c.oid, 'INSERT,UPDATE,DELETE') as "runtimeWrite",
          has_function_privilege(
            'shop_app_runtime',
            'platform.register_release_baseline_provenance_v1(integer,text,text,text,text,text,jsonb)',
            'EXECUTE'
          ) as "runtimeExecute",
          exists (
            select 1
            from pg_proc p
            join pg_namespace function_schema on function_schema.oid=p.pronamespace
            cross join lateral aclexplode(
              coalesce(p.proacl, acldefault('f', p.proowner))
            ) privilege
            where function_schema.nspname='platform'
              and p.proname='register_release_baseline_provenance_v1'
              and privilege.grantee=0
              and privilege.privilege_type='EXECUTE'
          ) as "publicExecute"
        from pg_class c
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname='release_baseline_provenance'
      `),
    ).resolves.toMatchObject({
      rows: [
        {
          owner: 'shop_app_migrator',
          runtimeSelect: false,
          runtimeWrite: false,
          runtimeExecute: false,
          publicExecute: false,
        },
      ],
    });
    const input = {
      formatVersion: 1 as const,
      baselineIdentifier: 's23.4-synthetic-test',
      sourceGitHead: '1'.repeat(40),
      artifactPath,
      artifactSha256: await sha256File(artifactPath),
      catalogFingerprintSha256: fingerprint.sha256,
      migrationCeiling: files.at(-1)?.filename ?? '',
      migrationChecksumManifest: manifest,
    };

    await expect(registerWithNewClient(input)).resolves.toMatchObject({
      replayed: false,
      effectiveMigrationCount: files.length,
    });
    await expect(registerWithNewClient(input)).resolves.toMatchObject({ replayed: true });

    await expect(
      registerWithNewClient({ ...input, baselineIdentifier: 's23.4-conflict' }),
    ).rejects.toThrow('Conflicting release baseline provenance exists');
    await expect(
      registerWithNewClient({ ...input, artifactSha256: 'f'.repeat(64) }),
    ).rejects.toThrow('artifact checksum');
    await expect(
      registerWithNewClient({ ...input, catalogFingerprintSha256: 'e'.repeat(64) }),
    ).rejects.toThrow('catalog fingerprint');
    await expect(
      registerWithNewClient({
        ...input,
        migrationChecksumManifest: manifest.map((entry, index) =>
          index === 0 ? { ...entry, checksumSha256: 'd'.repeat(64) } : entry,
        ),
      }),
    ).rejects.toThrow('migration manifest');

    const state = await readEffectiveMigrationState(admin, files);
    expect(state.executed).toHaveLength(0);
    expect(state.baseline?.migrationChecksumManifest).toHaveLength(files.length);
    expect(state.pending).toHaveLength(0);
    await expect(
      readVerifiedMigrationState(withDatabase(environment.adminUrl, databaseName)),
    ).resolves.toMatchObject({
      appliedCount: files.length,
      latestFilename: input.migrationCeiling,
    });

    const mutation = await migration.connect();
    try {
      await verifyMigrationSession(mutation);
      await expect(
        mutation.query(`update platform.release_baseline_provenance set baseline_identifier='x'`),
      ).rejects.toThrow('immutable');
      await mutation.query('reset role');
    } finally {
      mutation.release();
    }

    const syntheticContents = `create table platform.s23_4_future_upgrade_probe (id integer primary key);`;
    const synthetic: MigrationFile = {
      filename: '9999_test_only_future_upgrade.sql',
      absolutePath: '<test-only>',
      contents: syntheticContents,
      checksumSha256: sha256(syntheticContents),
    };
    const migrationClient = await migration.connect();
    try {
      await verifyMigrationSession(migrationClient);
      const before = await readEffectiveMigrationState(migrationClient, [...files, synthetic]);
      expect(before.pending.map((file) => file.filename)).toEqual([synthetic.filename]);
      await applyMigration(migrationClient, synthetic);
      const after = await readEffectiveMigrationState(migrationClient, [...files, synthetic]);
      expect(after.executed).toEqual([
        { filename: synthetic.filename, checksumSha256: synthetic.checksumSha256 },
      ]);
      expect(after.baseline?.migrationChecksumManifest).toEqual(manifest);
      expect(after.pending).toHaveLength(0);
      expect(
        await migrationClient.query<{ count: number }>(
          `select count(*)::integer as count from platform.schema_migrations where filename=$1`,
          [synthetic.filename],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });
      await expect(
        readEffectiveMigrationState(migrationClient, [
          ...files,
          { ...synthetic, checksumSha256: 'c'.repeat(64) },
        ]),
      ).rejects.toThrow('checksum mismatch');
      await migrationClient.query('reset role');
    } finally {
      migrationClient.release();
    }
  });

  async function registerWithNewClient(
    input: Parameters<typeof registerReleaseBaseline>[1],
  ): Promise<Awaited<ReturnType<typeof registerReleaseBaseline>>> {
    if (!migration) throw new Error('Provenance migration pool is unavailable.');
    const client = await migration.connect();
    try {
      return await registerReleaseBaseline(client, input);
    } finally {
      client.release();
    }
  }
});

function withDatabase(connectionString: string, databaseName: string): string {
  const value = new URL(connectionString);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

function catalogDifferences(leftJson: string, rightJson: string): string[] {
  const left = JSON.parse(leftJson) as Record<string, unknown>;
  const right = JSON.parse(rightJson) as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
  );
}
