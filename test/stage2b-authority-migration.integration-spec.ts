import { applyMigration, runMigrationCommand, verifyMigrationSession } from '../scripts/migrate';
import { readCatalogFingerprint } from '../scripts/migrations/catalog-fingerprint';
import { sha256 } from '../scripts/migrations/migration-files';
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
const filename = '0039_mutation_actor_authority_linearization.sql';
jest.setTimeout(120_000);

describe('Stage 2B disposable 0038 to 0039 migration', () => {
  let database: InventoryTestDatabase;
  let initialized = false;
  let migrationUrl: string;
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;

  beforeAll(async () => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    database = await createInventoryTestDatabase(filename);
    initialized = true;
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
    expect(history).toHaveLength(38);
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
    expect(upgraded).toHaveLength(39);
    expect(upgraded.slice(0, 38)).toEqual(history);
    expect(upgraded[38]).toMatchObject({ filename, checksum_sha256: database.file.checksumSha256 });
    await runMigrationCommand('apply', migrationUrl);
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(upgraded);
  });

  it('changes only the authorized authority routines and helper EXECUTE grants', async () => {
    expect(
      Object.keys(before)
        .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        .sort(),
    ).toEqual(['privileges', 'routines']);
    const oldRoutines = before.routines as Record<string, unknown>[];
    const newRoutines = after.routines as Record<string, unknown>[];
    const helper = newRoutines.filter((row) => row.name === 'lock_mutation_actor_v1');
    expect(helper).toHaveLength(1);
    expect(helper[0]).toMatchObject({
      schema: 'ledger',
      owner: 'shop_app_migrator',
      securityDefiner: true,
      configuration: 'search_path=pg_catalog, pg_temp',
      result: 'void',
      volatility: 'v',
    });
    const existing = newRoutines.filter((row) => row.name !== 'lock_mutation_actor_v1');
    expect(existing).toHaveLength(oldRoutines.length);
    const changed = existing.filter(
      (row, index) => JSON.stringify(row) !== JSON.stringify(oldRoutines[index]),
    );
    expect(changed.map((row) => row.name).sort()).toEqual([
      'manage_store_lifecycle',
      'manage_subscription_lifecycle',
      'prepare_offline_license',
      'revoke_offline_license',
    ]);
    for (const routine of changed) {
      const prior = oldRoutines[existing.indexOf(routine)];
      expect({ ...routine, definition: prior?.definition }).toEqual(prior);
    }
    const privileges = after.privileges as Record<string, unknown>[];
    const helperGrants = privileges.filter((row) =>
      String(row.object).startsWith('lock_mutation_actor_v1('),
    );
    expect(helperGrants.map((row) => row.grantee).sort()).toEqual([
      'shop_app_migrator',
      'shop_app_runtime',
    ]);
    expect(helperGrants.every((row) => row.privilege === 'EXECUTE')).toBe(true);
    expect(
      privileges.filter((row) => !String(row.object).startsWith('lock_mutation_actor_v1(')),
    ).toEqual(before.privileges);
    // The new PL/pgSQL routine must depend only on its language, schema and argument/result types.
    const dependencies = await database.admin.query<{ type: string; name: string }>(
      `select d.deptype as type, pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) as name
       from pg_depend d where d.classid='pg_proc'::regclass
       and d.objid='ledger.lock_mutation_actor_v1(text)'::regprocedure order by name`,
    );
    expect(dependencies.rows).toEqual([
      { type: 'n', name: 'language plpgsql' },
      { type: 'n', name: 'schema ledger' },
    ]);
  });

  it('supports the 0039 recovery source and rejects mismatched manifests without changing the 0033 floor', async () => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    const state = await readVerifiedMigrationState(
      withDatabase(environment.adminUrl, database.databaseName),
    );
    expect(state.appliedCount).toBe(39);
    expect(state.latestFilename).toBe(filename);
    expect(state.appliedFilenames).toContain('0033_platform_recovery_generation_fencing.sql');
    expect(isRecoveryMigrationCompatible(state, state)).toBe(true);
    expect(isRecoveryMigrationCompatible(state, { ...state, appliedCount: 38 })).toBe(false);
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
