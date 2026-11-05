import type { PoolClient } from 'pg';

import { runMigrationCommand, verifyMigrationSession } from '../scripts/migrate';
import { readCatalogFingerprint } from '../scripts/migrations/catalog-fingerprint';
import { readEffectiveMigrationState } from '../scripts/migrations/effective-migration-state';
import { readMigrationFiles } from '../scripts/migrations/migration-files';
import {
  isRecoveryMigrationCompatible,
  readVerifiedMigrationState,
} from '../scripts/recovery/migration-state';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeDatabase = environment ? describe : describe.skip;
const migrationFilename = '0036_harden_default_function_privileges.sql';
const contexts = [
  { owner: 'shop_app_migrator', schema: 'audit', consumer: 'shop_app_migrator' },
  { owner: 'shop_app_migrator', schema: 'ledger', consumer: 'shop_app_runtime' },
  { owner: 'shop_app_migrator', schema: 'platform', consumer: 'shop_app_migrator' },
  { owner: 'shop_app_migrator', schema: 'sync', consumer: 'shop_app_runtime' },
  { owner: 'shop_app_auth_owner', schema: 'auth_api', consumer: 'shop_app_auth' },
] as const;
jest.setTimeout(120_000);

describeDatabase('Stage 1A authorized 0035 to 0036 upgrade', () => {
  let database: InventoryTestDatabase | undefined;
  let migrationUrl: string;
  let adminUrl: string;

  beforeAll(async () => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    database = await createInventoryTestDatabase(migrationFilename);
    const migration = new URL(environment.migrationUrl);
    migration.pathname = `/${database.databaseName}`;
    migrationUrl = migration.toString();
    const admin = new URL(environment.adminUrl);
    admin.pathname = `/${database.databaseName}`;
    adminUrl = admin.toString();
  });
  afterAll(async () => {
    await database?.close();
  });

  it('hardens only future defaults and preserves all existing catalog objects and effective function access', async () => {
    if (!database) throw new Error('Disposable database unavailable.');
    const files = await readMigrationFiles();
    const beforeState = await readEffectiveMigrationState(database.admin, files);
    expect(beforeState.executed).toHaveLength(35);
    expect(beforeState.pending.map((file) => file.filename)).toEqual([migrationFilename]);
    const priorLedger = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    const before = await readCatalogFingerprint(database.admin);
    const accessBefore = await currentAccess();
    expect(accessBefore.length).toBeGreaterThan(0);
    expect(accessBefore.every((row) => !row.publicExecute)).toBe(true);
    await probeDefaults(true);

    await runMigrationCommand('apply', migrationUrl);
    await runMigrationCommand('verify', migrationUrl);
    const afterState = await readEffectiveMigrationState(database.admin, files);
    expect(afterState.pending).toEqual([]);
    expect(afterState.executed).toEqual(
      files.map(({ filename, checksumSha256 }) => ({ filename, checksumSha256 })),
    );
    const afterLedger = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    expect(afterLedger.slice(0, 35)).toEqual(priorLedger);
    await runMigrationCommand('apply', migrationUrl);
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(afterLedger);
    expect(await currentAccess()).toEqual(accessBefore);

    const after = await readCatalogFingerprint(database.admin);
    const beforeCatalog = JSON.parse(before.canonicalJson) as Record<string, unknown>;
    const afterCatalog = JSON.parse(after.canonicalJson) as Record<string, unknown>;
    expect(
      Object.keys(beforeCatalog).filter(
        (key) => JSON.stringify(beforeCatalog[key]) !== JSON.stringify(afterCatalog[key]),
      ),
    ).toEqual(['defaultPrivileges']);
    expect(afterCatalog.defaultPrivileges).toEqual([
      {
        owner: 'shop_app_auth_owner',
        schema: '',
        type: 'f',
        grantee: 'shop_app_auth_owner',
        grantor: 'shop_app_auth_owner',
        privilege: 'EXECUTE',
        grantable: false,
      },
      {
        owner: 'shop_app_migrator',
        schema: '',
        type: 'f',
        grantee: 'shop_app_migrator',
        grantor: 'shop_app_migrator',
        privilege: 'EXECUTE',
        grantable: false,
      },
    ]);
    await probeDefaults(false);
    expect((await readCatalogFingerprint(database.admin)).sha256).toBe(after.sha256);
    await expect(
      readEffectiveMigrationState(
        database.admin,
        files.map((file) =>
          file.filename === migrationFilename ? { ...file, checksumSha256: '0'.repeat(64) } : file,
        ),
      ),
    ).rejects.toThrow('checksum mismatch');
  });

  it('retains the migration runner advisory-lock boundary', async () => {
    if (!database) throw new Error('Disposable database unavailable.');
    const client = await database.migration.connect();
    try {
      await client.query("select pg_advisory_lock(hashtextextended('dokana:migrations',0))");
      await expect(runMigrationCommand('apply', migrationUrl)).rejects.toThrow(
        'Another migration runner holds the advisory lock',
      );
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended('dokana:migrations',0))");
      client.release();
    }
  });

  it('supports 0036 recovery sources and rejects manifest mismatches', async () => {
    const source = await readVerifiedMigrationState(adminUrl);
    expect(source.appliedCount).toBe(36);
    expect(source.latestFilename).toBe(migrationFilename);
    expect(source.appliedFilenames).toContain('0033_platform_recovery_generation_fencing.sql');
    expect(isRecoveryMigrationCompatible(source, source)).toBe(true);
    expect(
      isRecoveryMigrationCompatible(source, { ...source, checksumAggregateSha256: '0'.repeat(64) }),
    ).toBe(false);
    expect(
      isRecoveryMigrationCompatible(source, {
        ...source,
        latestFilename: '0035_release_baseline_provenance.sql',
      }),
    ).toBe(false);
  });

  it('rejects a historical gap before status, verification, or replay changes the database', async () => {
    if (!database) throw new Error('Disposable database unavailable.');
    const before = await readCatalogFingerprint(database.admin);
    // Deliberately damaged history in this test-owned database, which is dropped afterward.
    await database.admin.query(
      "delete from platform.schema_migrations where filename='0017_platform_entitlement_null_safety.sql'",
    );
    const ledger = (
      await database.admin.query('select * from platform.schema_migrations order by filename')
    ).rows;
    for (const command of ['status', 'verify', 'apply'] as const) {
      await expect(runMigrationCommand(command, migrationUrl)).rejects.toThrow(
        'not a contiguous repository prefix',
      );
    }
    expect(
      (await database.admin.query('select * from platform.schema_migrations order by filename'))
        .rows,
    ).toEqual(ledger);
    expect((await readCatalogFingerprint(database.admin)).sha256).toBe(before.sha256);
  });

  async function currentAccess() {
    if (!database) throw new Error('Disposable database unavailable.');
    return (
      await database.admin.query<{ publicExecute: boolean }>(`
      select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
        pg_get_userbyid(p.proowner) as owner,
        has_function_privilege('public',p.oid,'EXECUTE') as "publicExecute",
        has_function_privilege('dokana_runtime_login',p.oid,'EXECUTE') as runtime,
        has_function_privilege('dokana_auth_login',p.oid,'EXECUTE') as auth,
        has_function_privilege('shop_app_auth_owner',p.oid,'EXECUTE') as auth_owner,
        has_function_privilege('shop_app_migrator',p.oid,'EXECUTE') as migrator
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('audit','ledger','platform','sync','auth_api')
      order by 1,2,3
    `)
    ).rows;
  }

  async function probeDefaults(expectedPublic: boolean) {
    if (!database) throw new Error('Disposable database unavailable.');
    for (const context of contexts) {
      const client: PoolClient = await database.migration.connect();
      try {
        await verifyMigrationSession(client);
        await client.query('begin');
        await client.query(`set local role ${context.owner}`);
        await client.query(
          `create function ${context.schema}.stage1a_default_probe() returns integer language sql security definer set search_path=pg_catalog as 'select 1'`,
        );
        const signature = `${context.schema}.stage1a_default_probe()`;
        const access = await client.query<{
          publicExecute: boolean;
          ownerExecute: boolean;
          consumerExecute: boolean;
        }>(
          `select has_function_privilege('public',$1::regprocedure,'EXECUTE') as "publicExecute",has_function_privilege($2,$1::regprocedure,'EXECUTE') as "ownerExecute",has_function_privilege($3,$1::regprocedure,'EXECUTE') as "consumerExecute"`,
          [signature, context.owner, context.consumer],
        );
        expect(access.rows[0]).toEqual({
          publicExecute: expectedPublic,
          ownerExecute: true,
          consumerExecute: expectedPublic || context.owner === context.consumer,
        });
        await client.query(`grant execute on function ${signature} to ${context.consumer}`);
        expect(
          (
            await client.query<{ allowed: boolean }>(
              `select has_function_privilege($1,$2::regprocedure,'EXECUTE') as allowed`,
              [context.consumer, signature],
            )
          ).rows[0]?.allowed,
        ).toBe(true);
      } finally {
        await client.query('rollback');
        await client.query('reset role');
        client.release();
      }
    }
  }
});
