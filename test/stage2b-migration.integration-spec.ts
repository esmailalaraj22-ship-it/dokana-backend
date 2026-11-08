import { applyMigration, runMigrationCommand, verifyMigrationSession } from '../scripts/migrate';
import { readCatalogFingerprint } from '../scripts/migrations/catalog-fingerprint';
import { sha256 } from '../scripts/migrations/migration-files';
import * as migrationFiles from '../scripts/migrations/migration-files';
import {
  isRecoveryMigrationCompatible,
  readVerifiedMigrationState,
} from '../scripts/recovery/migration-state';
import { withDatabase } from '../scripts/recovery/recovery-target';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;
const filename = '0038_entitlement_time_after_authority_locks.sql';
jest.setTimeout(120_000);

describeDatabase('Stage 2B disposable 0037 to 0038 migration', () => {
  let database: InventoryTestDatabase;
  let initialized = false;
  let migrationUrl: string;
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  let historicalFiles: Awaited<ReturnType<typeof migrationFiles.readMigrationFiles>>;

  beforeEach(() => {
    jest.spyOn(migrationFiles, 'readMigrationFiles').mockResolvedValue(historicalFiles);
  });

  beforeAll(async () => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    database = await createInventoryTestDatabase(filename);
    initialized = true;
    historicalFiles = (await migrationFiles.readMigrationFiles()).filter(
      (file) => file.filename <= filename,
    );
    migrationUrl = withDatabase(environment.migrationUrl, database.databaseName);
  });

  afterAll(async () => {
    if (initialized) await database.close();
  });

  it('rolls back a forced failure, upgrades canonically, and repeats without history changes', async () => {
    const fingerprint = await readCatalogFingerprint(database.admin);
    before = JSON.parse(fingerprint.canonicalJson) as Record<string, unknown>;
    const history = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    expect(history).toHaveLength(37);
    const client = await database.migration.connect();
    try {
      await verifyMigrationSession(client);
      const contents =
        database.file.contents +
        "\nDO $failure$ BEGIN RAISE EXCEPTION 'stage2b forced failure'; END $failure$;";
      await expect(
        applyMigration(client, { ...database.file, contents, checksumSha256: sha256(contents) }),
      ).rejects.toThrow('stage2b forced failure');
    } finally {
      await client.query('reset role');
      client.release();
    }
    expect((await readCatalogFingerprint(database.admin)).sha256).toBe(fingerprint.sha256);
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(history);
    await runMigrationCommand('apply', migrationUrl);
    await runMigrationCommand('verify', migrationUrl);
    after = JSON.parse((await readCatalogFingerprint(database.admin)).canonicalJson) as Record<
      string,
      unknown
    >;
    const upgraded = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    expect(upgraded).toHaveLength(38);
    expect(upgraded.slice(0, 37)).toEqual(history);
    expect(upgraded[37]).toMatchObject({ filename, checksum_sha256: database.file.checksumSha256 });
    await runMigrationCommand('apply', migrationUrl);
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(upgraded);
  });

  it('changes only the authorized function body with all other catalog state identical', () => {
    expect(
      Object.keys(before).filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      ),
    ).toEqual(['routines']);
    const oldRoutines = before.routines as Record<string, unknown>[];
    const newRoutines = after.routines as Record<string, unknown>[];
    expect(newRoutines).toHaveLength(oldRoutines.length);
    const changed = newRoutines.filter(
      (row, index) => JSON.stringify(row) !== JSON.stringify(oldRoutines[index]),
    );
    expect(changed).toHaveLength(1);
    const routine = changed[0];
    if (!routine) throw new Error('Expected changed entitlement function.');
    const prior = oldRoutines[newRoutines.indexOf(routine)];
    expect(routine).toMatchObject({
      schema: 'ledger',
      name: 'lock_effective_entitlement',
      owner: 'shop_app_migrator',
      securityDefiner: true,
      configuration: 'search_path=pg_catalog, pg_temp',
    });
    expect({ ...routine, definition: prior?.definition }).toEqual(prior);
    expect(prior?.definition).toEqual(
      expect.stringContaining('v_checked_at timestamptz := clock_timestamp();'),
    );
    const definition = String(routine.definition);
    expect(definition.indexOf('v_checked_at := clock_timestamp();')).toBeGreaterThan(
      definition.lastIndexOf('FOR SHARE;'),
    );
    expect(definition).toContain('v_starts_at <= v_checked_at');
    expect(definition).toContain('v_checked_at < v_ends_at');
  });

  it('supports the 0038 recovery source and rejects mismatched manifests without changing the 0033 floor', async () => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    const state = await readVerifiedMigrationState(
      withDatabase(environment.adminUrl, database.databaseName),
    );
    expect(state.appliedCount).toBe(38);
    expect(state.latestFilename).toBe(filename);
    expect(state.appliedFilenames).toContain('0033_platform_recovery_generation_fencing.sql');
    expect(isRecoveryMigrationCompatible(state, state)).toBe(true);
    expect(isRecoveryMigrationCompatible(state, { ...state, appliedCount: 37 })).toBe(false);
    expect(
      isRecoveryMigrationCompatible(state, { ...state, checksumAggregateSha256: '0'.repeat(64) }),
    ).toBe(false);
    expect(
      isRecoveryMigrationCompatible(state, {
        ...state,
        latestFilename: '0037_auth_refresh_session_lock_order.sql',
      }),
    ).toBe(false);
  });
});
