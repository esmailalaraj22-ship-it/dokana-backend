import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import {
  BOOTSTRAP_ARTIFACT_ROOT,
  BootstrapArtifactStore,
} from '../src/sync/bootstrap-artifact.store';
import { bootstrapChecksum, canonicalBootstrapJson } from '../src/sync/bootstrap-canonical-json';
import { bootstrapBusinessDatasets } from '../src/sync/bootstrap-datasets';
import type {
  BootstrapJsonValue,
  BootstrapManifest,
  BootstrapPage,
  BootstrapRecord,
} from '../src/sync/bootstrap.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(180_000);

const sqliteReferenceRoot = resolve(process.cwd(), 'database/reference/backend_database_reference');
const sqliteBaseSchema = readFileSync(
  join(sqliteReferenceRoot, 'sqlite_shop_ledger_schema_v1_1.sql'),
  'utf8',
);
const sqliteSettingsPatch = readFileSync(
  join(sqliteReferenceRoot, 'sqlite_v1_2_settings_patch.sql'),
  'utf8',
);
const sqliteSyncParityPatch = readFileSync(
  join(sqliteReferenceRoot, 'sqlite_v1_3_sync_parity_patch.sql'),
  'utf8',
);

type SqliteValue = null | number | bigint | string;

interface SqliteColumn {
  name: string;
  type: string;
}

interface SqliteActivationState {
  datasetStatus: string;
  safeBaseCursor: string;
  activeDatasetId: string;
  bootstrapGenerationId: string;
  lastSafeCursor: string;
}

function bootstrapPageKey(datasetId: string, pageNumber: number): string {
  return `${datasetId}:${pageNumber.toString()}`;
}

function bootstrapDatasetChecksum(pageChecksums: readonly string[]): string {
  const hash = createHash('sha256');
  for (const checksum of pageChecksums) hash.update(checksum).update('\n');
  return hash.digest('hex');
}

function verifyBootstrapDownload(
  manifest: BootstrapManifest,
  pages: ReadonlyMap<string, BootstrapPage>,
): void {
  const { manifestChecksum, ...manifestCore } = manifest;
  if (bootstrapChecksum(manifestCore as unknown as BootstrapJsonValue) !== manifestChecksum) {
    throw new Error('BOOTSTRAP_MANIFEST_CHECKSUM_MISMATCH');
  }

  for (const dataset of manifest.datasets) {
    const pageChecksums: string[] = [];
    let recordCount = 0;
    for (let pageNumber = 1; pageNumber <= dataset.pageCount; pageNumber += 1) {
      const page = pages.get(bootstrapPageKey(dataset.id, pageNumber));
      if (!page) throw new Error('BOOTSTRAP_PAGE_MISSING');
      const { checksum, ...pageCore } = page;
      if (
        bootstrapChecksum(pageCore) !== checksum ||
        page.sessionId !== manifest.sessionId ||
        page.snapshotId !== manifest.snapshotId ||
        page.datasetId !== dataset.id ||
        page.pageNumber !== pageNumber ||
        page.recordCount !== page.records.length
      ) {
        throw new Error('BOOTSTRAP_PAGE_CHECKSUM_MISMATCH');
      }
      pageChecksums.push(checksum);
      recordCount += page.recordCount;
    }
    if (
      recordCount !== dataset.recordCount ||
      bootstrapDatasetChecksum(pageChecksums) !== dataset.checksum
    ) {
      throw new Error('BOOTSTRAP_DATASET_CHECKSUM_MISMATCH');
    }
  }
}

function createCurrentSqliteDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec(sqliteBaseSchema);
  database.exec(sqliteSettingsPatch);
  database.exec(sqliteSyncParityPatch);
  return database;
}

function toSqliteValue(value: BootstrapJsonValue, columnType: string): SqliteValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return canonicalBootstrapJson(value);
  if (columnType.toUpperCase() !== 'INTEGER') return value;
  if (/^-?\d+$/.test(value)) return BigInt(value);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('BOOTSTRAP_INTEGER_NOT_REPRESENTABLE');
  return BigInt(timestamp);
}

function insertBootstrapRecord(
  database: DatabaseSync,
  datasetId: string,
  record: BootstrapRecord,
): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(datasetId)) {
    throw new Error('BOOTSTRAP_DATASET_IDENTIFIER_INVALID');
  }
  const columns = database
    .prepare(`select name, type from pragma_table_info(?) order by cid`)
    .all(datasetId) as unknown as SqliteColumn[];
  if (columns.length === 0) throw new Error('BOOTSTRAP_SQLITE_DATASET_MISSING');
  const columnByName = new Map(columns.map((column) => [column.name, column]));
  const selected = Object.keys(record).filter((name) => columnByName.has(name));
  if (selected.length === 0) throw new Error('BOOTSTRAP_SQLITE_RECORD_NOT_REPRESENTABLE');
  const quotedColumns = selected.map((name) => `"${name}"`).join(', ');
  const placeholders = selected.map(() => '?').join(', ');
  const values = selected.map((name) =>
    toSqliteValue(record[name] ?? null, columnByName.get(name)?.type ?? ''),
  );
  database
    .prepare(`insert into "${datasetId}" (${quotedColumns}) values (${placeholders})`)
    .run(...values);
}

function activateBootstrapInSqlite(
  databasePath: string,
  manifest: BootstrapManifest,
  pages: ReadonlyMap<string, BootstrapPage>,
): void {
  const database = createCurrentSqliteDatabase(databasePath);
  try {
    database.exec('begin immediate');
    database
      .prepare(
        `insert into local_dataset_state(
           singleton_id, store_id, device_id, dataset_id, bootstrap_generation_id,
           snapshot_id, protocol_version, change_feed_version, dataset_status, started_at
         ) values (1, ?, ?, ?, ?, ?, ?, ?, 'staging', ?)`,
      )
      .run(
        manifest.storeId,
        manifest.deviceId,
        manifest.datasetId,
        manifest.bootstrapGenerationId,
        manifest.snapshotId,
        manifest.protocolVersion,
        manifest.changeFeedVersion,
        BigInt(Date.parse(manifest.serverTime)),
      );

    verifyBootstrapDownload(manifest, pages);
    for (const dataset of manifest.datasets) {
      for (let pageNumber = 1; pageNumber <= dataset.pageCount; pageNumber += 1) {
        const page = pages.get(bootstrapPageKey(dataset.id, pageNumber));
        if (!page) throw new Error('BOOTSTRAP_PAGE_MISSING');
        for (const record of page.records) insertBootstrapRecord(database, dataset.id, record);
      }
    }

    if (database.prepare('pragma foreign_key_check').all().length !== 0) {
      throw new Error('BOOTSTRAP_SQLITE_FOREIGN_KEY_FAILURE');
    }
    const quickCheck = database.prepare('pragma quick_check').get() as
      { quick_check?: string } | undefined;
    if (quickCheck?.quick_check !== 'ok') throw new Error('BOOTSTRAP_SQLITE_INTEGRITY_FAILURE');

    const checksums = Object.fromEntries(
      manifest.datasets.map((dataset) => [dataset.id, dataset.checksum]),
    );
    const activatedAt = BigInt(Date.parse(manifest.serverTime));
    database
      .prepare(
        `update local_dataset_state
         set dataset_status = 'validated', validated_at = ?, checksum_manifest_json = ?
         where singleton_id = 1`,
      )
      .run(activatedAt, canonicalBootstrapJson(checksums));
    database
      .prepare(
        `insert into sync_state(
           store_id, device_id, protocol_version, change_feed_version,
           last_safe_cursor, active_dataset_id, bootstrap_generation_id,
           cursor_application_status, last_success_at, pending_count
         ) values (?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0)`,
      )
      .run(
        manifest.storeId,
        manifest.deviceId,
        manifest.protocolVersion,
        manifest.changeFeedVersion,
        manifest.baseCursor,
        manifest.datasetId,
        manifest.bootstrapGenerationId,
        activatedAt,
      );
    database
      .prepare(
        `update local_dataset_state
         set dataset_status = 'active', activated_at = ?, safe_base_cursor = ?
         where singleton_id = 1 and dataset_status = 'validated'`,
      )
      .run(activatedAt, manifest.baseCursor);
    database.exec('commit');
    database.exec('pragma wal_checkpoint(truncate)');
  } catch (error) {
    try {
      database.exec('rollback');
    } catch {
      // The transaction may already have completed.
    }
    throw error;
  } finally {
    database.close();
  }
}

interface Identity {
  token: string;
  storeId: string;
  deviceId: string;
  licenseId: string;
}

function bodyAsRecord(response: { body: unknown }): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) {
    throw new Error('Expected an object response body.');
  }
  return response.body as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`Expected response field ${field}.`);
  return value;
}

function requiredObject(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected response object ${field}.`);
  }
  return value as Record<string, unknown>;
}

describeWithPostgres('S19.4 consistent initial bootstrap', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let fixturePool: Pool;
  let artifactRoot: string;
  let activePlanId: string;
  let ownsPlan = false;
  let poolsInitialized = false;
  let identityA: Identity;
  let identityB: Identity;

  const fixture = {
    stores: { a: randomUUID(), b: randomUUID(), restricted: randomUUID() },
    users: { a: randomUUID(), b: randomUUID(), restricted: randomUUID() },
    memberships: { a: randomUUID(), b: randomUUID(), restricted: randomUUID() },
    devices: { a: randomUUID(), b: randomUUID(), restricted: randomUUID() },
    subscriptions: { a: randomUUID(), b: randomUUID(), restricted: randomUUID() },
    plan: randomUUID(),
    product: randomUUID(),
    productUnit: randomUUID(),
    customerB: randomUUID(),
  };
  const customerAIds = Array.from({ length: 101 }, () => randomUUID());
  const password = 'S19.4-Integration-Password!';
  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);

  async function removeFixtures(): Promise<void> {
    await fixturePool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await fixturePool.query(
      `delete from platform.license_issuances where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from platform.subscriptions where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from audit.central_audit_logs where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from sync.store_change_events_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.store_change_watermarks_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.product_units where id = $1`, [
      fixture.productUnit,
    ]);
    await fixturePool.query(`delete from ledger.products where id = $1`, [fixture.product]);
    await fixturePool.query(`delete from ledger.customers where id = any($1::uuid[]) or id = $2`, [
      customerAIds,
      fixture.customerB,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await fixturePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    if (ownsPlan) {
      await fixturePool.query(`delete from platform.subscription_plans where id = $1`, [
        fixture.plan,
      ]);
    }
  }

  async function loginAndIssue(key: 'a' | 'b', email: string): Promise<Identity> {
    const login = await request(server)
      .post('/v1/auth/login')
      .send({
        email,
        password,
        storeId: fixture.stores[key],
        deviceId: fixture.devices[key],
        deviceName: `S19.4 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    const loginBody = bodyAsRecord(login);
    const accessToken = requiredString(loginBody, 'accessToken');
    const deviceId = requiredString(loginBody, 'deviceId');
    const license = await request(server)
      .post('/v1/licenses/verify')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ operationId: randomUUID() })
      .expect(200);
    const licenseBody = bodyAsRecord(license);
    const licenseRecord = requiredObject(licenseBody, 'license');
    const licensePayload = requiredObject(licenseRecord, 'payload');
    return {
      token: accessToken,
      storeId: fixture.stores[key],
      deviceId,
      licenseId: requiredString(licensePayload, 'licenseId'),
    };
  }

  function authorized(identity: Identity, method: 'get' | 'post', path: string) {
    return request(server)[method](path).set('authorization', `Bearer ${identity.token}`);
  }

  async function startBootstrap(identity: Identity): Promise<BootstrapManifest> {
    const response = await authorized(identity, 'post', '/v1/sync/bootstrap')
      .send({ bootstrapVersion: 1, licenseId: identity.licenseId })
      .expect(200);
    return bodyAsRecord(response) as unknown as BootstrapManifest;
  }

  async function readPage(
    identity: Identity,
    manifest: BootstrapManifest,
    datasetId: string,
    pageNumber: number,
  ): Promise<BootstrapPage> {
    const response = await authorized(
      identity,
      'get',
      `/v1/sync/bootstrap/${manifest.sessionId}/datasets/${datasetId}/pages/${pageNumber.toString()}`,
    ).expect(200);
    return bodyAsRecord(response) as unknown as BootstrapPage;
  }

  async function downloadAllPages(
    identity: Identity,
    manifest: BootstrapManifest,
  ): Promise<Map<string, BootstrapPage>> {
    const pages = new Map<string, BootstrapPage>();
    for (const dataset of manifest.datasets) {
      for (let pageNumber = 1; pageNumber <= dataset.pageCount; pageNumber += 1) {
        pages.set(
          bootstrapPageKey(dataset.id, pageNumber),
          await readPage(identity, manifest, dataset.id, pageNumber),
        );
      }
    }
    return pages;
  }

  beforeAll(async () => {
    if (!environment) throw new Error('The approved PostgreSQL test environment is unavailable.');
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    artifactRoot = await mkdtemp(join(tmpdir(), 'dokana-s19-bootstrap-integration-'));
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s19-bootstrap-fixture',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    poolsInitialized = true;
    await removeFixtures();

    const plans = await fixturePool.query<{ id: string }>(
      `select id from platform.subscription_plans where status = 'active' order by id`,
    );
    if (plans.rowCount === 0) {
      await fixturePool.query(
        `insert into platform.subscription_plans(
           id, code, name, duration_days, price_minor, offline_grace_days, status
         ) values ($1, $2, 'S19.4 MVP', 30, 0, 0, 'active')`,
        [fixture.plan, `s19-4-${fixture.plan}`],
      );
      activePlanId = fixture.plan;
      ownsPlan = true;
    } else if (plans.rowCount === 1 && plans.rows[0]) {
      activePlanId = plans.rows[0].id;
    } else {
      throw new Error('S19.4 requires exactly one active Subscription plan.');
    }

    await fixturePool.query(
      `insert into ledger.stores(id, name, status)
       values
         ($1, 'S19.4 Store A', 'active'),
         ($2, 'S19.4 Store B', 'active'),
         ($3, 'S19.4 Restricted Store', 'active')`,
      storeIds,
    );
    await fixturePool.query(
      `insert into ledger.app_settings(store_id, timezone_name)
       values ($1, 'Asia/Hebron'), ($2, 'Asia/Hebron'), ($3, 'Asia/Hebron')`,
      storeIds,
    );
    const passwordHash = await new PasswordService().hash(password);
    await fixturePool.query(
      `insert into platform.users(
         id, email, normalized_email, password_hash, full_name, status
       ) values
         ($1, 's19-4-a@example.test', 's19-4-a@example.test', $4, 'S19.4 Owner A', 'active'),
         ($2, 's19-4-b@example.test', 's19-4-b@example.test', $4, 'S19.4 Owner B', 'active'),
         ($3, 's19-4-r@example.test', 's19-4-r@example.test', $4, 'S19.4 Owner R', 'active')`,
      [...userIds, passwordHash],
    );
    await fixturePool.query(
      `insert into platform.store_memberships(id, store_id, user_id, role, status)
       values
         ($1, $2, $3, 'owner', 'active'),
         ($4, $5, $6, 'owner', 'active'),
         ($7, $8, $9, 'owner', 'active')`,
      [
        fixture.memberships.a,
        fixture.stores.a,
        fixture.users.a,
        fixture.memberships.b,
        fixture.stores.b,
        fixture.users.b,
        fixture.memberships.restricted,
        fixture.stores.restricted,
        fixture.users.restricted,
      ],
    );
    const now = Date.now();
    for (const key of ['a', 'b', 'restricted'] as const) {
      await fixturePool.query(
        `insert into platform.subscriptions(
           id, store_id, plan_id, status, starts_at, expires_at
         ) values ($1, $2, $3, 'active', $4, $5)`,
        [
          fixture.subscriptions[key],
          fixture.stores[key],
          activePlanId,
          new Date(now - 86_400_000),
          new Date(now + 30 * 86_400_000),
        ],
      );
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BOOTSTRAP_ARTIFACT_ROOT)
      .useValue(artifactRoot)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApplication(app as NestExpressApplication, app.get(AppConfigService));
    app.useLogger(app.get(Logger));
    await app.init();
    server = app.getHttpServer() as Server;

    identityA = await loginAndIssue('a', 's19-4-a@example.test');
    identityB = await loginAndIssue('b', 's19-4-b@example.test');

    for (const [index, customerId] of customerAIds.entries()) {
      const archived = index === customerAIds.length - 1;
      const digits = (index + 1).toString().padStart(6, '0');
      await fixturePool.query(
        `insert into ledger.customers(
           id, store_id, name, normalized_name, phone, normalized_phone,
           status, archived_at, operation_id, device_id, version
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7, case when $7 = 'archived' then '2026-01-15T10:00:00Z'::timestamptz else null end,
           $8, $9, $10::bigint
         )`,
        [
          customerId,
          fixture.stores.a,
          `S19 Customer ${digits}`,
          `s19 customer ${digits}`,
          `0597${digits}`,
          `+970597${digits}`,
          archived ? 'archived' : 'active',
          randomUUID(),
          identityA.deviceId,
          index === 0 ? '9007199254740993' : '1',
        ],
      );
    }
    await fixturePool.query(
      `insert into ledger.customers(
         id, store_id, name, normalized_name, phone, normalized_phone,
         operation_id, device_id
       ) values ($1, $2, 'Other Store Customer', 'other store customer',
                 '0596111111', '+970596111111', $3, $4)`,
      [fixture.customerB, fixture.stores.b, randomUUID(), identityB.deviceId],
    );
    await fixturePool.query(
      `insert into ledger.products(
         id, store_id, name, normalized_name, measurement_type,
         low_stock_threshold_milli, operation_id, device_id
       ) values ($1, $2, 'Exact Product', 'exact product', 'count',
                 9007199254740993, $3, $4)`,
      [fixture.product, fixture.stores.a, randomUUID(), identityA.deviceId],
    );
    await fixturePool.query(
      `insert into ledger.product_units(
         id, store_id, product_id, measurement_type, unit_name, unit_code,
         is_base, factor_num, factor_den, sale_price_minor, purchase_price_minor,
         operation_id, device_id
       ) values ($1, $2, $3, 'count', 'Piece', 'pc', true, 1, 1,
                 9007199254740993, 9007199254740991, $4, $5)`,
      [fixture.productUnit, fixture.stores.a, fixture.product, randomUUID(), identityA.deviceId],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    if (poolsInitialized) {
      await removeFixtures();
      await fixturePool.end();
    }
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  it('creates one bounded, dependency-ordered, resumable snapshot without side effects', async () => {
    const sideEffectQuery = `select
       (select count(*) from ledger.money_movements where store_id = $1)::text as money,
       (select count(*) from ledger.inventory_movements where store_id = $1)::text as inventory,
       (select count(*) from audit.central_audit_logs where store_id = $1)::text as audit,
       (select count(*) from sync.processed_operations where store_id = $1)::text as operations`;
    const before = await fixturePool.query<{
      money: string;
      inventory: string;
      audit: string;
      operations: string;
    }>(sideEffectQuery, [fixture.stores.a]);
    const manifest = await startBootstrap(identityA);
    expect(manifest).toMatchObject({
      bootstrapVersion: 1,
      protocolVersion: 1,
      changeFeedVersion: 1,
      sqliteSchemaVersion: 10_300,
      storeId: fixture.stores.a,
      deviceId: identityA.deviceId,
      status: 'ready',
      pageSize: 100,
      activationContract: {
        stagingModel: 'separate_sqlite_database',
        activation: 'atomic_database_swap_with_base_cursor',
        incompleteBootstrap: 'must_not_activate',
      },
    });
    expect(manifest.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifestChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.baseCursor).toMatch(/^\d+$/);

    const ids = manifest.datasets.map((dataset) => dataset.id);
    expect(ids).toEqual([
      'stores',
      'local_users',
      'devices',
      'app_settings',
      'offline_license_verification_keys',
      'local_license',
      'offline_trusted_time_state',
      ...bootstrapBusinessDatasets.slice(3).map((dataset) => dataset.id),
    ]);
    expect(manifest.datasets.map((dataset) => dataset.order)).toEqual(
      manifest.datasets.map((_, index) => index + 1),
    );

    const customers = manifest.datasets.find((dataset) => dataset.id === 'customers');
    expect(customers).toMatchObject({ recordCount: 101, pageCount: 2 });
    const firstPage = await readPage(identityA, manifest, 'customers', 1);
    const replay = await readPage(identityA, manifest, 'customers', 1);
    const secondPage = await readPage(identityA, manifest, 'customers', 2);
    expect(replay).toEqual(firstPage);
    expect(firstPage.records).toHaveLength(100);
    expect(secondPage.records).toHaveLength(1);
    expect([...firstPage.records, ...secondPage.records]).toEqual(
      expect.arrayContaining([expect.objectContaining({ version: '9007199254740993' })]),
    );
    const archivedCustomer = [...firstPage.records, ...secondPage.records].find(
      (record) => record.status === 'archived',
    );
    expect(archivedCustomer?.status).toBe('archived');
    expect(typeof archivedCustomer?.archived_at).toBe('string');
    expect(JSON.stringify([...firstPage.records, ...secondPage.records])).not.toContain(
      fixture.customerB,
    );

    const productPage = await readPage(identityA, manifest, 'products', 1);
    const unitPage = await readPage(identityA, manifest, 'product_units', 1);
    expect(productPage.records[0]).toMatchObject({
      low_stock_threshold_milli: '9007199254740993',
    });
    expect(unitPage.records[0]).toMatchObject({
      sale_price_minor: '9007199254740993',
      purchase_price_minor: '9007199254740991',
    });

    const licensePage = await readPage(identityA, manifest, 'local_license', 1);
    const keyPage = await readPage(identityA, manifest, 'offline_license_verification_keys', 1);
    expect(licensePage.records[0]).toMatchObject({
      id: identityA.licenseId,
      store_id: fixture.stores.a,
      device_id: identityA.deviceId,
      verification_state: 'verified',
    });
    expect(keyPage.records[0]).toMatchObject({ algorithm: 'Ed25519' });

    const allExposed = JSON.stringify({ manifest, firstPage, secondPage, licensePage, keyPage });
    expect(allExposed).not.toMatch(
      /password_hash|request_hash|token_hash|private_key|active_private|authorization/i,
    );
    const after = await fixturePool.query(sideEffectQuery, [fixture.stores.a]);
    expect(after.rows).toEqual(before.rows);
  });

  it('stages verified pages in SQLite and activates the dataset with its base cursor atomically', async () => {
    const manifest = await startBootstrap(identityA);
    const pages = await downloadAllPages(identityA, manifest);
    const sqliteRoot = await mkdtemp(join(tmpdir(), 'dokana-s19-bootstrap-sqlite-'));
    const partialPath = join(sqliteRoot, 'partial.db');
    const corruptPath = join(sqliteRoot, 'corrupt.db');
    const stagingPath = join(sqliteRoot, 'complete.staging.db');
    const activePath = join(sqliteRoot, 'active.db');

    try {
      const partialPages = new Map(pages);
      partialPages.delete(bootstrapPageKey('stores', 1));
      expect(() => activateBootstrapInSqlite(partialPath, manifest, partialPages)).toThrow(
        'BOOTSTRAP_PAGE_MISSING',
      );
      const partialDatabase = new DatabaseSync(partialPath);
      try {
        expect(partialDatabase.prepare('select count(*) as value from stores').get()).toEqual({
          value: 0,
        });
        expect(
          partialDatabase.prepare('select count(*) as value from local_dataset_state').get(),
        ).toEqual({ value: 0 });
      } finally {
        partialDatabase.close();
      }

      const corruptPages = new Map(pages);
      const storePage = pages.get(bootstrapPageKey('stores', 1));
      if (!storePage) throw new Error('Expected the Store bootstrap page.');
      const corruptStorePage = structuredClone(storePage);
      const firstStore = corruptStorePage.records[0];
      if (!firstStore) throw new Error('Expected a Store bootstrap record.');
      firstStore.name = 'Checksum tampering';
      corruptPages.set(bootstrapPageKey('stores', 1), corruptStorePage);
      expect(() => activateBootstrapInSqlite(corruptPath, manifest, corruptPages)).toThrow(
        'BOOTSTRAP_PAGE_CHECKSUM_MISMATCH',
      );
      const corruptDatabase = new DatabaseSync(corruptPath);
      try {
        expect(corruptDatabase.prepare('select count(*) as value from stores').get()).toEqual({
          value: 0,
        });
        expect(
          corruptDatabase.prepare('select count(*) as value from local_dataset_state').get(),
        ).toEqual({ value: 0 });
      } finally {
        corruptDatabase.close();
      }

      activateBootstrapInSqlite(stagingPath, manifest, pages);
      await rename(stagingPath, activePath);
      const activeDatabase = new DatabaseSync(activePath);
      try {
        const state = activeDatabase
          .prepare(
            `select dataset.dataset_status as "datasetStatus",
                    dataset.safe_base_cursor as "safeBaseCursor",
                    sync.active_dataset_id as "activeDatasetId",
                    sync.bootstrap_generation_id as "bootstrapGenerationId",
                    sync.last_safe_cursor as "lastSafeCursor"
             from local_dataset_state dataset
             join sync_state sync
               on sync.store_id = dataset.store_id
              and sync.device_id = dataset.device_id
             where dataset.singleton_id = 1`,
          )
          .get() as unknown as SqliteActivationState;
        expect(state).toEqual({
          datasetStatus: 'active',
          safeBaseCursor: manifest.baseCursor,
          activeDatasetId: manifest.datasetId,
          bootstrapGenerationId: manifest.bootstrapGenerationId,
          lastSafeCursor: manifest.baseCursor,
        });
        expect(activeDatabase.prepare('select count(*) as value from customers').get()).toEqual({
          value: 101,
        });
        expect(
          activeDatabase
            .prepare("select count(*) as value from customers where status = 'archived'")
            .get(),
        ).toEqual({ value: 1 });
        const exactQuantity = activeDatabase.prepare(
          'select low_stock_threshold_milli as value from products where id = ?',
        );
        exactQuantity.setReadBigInts(true);
        expect(exactQuantity.get(fixture.product)).toEqual({ value: 9_007_199_254_740_993n });
        expect(activeDatabase.prepare('pragma user_version').get()).toEqual({
          user_version: 10_300,
        });
        expect(activeDatabase.prepare('pragma quick_check').all()).toEqual([{ quick_check: 'ok' }]);
        expect(activeDatabase.prepare('pragma foreign_key_check').all()).toEqual([]);
      } finally {
        activeDatabase.close();
      }
    } finally {
      await rm(sqliteRoot, { recursive: true, force: true });
    }
  });

  it('rejects cross-Store page access, unsupported versions, and restricted Store states', async () => {
    const manifest = await startBootstrap(identityA);
    await authorized(
      identityB,
      'get',
      `/v1/sync/bootstrap/${manifest.sessionId}/datasets/customers/pages/1`,
    ).expect(404);

    await authorized(identityA, 'post', '/v1/sync/bootstrap')
      .send({ bootstrapVersion: 2, licenseId: identityA.licenseId })
      .expect(400);

    for (const status of ['suspended', 'archived'] as const) {
      await fixturePool.query(`update ledger.stores set status = $2 where id = $1`, [
        fixture.stores.a,
        status,
      ]);
      await authorized(identityA, 'post', '/v1/sync/bootstrap')
        .send({ bootstrapVersion: 1, licenseId: identityA.licenseId })
        .expect(401);
      await fixturePool.query(`update ledger.stores set status = 'active' where id = $1`, [
        fixture.stores.a,
      ]);
    }
  });

  it('invalidates missing artifacts explicitly instead of mixing snapshots', async () => {
    const manifest = await startBootstrap(identityA);
    await rm(join(artifactRoot, manifest.sessionId), { recursive: true, force: true });
    const response = await authorized(
      identityA,
      'get',
      `/v1/sync/bootstrap/${manifest.sessionId}/datasets/customers/pages/1`,
    ).expect(404);
    expect(bodyAsRecord(response).code).toBe('BOOTSTRAP_PAGE_NOT_FOUND');
  });

  it('uses the overridden private artifact root in the application module', () => {
    expect(app?.get(BootstrapArtifactStore)).toBeInstanceOf(BootstrapArtifactStore);
  });
});
