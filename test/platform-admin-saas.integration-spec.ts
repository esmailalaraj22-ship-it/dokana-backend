import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Server } from 'node:http';

import { ForbiddenException, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { OfflineLicenseCryptoService } from '../src/offline-licenses/offline-license-crypto';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { encodePlatformAdminCursor } from '../src/platform-authority/platform-admin-cursor';
import { runMigrationCommand } from '../scripts/migrate';
import { withDatabase } from '../scripts/recovery/recovery-target';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

let environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(120_000);

const fixtures = {
  stores: {
    auth: '18500000-0000-4000-8000-000000000001',
    listA: '18500000-0000-4000-8000-000000000002',
    listB: '18500000-0000-4000-8000-000000000003',
    activation: '18500000-0000-4000-8000-000000000004',
    extension: '18500000-0000-4000-8000-000000000005',
    cancellation: '18500000-0000-4000-8000-000000000006',
    expired: '18500000-0000-4000-8000-000000000007',
    lifecycle: '18500000-0000-4000-8000-000000000008',
    lifecycleRace: '18500000-0000-4000-8000-000000000009',
    missing: '18500000-0000-4000-8000-000000000010',
    future: '18500000-0000-4000-8000-000000000011',
    expiredRead: '18500000-0000-4000-8000-000000000012',
    readOnly: '18500000-0000-4000-8000-000000000013',
    suspended: '18500000-0000-4000-8000-000000000014',
    archived: '18500000-0000-4000-8000-000000000015',
    subscriptionRace: '18500000-0000-4000-8000-000000000016',
    suspensionRace: '18500000-0000-4000-8000-000000000017',
  },
  users: {
    admin: '18510000-0000-4000-8000-000000000001',
    owner: '18510000-0000-4000-8000-000000000002',
    manager: '18510000-0000-4000-8000-000000000003',
    viewer: '18510000-0000-4000-8000-000000000004',
    provisionedOwner: '18510000-0000-4000-8000-000000000005',
  },
  plan: '18520000-0000-4000-8000-000000000001',
  targetMoneyAccount: '18530000-0000-4000-8000-000000000001',
  provisionOperation: '18540000-0000-4000-8000-000000000001',
} as const;

const password = 'S18.5-Integration-Password!';
const futureListTimestamp = new Date('2199-01-01T00:00:00.000Z');
const storeIdNamespace = '330f8db6-2a17-5f42-9bc5-8e8879df0f46';

function deriveProvisionedStoreId(operationId: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(storeIdNamespace.replaceAll('-', ''), 'hex'))
    .update(Buffer.from(operationId.replaceAll('-', ''), 'hex'))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

const provisionedStoreId = deriveProvisionedStoreId(fixtures.provisionOperation);
const fixtureStoreIds = [...Object.values(fixtures.stores), provisionedStoreId];
const fixtureUserIds = Object.values(fixtures.users);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(response: { body: unknown }): Record<string, unknown> {
  if (!isRecord(response.body)) throw new Error('Expected a structured response body.');
  return response.body;
}

describeWithPostgres('S18.5 online entitlement and SaaS administration', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let database: DatabaseService;
  let adminPool: Pool;
  let fixturePool: Pool;
  let activePlanId: string;
  let ownsPlan = false;
  let poolsInitialized = false;
  let disposable: InventoryTestDatabase | undefined;

  function context(storeId: string, userId: string = fixtures.users.admin) {
    return {
      storeId,
      userId,
      deviceId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  async function login(
    email: string,
    storeId: string = fixtures.stores.auth,
    deviceId: string = randomUUID(),
  ): Promise<string> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email,
        password,
        storeId,
        deviceId,
        deviceName: 'S18.5 integration device',
        devicePlatform: 'android',
      })
      .expect(200);
    const body = bodyOf(response);
    if (typeof body.accessToken !== 'string') throw new Error('Expected an access token.');
    return body.accessToken;
  }

  async function seedSubscription(
    storeId: string,
    startsAt: Date,
    expiresAt: Date,
    status: 'active' | 'cancelled' = 'active',
  ): Promise<void> {
    await fixturePool.query(
      `insert into platform.subscriptions (
         id, store_id, plan_id, status, starts_at, expires_at,
         cancelled_at
       ) values ($1, $2, $3, $4, $5, $6,
         case when $4::text = 'cancelled' then clock_timestamp() else null end)`,
      [randomUUID(), storeId, activePlanId, status, startsAt, expiresAt],
    );
  }

  async function removeFixtures(): Promise<void> {
    await fixturePool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      fixtureUserIds,
    ]);
    await fixturePool.query(
      `delete from platform.license_issuances where store_id = any($1::uuid[])`,
      [fixtureStoreIds],
    );
    await fixturePool.query(`delete from platform.admin_actions where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(`delete from platform.subscriptions where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(`delete from sync.conflicts where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [fixtureStoreIds],
    );
    await fixturePool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(
      `delete from audit.central_audit_logs where store_id = any($1::uuid[])`,
      [fixtureStoreIds],
    );
    await fixturePool.query(`delete from ledger.money_accounts where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(`delete from ledger.customers where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(
      `delete from platform.store_memberships where store_id = any($1::uuid[])
         or user_id = any($2::uuid[])`,
      [fixtureStoreIds, fixtureUserIds],
    );
    await fixturePool.query(
      `delete from platform.platform_admin_assignments where user_id = any($1::uuid[])`,
      [fixtureUserIds],
    );
    await fixturePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [
      fixtureStoreIds,
    ]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [
      fixtureUserIds,
    ]);
    if (ownsPlan) {
      await fixturePool.query(`delete from platform.subscription_plans where id = $1`, [
        fixtures.plan,
      ]);
    }
  }

  beforeAll(async () => {
    if (!environment) throw new Error('The approved PostgreSQL test environment is unavailable.');

    disposable = await createInventoryTestDatabase(
      '0039_mutation_actor_authority_linearization.sql',
    );
    environment = {
      ...environment,
      databaseName: disposable.databaseName,
      runtimeUrl: withDatabase(environment.runtimeUrl, disposable.databaseName),
      adminUrl: withDatabase(environment.adminUrl, disposable.databaseName),
      authUrl: withDatabase(environment.authUrl, disposable.databaseName),
      migrationUrl: withDatabase(environment.migrationUrl, disposable.databaseName),
    };
    await runMigrationCommand('apply', environment.migrationUrl);

    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;
    adminPool = createTestPool(environment.adminUrl, 'dokana-s18-5-admin', 4);
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s18-5-fixture',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    poolsInitialized = true;
    await removeFixtures();

    const plans = await adminPool.query<{ id: string }>(
      `select id from platform.subscription_plans where status = 'active' order by id`,
    );
    if (plans.rowCount === 0) {
      await fixturePool.query(
        `insert into platform.subscription_plans (
           id, code, name, duration_days, price_minor, offline_grace_days, status
         ) values ($1, 'dokana-s18-5-mvp', 'Dokana S18.5 MVP', 30, 0, 0, 'active')`,
        [fixtures.plan],
      );
      activePlanId = fixtures.plan;
      ownsPlan = true;
    } else if (plans.rowCount === 1 && plans.rows[0]) {
      activePlanId = plans.rows[0].id;
    } else {
      throw new Error('S18.5 requires exactly one active MVP Subscription plan.');
    }

    const ordinaryStores = Object.entries(fixtures.stores).filter(
      ([name]) => !['listA', 'listB', 'readOnly', 'suspended', 'archived'].includes(name),
    );
    for (const [name, id] of ordinaryStores) {
      await fixturePool.query(
        `insert into ledger.stores (id, name, status) values ($1, $2, 'active')`,
        [id, `S18.5 ${name}`],
      );
    }
    await fixturePool.query(
      `insert into ledger.stores (id, name, status, created_at, updated_at) values
       ($1, 'S18.5 List A', 'active', $3, $3),
       ($2, 'S18.5 List B', 'active', $3, $3)`,
      [fixtures.stores.listA, fixtures.stores.listB, futureListTimestamp],
    );
    await fixturePool.query(
      `insert into ledger.stores (id, name, status) values
       ($1, 'S18.5 Read Only', 'read_only'),
       ($2, 'S18.5 Suspended', 'suspended'),
       ($3, 'S18.5 Archived', 'archived')`,
      [fixtures.stores.readOnly, fixtures.stores.suspended, fixtures.stores.archived],
    );

    const passwordHash = await new PasswordService().hash(password);
    await fixturePool.query(
      `insert into platform.users (
         id, email, normalized_email, password_hash, full_name, status
       ) values
       ($1, 's18-5-admin@example.test', 's18-5-admin@example.test', $6, 'S18.5 Admin', 'active'),
       ($2, 's18-5-owner@example.test', 's18-5-owner@example.test', $6, 'S18.5 Owner', 'active'),
       ($3, 's18-5-manager@example.test', 's18-5-manager@example.test', $6, 'S18.5 Manager', 'active'),
       ($4, 's18-5-viewer@example.test', 's18-5-viewer@example.test', $6, 'S18.5 Viewer', 'active'),
       ($5, 's18-5-new-owner@example.test', 's18-5-new-owner@example.test', $6,
        'S18.5 Provisioned Owner', 'active')`,
      [...fixtureUserIds, passwordHash],
    );
    await fixturePool.query(
      `insert into platform.store_memberships (id, store_id, user_id, role, status) values
       ($1, $5, $6, 'owner', 'active'),
       ($2, $5, $7, 'owner', 'active'),
       ($3, $5, $8, 'manager', 'active'),
       ($4, $5, $9, 'viewer', 'active'),
       ($10, $11, $7, 'owner', 'active')`,
      [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        fixtures.stores.auth,
        fixtures.users.admin,
        fixtures.users.owner,
        fixtures.users.manager,
        fixtures.users.viewer,
        randomUUID(),
        fixtures.stores.expiredRead,
      ],
    );
    await fixturePool.query(
      `insert into platform.platform_admin_assignments (user_id, status) values ($1, 'active')`,
      [fixtures.users.admin],
    );

    const now = Date.now();
    const activeStart = new Date(now - 86_400_000);
    const activeEnd = new Date(now + 30 * 86_400_000);
    for (const storeId of [
      fixtures.stores.auth,
      fixtures.stores.extension,
      fixtures.stores.cancellation,
      fixtures.stores.lifecycle,
      fixtures.stores.lifecycleRace,
      fixtures.stores.readOnly,
      fixtures.stores.suspended,
      fixtures.stores.archived,
      fixtures.stores.subscriptionRace,
      fixtures.stores.suspensionRace,
    ]) {
      await seedSubscription(storeId, activeStart, activeEnd);
    }
    await seedSubscription(
      fixtures.stores.expired,
      new Date(now - 30 * 86_400_000),
      new Date(now - 86_400_000),
    );
    await seedSubscription(
      fixtures.stores.expiredRead,
      new Date(now - 30 * 86_400_000),
      new Date(now - 86_400_000),
    );
    await seedSubscription(
      fixtures.stores.future,
      new Date(now + 86_400_000),
      new Date(now + 31 * 86_400_000),
    );
    await fixturePool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability,
         is_default, status, operation_id
       ) values ($1, $2, 'Target Account', 'target account', 'transfer', 'available',
         false, 'active', $3)`,
      [fixtures.targetMoneyAccount, fixtures.stores.extension, randomUUID()],
    );

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();
    database = nestApp.get(DatabaseService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) {
      await disposable?.close();
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `select (
         (select count(*) from ledger.stores where id = any($1::uuid[])) +
         (select count(*) from platform.users where id = any($2::uuid[])) +
         (select count(*) from platform.subscriptions where store_id = any($1::uuid[])) +
         (select count(*) from platform.admin_actions where store_id = any($1::uuid[]))
       )::integer as count`,
      [fixtureStoreIds, fixtureUserIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([fixturePool.end(), adminPool.end()]);
    await disposable?.close();
  }, 30_000);

  it('keeps migration 0020 functions and runtime grants narrowly scoped', async () => {
    const functions = await adminPool.query<{
      owner: string;
      securityDefiner: boolean;
      configuration: string[];
      publicExecute: boolean;
      runtimeExecute: boolean;
      authExecute: boolean;
    }>(`
      select
        pg_get_userbyid(routine.proowner) as owner,
        routine.prosecdef as "securityDefiner",
        routine.proconfig as configuration,
        has_function_privilege('public', routine.oid, 'EXECUTE') as "publicExecute",
        has_function_privilege('shop_app_runtime', routine.oid, 'EXECUTE') as "runtimeExecute",
        has_function_privilege('shop_app_auth', routine.oid, 'EXECUTE') as "authExecute"
      from pg_proc routine
      where routine.oid in (
        'ledger.list_platform_stores(timestamp with time zone,uuid,integer)'::regprocedure,
        'ledger.manage_store_lifecycle(uuid,text,bigint,uuid,text,text)'::regprocedure,
        'ledger.read_store_admin_history(uuid,timestamp with time zone,uuid,integer)'::regprocedure
      )
    `);
    expect(functions.rows).toHaveLength(3);
    for (const row of functions.rows) {
      expect(row).toEqual({
        owner: 'shop_app_migrator',
        securityDefiner: true,
        configuration: ['search_path=pg_catalog, pg_temp'],
        publicExecute: false,
        runtimeExecute: true,
        authExecute: false,
      });
    }

    const runtime = await adminPool.query<{
      platformUsage: boolean;
      adminActionSelect: boolean;
      adminActionInsert: boolean;
      storeSelect: boolean;
    }>(`
      select
        has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') as "platformUsage",
        has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'SELECT')
          as "adminActionSelect",
        has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT')
          as "adminActionInsert",
        has_table_privilege('shop_app_runtime', 'ledger.stores', 'SELECT') as "storeSelect"
    `);
    expect(runtime.rows[0]).toEqual({
      platformUsage: false,
      adminActionSelect: false,
      adminActionInsert: false,
      storeSelect: true,
    });
  });

  it('authorizes only durable active Platform Admins and exposes stable Store reads', async () => {
    const adminToken = await login('s18-5-admin@example.test');
    for (const email of [
      's18-5-owner@example.test',
      's18-5-manager@example.test',
      's18-5-viewer@example.test',
    ]) {
      const token = await login(email);
      await request(server)
        .get('/v1/admin/stores')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }

    const storesResponse = await request(server)
      .get('/v1/admin/stores?limit=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const storesBody = bodyOf(storesResponse);
    expect(storesBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixtures.stores.listA, version: '1' }),
        expect.objectContaining({ id: fixtures.stores.listB, version: '1' }),
      ]),
    );

    const cursor = encodePlatformAdminCursor('stores', {
      at: futureListTimestamp,
      id: fixtures.stores.listA,
    });
    const page = await request(server)
      .get(`/v1/admin/stores?limit=1&cursor=${cursor}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(bodyOf(page).items).toEqual([expect.objectContaining({ id: fixtures.stores.listB })]);

    const detail = await request(server)
      .get(`/v1/admin/stores/${fixtures.stores.extension}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(bodyOf(detail)).toMatchObject({
      store: { id: fixtures.stores.extension, status: 'active', version: '1' },
      currentSubscription: { storeId: fixtures.stores.extension, writeEligible: true },
    });

    await fixturePool.query(
      `update platform.platform_admin_assignments
       set status = 'revoked', revoked_at = clock_timestamp(), revoked_by_user_id = $1,
           revoke_reason = 'S18.5 revocation test', updated_at = clock_timestamp(), version = version + 1
       where user_id = $1`,
      [fixtures.users.admin],
    );
    await request(server)
      .get('/v1/admin/stores')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
    await fixturePool.query(
      `update platform.platform_admin_assignments
       set status = 'active', revoked_at = null, revoked_by_user_id = null,
           revoke_reason = null, updated_at = clock_timestamp(), version = version + 1
       where user_id = $1`,
      [fixtures.users.admin],
    );
  });

  it('exposes Subscription lifecycle and history through thin idempotent APIs', async () => {
    const token = await login('s18-5-admin@example.test');
    const actions = [
      ['activate', fixtures.stores.activation],
      ['extend', fixtures.stores.extension],
      ['cancel', fixtures.stores.cancellation],
      ['reactivate', fixtures.stores.expired],
    ] as const;

    for (const [action, storeId] of actions) {
      const operationId = randomUUID();
      const body = { operationId, reason: `S18.5 ${action} authorization` };
      const first = await request(server)
        .post(`/v1/admin/stores/${storeId}/subscriptions/${action}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(200);
      expect(bodyOf(first)).toMatchObject({ action, replayed: false, operationId });
      const replay = await request(server)
        .post(`/v1/admin/stores/${storeId}/subscriptions/${action}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(200);
      expect(bodyOf(replay)).toMatchObject({ action, replayed: true, operationId });
    }

    const subscriptions = await request(server)
      .get(`/v1/admin/stores/${fixtures.stores.extension}/subscriptions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bodyOf(subscriptions).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ storeId: fixtures.stores.extension })]),
    );
    const history = await request(server)
      .get(`/v1/admin/stores/${fixtures.stores.extension}/subscriptions/history`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bodyOf(history).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'subscription_extend' })]),
    );
  });

  it('provisions a complete Store without promoting the Platform Admin to Store Owner', async () => {
    const token = await login('s18-5-admin@example.test');
    const payload = {
      operationId: fixtures.provisionOperation,
      ownerUserId: fixtures.users.provisionedOwner,
      name: 'S18.5 Provisioned Store',
      phone: null,
      reason: 'Approved S18.5 Store provisioning',
      activateSubscription: true,
      settings: {
        dailyReportTimeMinutes: 1200,
        defaultCreditPolicy: 'warn',
        defaultCreditLimitMinor: null,
        allowNegativeStock: false,
        lowStockAlertEnabled: true,
        debtAgeAlertDays: 30,
        backupEnabled: true,
        backupIntervalHours: 24,
      },
    };
    const first = await request(server)
      .post('/v1/admin/stores')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    expect(bodyOf(first)).toMatchObject({
      storeId: provisionedStoreId,
      ownerUserId: fixtures.users.provisionedOwner,
      subscriptionStatus: 'active',
      replayed: false,
      operationId: fixtures.provisionOperation,
    });
    const replay = await request(server)
      .post('/v1/admin/stores')
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(201);
    expect(bodyOf(replay)).toMatchObject({ storeId: provisionedStoreId, replayed: true });
    const memberships = await adminPool.query<{ userId: string; role: string }>(
      `select user_id as "userId", role from platform.store_memberships where store_id = $1`,
      [provisionedStoreId],
    );
    expect(memberships.rows).toEqual([{ userId: fixtures.users.provisionedOwner, role: 'owner' }]);
    const settings = await adminPool.query<{ customerDebtAmountAlertMinor: string }>(
      `select customer_debt_amount_alert_minor::text as "customerDebtAmountAlertMinor"
       from ledger.app_settings where store_id = $1`,
      [provisionedStoreId],
    );
    expect(settings.rows).toEqual([{ customerDebtAmountAlertMinor: '50000' }]);
  });

  it('suspends and restores Stores with versioning, audit, replay, and archive safety', async () => {
    const token = await login('s18-5-admin@example.test');
    const operationId = randomUUID();
    const payload = { operationId, expectedVersion: '1', reason: 'Security suspension' };
    const suspended = await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.lifecycle}/lifecycle/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(200);
    expect(bodyOf(suspended)).toMatchObject({
      status: 'suspended',
      version: '2',
      replayed: false,
    });
    const replay = await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.lifecycle}/lifecycle/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload)
      .expect(200);
    expect(bodyOf(replay)).toMatchObject({ status: 'suspended', version: '2', replayed: true });
    await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.lifecycle}/lifecycle/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...payload, reason: 'Changed semantics' })
      .expect(409);
    await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.lifecycle}/lifecycle/restore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: randomUUID(), expectedVersion: '1', reason: 'Stale restoration' })
      .expect(409);
    const restored = await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.lifecycle}/lifecycle/restore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: randomUUID(), expectedVersion: '2', reason: 'Approved restoration' })
      .expect(200);
    expect(bodyOf(restored)).toMatchObject({ status: 'active', version: '3' });
    await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.archived}/lifecycle/restore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: randomUUID(), expectedVersion: '1', reason: 'Must be rejected' })
      .expect(409);
    await request(server)
      .post(`/v1/admin/stores/${fixtures.stores.lifecycle}/lifecycle/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: randomUUID(), expectedVersion: '3', reason: ' ' })
      .expect(400);

    const raceOperation = randomUUID();
    const racePayload = {
      operationId: raceOperation,
      expectedVersion: '1',
      reason: 'Concurrent suspension',
    };
    const race = await Promise.all([
      request(server)
        .post(`/v1/admin/stores/${fixtures.stores.lifecycleRace}/lifecycle/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send(racePayload),
      request(server)
        .post(`/v1/admin/stores/${fixtures.stores.lifecycleRace}/lifecycle/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send(racePayload),
    ]);
    expect(race.map((response) => response.status)).toEqual([200, 200]);
    expect(race.map((response) => bodyOf(response).replayed).sort()).toEqual([false, true]);

    const history = await request(server)
      .get(`/v1/admin/stores/${fixtures.stores.lifecycle}/history`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bodyOf(history).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'store_suspend', reason: 'Security suspension' }),
        expect.objectContaining({ action: 'store_restore', reason: 'Approved restoration' }),
      ]),
    );
  });

  it('enforces all online entitlement states while preserving expired-Store login and reads', async () => {
    const deviceId = randomUUID();
    await login('s18-5-owner@example.test', fixtures.stores.auth, deviceId);
    await expect(
      database.withBusinessWriteTransaction(
        { ...context(fixtures.stores.auth, fixtures.users.owner), deviceId },
        async () => 'ok',
      ),
    ).resolves.toBe('ok');
    for (const storeId of [
      fixtures.stores.cancellation,
      fixtures.stores.missing,
      fixtures.stores.future,
      fixtures.stores.expiredRead,
      fixtures.stores.readOnly,
      fixtures.stores.suspended,
      fixtures.stores.archived,
    ]) {
      await expect(
        database.withBusinessWriteTransaction(context(storeId), async () => 'unexpected'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }

    const ownerToken = await login('s18-5-owner@example.test', fixtures.stores.expiredRead);
    await request(server)
      .get('/v1/money-accounts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
  });

  it('serializes restrictions ahead of writes and preserves the accounting firewall', async () => {
    const subscriptionClient = await adminPool.connect();
    try {
      await subscriptionClient.query('begin');
      await subscriptionClient.query(
        `update platform.subscriptions set status = 'cancelled', cancelled_at = clock_timestamp()
         where store_id = $1`,
        [fixtures.stores.subscriptionRace],
      );
      const write = database.withBusinessWriteTransaction(
        context(fixtures.stores.subscriptionRace),
        async () => 'unexpected',
      );
      const pid = (
        await subscriptionClient.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0]?.pid;
      if (!pid) throw new Error('Missing subscription blocker.');
      await waitForRuntimeAuthorityLock(pid, 'lock_effective_entitlement');
      await subscriptionClient.query('commit');
      await expect(write).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await subscriptionClient.query('rollback').catch(() => undefined);
      subscriptionClient.release();
    }

    const storeClient = await fixturePool.connect();
    try {
      await storeClient.query('begin');
      await storeClient.query(`update ledger.stores set status = 'suspended' where id = $1`, [
        fixtures.stores.suspensionRace,
      ]);
      const write = database.withBusinessWriteTransaction(
        context(fixtures.stores.suspensionRace),
        async () => 'unexpected',
      );
      const pid = (await storeClient.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]?.pid;
      if (!pid) throw new Error('Missing Store blocker.');
      await waitForRuntimeAuthorityLock(pid, 'lock_effective_entitlement');
      await storeClient.query('commit');
      await expect(write).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await storeClient.query('rollback').catch(() => undefined);
      storeClient.release();
    }

    const token = await login('s18-5-admin@example.test');
    await request(server)
      .get(`/v1/money-accounts/${fixtures.targetMoneyAccount}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rechecks changed role, membership, device, and Store authority on real business requests', async () => {
    const deviceId = randomUUID();
    const token = await login('s18-5-owner@example.test', fixtures.stores.auth, deviceId);
    const customerId = randomUUID();
    await request(server)
      .post('/v1/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: customerId,
        operationId: randomUUID(),
        name: 'Authority probe',
        phone: '0591234568',
      })
      .expect(201);

    const cases = [
      {
        role: 'viewer',
        membership: 'active',
        device: 'active',
        store: 'active',
        read: 200,
        write: 403,
      },
      {
        role: 'owner',
        membership: 'removed',
        device: 'active',
        store: 'active',
        read: 401,
        write: 401,
      },
      {
        role: 'owner',
        membership: 'active',
        device: 'revoked',
        store: 'active',
        read: 401,
        write: 401,
      },
      {
        role: 'owner',
        membership: 'active',
        device: 'active',
        store: 'suspended',
        read: 401,
        write: 401,
      },
      {
        role: 'owner',
        membership: 'active',
        device: 'active',
        store: 'archived',
        read: 401,
        write: 401,
      },
      {
        role: 'owner',
        membership: 'active',
        device: 'active',
        store: 'read_only',
        read: 200,
        write: 403,
      },
    ];
    for (const state of cases) {
      const id = randomUUID();
      const operationId = randomUUID();
      try {
        await fixturePool.query(
          'update platform.store_memberships set role=$1, status=$2 where store_id=$3 and user_id=$4',
          [state.role, state.membership, fixtures.stores.auth, fixtures.users.owner],
        );
        await fixturePool.query('update ledger.devices set status=$1 where id=$2', [
          state.device,
          deviceId,
        ]);
        await fixturePool.query('update ledger.stores set status=$1 where id=$2', [
          state.store,
          fixtures.stores.auth,
        ]);
        const read = await request(server)
          .get(`/v1/customers/${customerId}`)
          .set('Authorization', `Bearer ${token}`);
        expect({ state, status: read.status }).toEqual({ state, status: state.read });
        if (state.read === 200) expect(bodyOf(read).id).toBe(customerId);
        const write = await request(server)
          .post('/v1/money-accounts')
          .set('Authorization', `Bearer ${token}`)
          .send({ id, operationId, name: 'Must not be persisted' });
        const effects = await adminPool.query<{
          accounts: number;
          operations: number;
          audit: number;
        }>(
          `select (select count(*)::int from ledger.money_accounts where id=$1) as accounts,
           (select count(*)::int from sync.processed_operations where operation_id=$2) as operations,
           (select count(*)::int from audit.central_audit_logs where entity_id=$1) as audit`,
          [id, operationId],
        );
        expect({ state, status: write.status, ...effects.rows[0] }).toEqual({
          state,
          status: state.write,
          accounts: 0,
          operations: 0,
          audit: 0,
        });
      } finally {
        await fixturePool.query(
          "update platform.store_memberships set role='owner', status='active' where store_id=$1 and user_id=$2",
          [fixtures.stores.auth, fixtures.users.owner],
        );
        await fixturePool.query("update ledger.devices set status='active' where id=$1", [
          deviceId,
        ]);
        await fixturePool.query("update ledger.stores set status='active' where id=$1", [
          fixtures.stores.auth,
        ]);
      }
    }
  });

  it('rejects a foreign-Store device reference under the actual runtime database role', async () => {
    if (!environment) throw new Error('The approved PostgreSQL test environment is unavailable.');
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    await login('s18-5-owner@example.test', fixtures.stores.auth, deviceA);
    await login('s18-5-owner@example.test', fixtures.stores.expiredRead, deviceB);
    const runtime = createTestPool(environment.runtimeUrl, 'dokana-stage-2b-reference', 1);
    const client = await runtime.connect();
    const id = randomUUID();
    const operationId = randomUUID();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.store_id', $1, true), set_config('app.user_id', $2, true),
         set_config('app.device_id', $3, true), set_config('app.request_id', $4, true)`,
        [fixtures.stores.auth, fixtures.users.owner, deviceA, randomUUID()],
      );
      await expect(
        client.query(
          `insert into ledger.customers
         (id, store_id, name, normalized_name, phone, normalized_phone, device_id, operation_id)
         values ($1, $2, 'Foreign device', 'foreign device', '0591234569', '+970591234569', $3, $4)`,
          [id, fixtures.stores.auth, deviceB, operationId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await client.query('rollback');
      const effects = await adminPool.query<{ customers: number; audit: number }>(
        `select (select count(*)::int from ledger.customers where id=$1) as customers,
         (select count(*)::int from audit.central_audit_logs where entity_id=$1) as audit`,
        [id],
      );
      expect(effects.rows[0]).toEqual({ customers: 0, audit: 0 });
    } finally {
      await client.query('rollback');
      client.release();
      await runtime.end();
    }
  });

  async function customerEffects(storeId: string = fixtures.stores.auth) {
    return (
      await adminPool.query<{
        customers: unknown;
        operations: number;
        audit: number;
        changes: number;
      }>(
        `select
       (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from ledger.customers c where store_id=$1) as customers,
       (select count(*)::int from sync.processed_operations where store_id=$1) as operations,
       (select count(*)::int from audit.central_audit_logs where store_id=$1) as audit,
       (select count(*)::int from sync.change_events where store_id=$1) as changes`,
        [storeId],
      )
    ).rows[0];
  }

  it.each(['owner', 'manager', 'viewer', 'support'] as const)(
    'enforces the complete Customer %s HTTP role matrix without denied-write effects',
    async (role) => {
      const ownerToken = await login('s18-5-admin@example.test'); // Separate ordinary Owner membership.
      const token = await login('s18-5-owner@example.test');
      const index = ['owner', 'manager', 'viewer', 'support'].indexOf(role);
      const id = randomUUID();
      await request(server)
        .post('/v1/customers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          id,
          operationId: randomUUID(),
          name: `Role ${role}`,
          phone: `059220000${String(index)}`,
        })
        .expect(201);
      await fixturePool.query(
        'update platform.store_memberships set role=$1 where store_id=$2 and user_id=$3',
        [role, fixtures.stores.auth, fixtures.users.owner],
      );
      try {
        const read = await request(server)
          .get(`/v1/customers/${id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(bodyOf(read).id).toBe(id);
        const list = await request(server)
          .get('/v1/customers')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(bodyOf(list).items).toEqual(
          expect.arrayContaining([expect.objectContaining({ id })]),
        );
        const canEdit = role === 'owner' || role === 'manager';
        const createdId = randomUUID();
        let before = await customerEffects();
        const create = await request(server)
          .post('/v1/customers')
          .set('Authorization', `Bearer ${token}`)
          .send({
            id: createdId,
            operationId: randomUUID(),
            name: `Created ${role}`,
            phone: `059230000${String(index)}`,
          })
          .expect(canEdit ? 201 : 403);
        if (canEdit) {
          expect(bodyOf(create).id).toBe(createdId);
          const persisted = await adminPool.query(
            'select store_id, name from ledger.customers where id=$1',
            [createdId],
          );
          expect(persisted.rows).toEqual([
            { store_id: fixtures.stores.auth, name: `Created ${role}` },
          ]);
        } else {
          expect(bodyOf(create).code).toBe('CUSTOMER_WRITE_NOT_ALLOWED');
          expect(await customerEffects()).toEqual(before);
        }
        before = await customerEffects();
        await request(server)
          .patch(`/v1/customers/${id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ operationId: randomUUID(), expectedVersion: '1', notes: 'Authorized update' })
          .expect(canEdit ? 200 : 403);
        if (!canEdit) expect(await customerEffects()).toEqual(before);
        const version = canEdit ? '2' : '1';
        expect(
          (
            await adminPool.query('select version::text, notes from ledger.customers where id=$1', [
              id,
            ])
          ).rows[0],
        ).toEqual({ version, notes: canEdit ? 'Authorized update' : null });
        before = await customerEffects();
        await request(server)
          .post(`/v1/customers/${id}/archive`)
          .set('Authorization', `Bearer ${token}`)
          .send({ operationId: randomUUID(), expectedVersion: version })
          .expect(role === 'owner' ? 200 : 403);
        if (role !== 'owner') {
          expect(await customerEffects()).toEqual(before);
          await request(server)
            .post(`/v1/customers/${id}/archive`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ operationId: randomUUID(), expectedVersion: version })
            .expect(200);
        }
        expect(
          (
            await adminPool.query<{ status: string }>(
              'select status from ledger.customers where id=$1',
              [id],
            )
          ).rows[0]?.status,
        ).toBe('archived');
        before = await customerEffects();
        await request(server)
          .post(`/v1/customers/${id}/restore`)
          .set('Authorization', `Bearer ${token}`)
          .send({ operationId: randomUUID(), expectedVersion: String(Number(version) + 1) })
          .expect(role === 'owner' ? 200 : 403);
        if (role !== 'owner') expect(await customerEffects()).toEqual(before);
        expect(
          (
            await adminPool.query<{ status: string }>(
              'select status from ledger.customers where id=$1',
              [id],
            )
          ).rows[0]?.status,
        ).toBe(role === 'owner' ? 'active' : 'archived');
        before = await customerEffects();
        for (const authority of [
          { role: 'owner' },
          { requiredAuthority: 'member' },
          { storeId: fixtures.stores.extension },
          { deviceId: randomUUID() },
          { status: 'archived' },
        ]) {
          await request(server)
            .post('/v1/customers')
            .set('Authorization', `Bearer ${token}`)
            .send({
              id: randomUUID(),
              operationId: randomUUID(),
              name: 'Forged',
              phone: '0592400000',
              ...authority,
            })
            .expect(400);
        }
        expect(await customerEffects()).toEqual(before);
      } finally {
        await fixturePool.query(
          "update platform.store_memberships set role='owner' where store_id=$1 and user_id=$2",
          [fixtures.stores.auth, fixtures.users.owner],
        );
      }
    },
  );

  it('rejects foreign Customer reads and mutations using server-derived Store context', async () => {
    const a = await login('s18-5-owner@example.test');
    // Give this independent test fixture a valid entitlement to create the foreign target via HTTP.
    await fixturePool.query(
      "update platform.subscriptions set expires_at=clock_timestamp()+interval '1 day' where store_id=$1",
      [fixtures.stores.expiredRead],
    );
    try {
      const b = await login('s18-5-owner@example.test', fixtures.stores.expiredRead);
      const id = randomUUID();
      await request(server)
        .post('/v1/customers')
        .set('Authorization', `Bearer ${b}`)
        .send({ id, operationId: randomUUID(), name: 'Foreign Customer', phone: '0592500000' })
        .expect(201);
      const before = await customerEffects(fixtures.stores.expiredRead);
      await request(server)
        .get(`/v1/customers/${id}`)
        .set('Authorization', `Bearer ${a}`)
        .expect(404);
      await request(server)
        .patch(`/v1/customers/${id}`)
        .set('Authorization', `Bearer ${a}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', notes: 'Forbidden' })
        .expect(404);
      for (const action of ['archive', 'restore']) {
        await request(server)
          .post(`/v1/customers/${id}/${action}`)
          .set('Authorization', `Bearer ${a}`)
          .send({ operationId: randomUUID(), expectedVersion: '1' })
          .expect(404);
      }
      expect(await customerEffects(fixtures.stores.expiredRead)).toEqual(before);
    } finally {
      await fixturePool.query(
        "update platform.subscriptions set expires_at=clock_timestamp()-interval '1 day' where store_id=$1",
        [fixtures.stores.expiredRead],
      );
    }
  });

  it('keeps Platform Admin assignment separate from ordinary accounting and Customer write authority', async () => {
    const token = await login('s18-5-admin@example.test');
    await fixturePool.query(
      "update platform.store_memberships set role='viewer' where store_id=$1 and user_id=$2",
      [fixtures.stores.auth, fixtures.users.admin],
    );
    try {
      await request(server)
        .get('/v1/admin/stores')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const before = await customerEffects();
      await request(server)
        .get('/v1/money-accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      const id = randomUUID();
      await request(server)
        .post('/v1/money-accounts')
        .set('Authorization', `Bearer ${token}`)
        .send({ id, operationId: randomUUID(), name: 'Admin is not Owner' })
        .expect(403);
      expect(
        (await adminPool.query('select id from ledger.money_accounts where id=$1', [id])).rowCount,
      ).toBe(0);
      await request(server)
        .post('/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: randomUUID(),
          operationId: randomUUID(),
          name: 'Admin is not writer',
          phone: '0592600000',
        })
        .expect(403);
      expect(await customerEffects()).toEqual(before);
      await fixturePool.query(
        "update platform.store_memberships set status='removed' where store_id=$1 and user_id=$2",
        [fixtures.stores.auth, fixtures.users.admin],
      );
      await request(server)
        .get('/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      await request(server)
        .post('/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: randomUUID(),
          operationId: randomUUID(),
          name: 'Admin only',
          phone: '0592600001',
        })
        .expect(401);
      expect(await customerEffects()).toEqual(before);
      expect(
        (
          await adminPool.query<{ status: string }>(
            'select status from platform.platform_admin_assignments where user_id=$1',
            [fixtures.users.admin],
          )
        ).rows[0]?.status,
      ).toBe('active');
    } finally {
      await fixturePool.query(
        "update platform.store_memberships set role='owner', status='active' where store_id=$1 and user_id=$2",
        [fixtures.stores.auth, fixtures.users.admin],
      );
    }
  });

  it('rejects privileged function substitution and protected DELETE using the actual runtime role', async () => {
    if (!environment) throw new Error('Approved local PostgreSQL is required.');
    const deviceId = randomUUID();
    const token = await login('s18-5-owner@example.test', fixtures.stores.auth, deviceId);
    const id = randomUUID();
    await request(server)
      .post('/v1/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ id, operationId: randomUUID(), name: 'Protected deletion', phone: '0592700000' })
      .expect(201);
    const before = await customerEffects();
    const runtime = createTestPool(environment.runtimeUrl, 'dokana-stage-2b-functions', 1);
    const client = await runtime.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.store_id',$1,true), set_config('app.user_id',$2,true), set_config('app.device_id',$3,true), set_config('app.request_id',$4,true)`,
        [fixtures.stores.auth, fixtures.users.owner, deviceId, randomUUID()],
      );
      const calls: { query: string; values: unknown[]; code: string }[] = [
        {
          query: 'select * from ledger.list_platform_stores(null,null,10)',
          values: [],
          code: '42501',
        },
        {
          query: 'select * from ledger.read_subscription_lifecycle($1)',
          values: [fixtures.stores.auth],
          code: '42501',
        },
        {
          query: 'select * from ledger.read_subscription_history($1)',
          values: [fixtures.stores.auth],
          code: '42501',
        },
        {
          query: 'select * from ledger.read_store_provisioning_state($1)',
          values: [fixtures.stores.auth],
          code: '42501',
        },
        {
          query: 'select * from ledger.list_offline_licenses($1,10)',
          values: [fixtures.stores.auth],
          code: '42501',
        },
        {
          query: "select * from ledger.manage_subscription_lifecycle($1,'cancel',$2,$3,'Denied')",
          values: [fixtures.stores.auth, randomUUID(), 'a'.repeat(64)],
          code: '42501',
        },
        {
          query: "select * from ledger.manage_store_lifecycle($1,'suspend',1,$2,$3,'Denied')",
          values: [fixtures.stores.auth, randomUUID(), 'a'.repeat(64)],
          code: '42501',
        },
        {
          query:
            "select * from ledger.provision_store_identity($1,$2,'Denied',null,$3,$4,'Denied',false)",
          values: [fixtures.stores.auth, fixtures.users.admin, randomUUID(), 'a'.repeat(64)],
          code: '42501',
        },
        {
          query: "select * from ledger.revoke_offline_license($1,$2,$3,$4,'Denied')",
          values: [fixtures.stores.auth, randomUUID(), randomUUID(), 'a'.repeat(64)],
          code: '42501',
        },
        {
          query: 'select * from ledger.lock_effective_entitlement($1)',
          values: [fixtures.stores.extension],
          code: '42501',
        },
        {
          query: 'select * from ledger.read_offline_license_for_validation($1,$2,$3)',
          values: [fixtures.stores.auth, randomUUID(), randomUUID()],
          code: '42501',
        },
        { query: 'delete from ledger.customers where id=$1', values: [id], code: '55000' },
        {
          query: 'delete from platform.platform_admin_assignments where user_id=$1',
          values: [fixtures.users.admin],
          code: '42501',
        },
      ];
      for (const call of calls) {
        await client.query('savepoint authority_probe');
        await expect(client.query(call.query, call.values)).rejects.toMatchObject({
          code: call.code,
        });
        await client.query('rollback to savepoint authority_probe');
      }
      expect(
        (
          await client.query('delete from ledger.money_accounts where id=$1 returning id', [
            fixtures.targetMoneyAccount,
          ])
        ).rows,
      ).toEqual([]);
      // Even a legitimate admin actor cannot use an argument inconsistent with server context.
      await client.query("select set_config('app.user_id',$1,true)", [fixtures.users.admin]);
      await expect(
        client.query('select * from ledger.read_subscription_lifecycle($1)', [
          fixtures.stores.extension,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
      expect(await customerEffects()).toEqual(before);
    } finally {
      await client.query('rollback');
      client.release();
      await runtime.end();
    }
  });

  async function waitForRuntimeAuthorityLock(blockerPid: number, functionName: string) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const state = await adminPool.query<{ blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity where datname=current_database()
         and application_name='dokana-backend-test' and wait_event_type='Lock'
         and query like $1 and $2::int=any(pg_blocking_pids(pid))) as blocked`,
        [`%${functionName}%`, blockerPid],
      );
      if (state.rows[0]?.blocked) return;
      await nextTurn();
    }
    throw new Error(`Expected ${functionName} authority lock wait was not reached.`);
  }

  it.each(['membership_downgraded', 'membership_removed', 'device_revoked'] as const)(
    'rejects a waiting Customer write after %s before authority lock admission',
    async (transition) => {
      const deviceId = randomUUID();
      const token = await login('s18-5-owner@example.test', fixtures.stores.auth, deviceId);
      const id = randomUUID();
      const operationId = randomUUID();
      const lock = await adminPool.connect();
      let write: Promise<request.Response> | undefined;
      try {
        await lock.query('begin');
        await lock.query('select id from platform.subscriptions where store_id=$1 for update', [
          fixtures.stores.auth,
        ]);
        const blocker = (await lock.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0];
        if (!blocker) throw new Error('Missing blocker PID.');
        write = request(server)
          .post('/v1/customers')
          .set('Authorization', `Bearer ${token}`)
          .send({
            id,
            operationId,
            name: `Waiting ${transition}`,
            phone: `059280000${String(['membership_downgraded', 'membership_removed', 'device_revoked'].indexOf(transition))}`,
          })
          .then((response) => response);
        await waitForRuntimeAuthorityLock(blocker.pid, 'lock_effective_entitlement');
        if (transition === 'device_revoked') {
          await fixturePool.query("update ledger.devices set status='revoked' where id=$1", [
            deviceId,
          ]);
        } else {
          await fixturePool.query(
            'update platform.store_memberships set role=$1, status=$2 where store_id=$3 and user_id=$4',
            [
              transition === 'membership_downgraded' ? 'viewer' : 'owner',
              transition === 'membership_removed' ? 'removed' : 'active',
              fixtures.stores.auth,
              fixtures.users.owner,
            ],
          );
        }
        await lock.query('commit');
        const response = await write;
        // A subsequent request must also observe the committed authority transition.
        await request(server)
          .post('/v1/customers')
          .set('Authorization', `Bearer ${token}`)
          .send({
            id: randomUUID(),
            operationId: randomUUID(),
            name: 'After revocation',
            phone: '0592899999',
          })
          .expect(transition === 'membership_downgraded' ? 403 : 401);
        const effects = (
          await adminPool.query<{
            customers: number;
            operations: number;
            audit: number;
            changes: number;
          }>(
            `select (select count(*)::int from ledger.customers where id=$1) as customers,
           (select count(*)::int from sync.processed_operations where operation_id=$2) as operations,
           (select count(*)::int from audit.central_audit_logs where entity_id=$1) as audit,
           (select count(*)::int from sync.change_events where entity_id=$1) as changes`,
            [id, operationId],
          )
        ).rows[0];
        expect({ status: response.status, ...effects }).toEqual({
          status: 403,
          customers: 0,
          operations: 0,
          audit: 0,
          changes: 0,
        });
      } finally {
        await lock.query('rollback');
        if (write) await Promise.allSettled([write]);
        lock.release();
        await fixturePool.query(
          "update platform.store_memberships set role='owner', status='active' where store_id=$1 and user_id=$2",
          [fixtures.stores.auth, fixtures.users.owner],
        );
        await fixturePool.query("update ledger.devices set status='active' where id=$1", [
          deviceId,
        ]);
      }
    },
  );

  it('rejects a waiting administrative mutation after Platform Admin assignment revocation', async () => {
    const token = await login('s18-5-admin@example.test');
    const operationId = randomUUID();
    const target = fixtures.stores.listA;
    const effectsBefore = await operationEffects(target, operationId);
    const before = (
      await adminPool.query<{ status: string; version: string }>(
        'select status, version::text from ledger.stores where id=$1',
        [target],
      )
    ).rows[0] as { status: string; version: string };
    const lock = await adminPool.connect();
    let mutation: Promise<request.Response> | undefined;
    try {
      await lock.query('begin');
      await lock.query('select id from ledger.stores where id=$1 for update', [target]);
      const blocker = (await lock.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0];
      if (!blocker) throw new Error('Missing blocker PID.');
      mutation = request(server)
        .post(`/v1/admin/stores/${target}/lifecycle/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          operationId,
          expectedVersion: before.version,
          reason: 'Stage 2B revocation barrier',
        })
        .then((response) => response);
      await waitForRuntimeAuthorityLock(blocker.pid, 'manage_store_lifecycle');
      await fixturePool.query(
        "update platform.platform_admin_assignments set status='revoked', revoked_at=clock_timestamp(), revoked_by_user_id=$1, revoke_reason='Stage 2B revocation' where user_id=$1",
        [fixtures.users.admin],
      );
      await lock.query('commit');
      const response = await mutation;
      await request(server)
        .get('/v1/admin/stores')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      const actual = (
        await adminPool.query<{ status: string; version: string }>(
          'select status, version::text from ledger.stores where id=$1',
          [target],
        )
      ).rows[0];
      const actions = (
        await adminPool.query<{ count: number }>(
          'select count(*)::int as count from platform.admin_actions where request_id=$1',
          [operationId],
        )
      ).rows[0]?.count;
      expect({ status: response.status, store: actual, actions }).toEqual({
        status: 403,
        store: before,
        actions: 0,
      });
      expect(await operationEffects(target, operationId)).toEqual(effectsBefore);
      expect(JSON.stringify(response.body)).not.toMatch(/42501|pg_|SQL|stack|ledger\./i);
    } finally {
      await lock.query('rollback');
      if (mutation) await Promise.allSettled([mutation]);
      lock.release();
      await fixturePool.query(
        "update platform.platform_admin_assignments set status='active', revoked_at=null, revoked_by_user_id=null, revoke_reason=null where user_id=$1",
        [fixtures.users.admin],
      );
      await fixturePool.query('update ledger.stores set status=$1, version=$2 where id=$3', [
        before.status,
        before.version,
        target,
      ]);
    }
  });

  it('rejects subscription authority changes after admin revocation before target admission', async () => {
    const token = await login('s18-5-admin@example.test');
    const target = fixtures.stores.extension;
    const operationId = randomUUID();
    const before = (
      await adminPool.query('select * from platform.subscriptions where store_id=$1 order by id', [
        target,
      ])
    ).rows;
    const barrier = await adminPool.connect();
    let mutation: Promise<request.Response> | undefined;
    try {
      await barrier.query('begin');
      await barrier.query('select id from ledger.stores where id=$1 for update', [target]);
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        ?.pid;
      if (!pid) throw new Error('Missing barrier PID.');
      mutation = request(server)
        .post(`/v1/admin/stores/${target}/subscriptions/extend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ operationId, reason: 'Bounded same-pattern authority probe' })
        .then((response) => response);
      await waitForRuntimeAuthorityLock(pid, 'manage_subscription_lifecycle');
      await fixturePool.query(
        "update platform.platform_admin_assignments set status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=$1,revoke_reason='Same-pattern probe' where user_id=$1",
        [fixtures.users.admin],
      );
      await barrier.query('commit');
      const response = await mutation;
      const subscriptions = (
        await adminPool.query(
          'select * from platform.subscriptions where store_id=$1 order by id',
          [target],
        )
      ).rows;
      const actions = (
        await adminPool.query<{ count: number }>(
          'select count(*)::int as count from platform.admin_actions where request_id=$1',
          [operationId],
        )
      ).rows[0]?.count;
      await request(server)
        .post(`/v1/admin/stores/${target}/subscriptions/extend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ operationId: randomUUID(), reason: 'After revocation' })
        .expect(403);
      expect({ status: response.status, subscriptions, actions }).toEqual({
        status: 403,
        subscriptions: before,
        actions: 0,
      });
    } finally {
      await barrier.query('rollback');
      if (mutation) await Promise.allSettled([mutation]);
      barrier.release();
      await fixturePool.query(
        "update platform.platform_admin_assignments set status='active',revoked_at=null,revoked_by_user_id=null,revoke_reason=null where user_id=$1",
        [fixtures.users.admin],
      );
    }
  });

  it.each(['issue', 'revoke'] as const)(
    'rejects waiting license %s after authority revocation',
    async (action) => {
      const ownerToken = await login('s18-5-owner@example.test');
      let token = ownerToken;
      let licenseId = '';
      if (action === 'revoke') {
        const issued = await request(server)
          .post('/v1/licenses/verify')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ operationId: randomUUID() })
          .expect(200);
        const license = bodyOf(issued).license;
        if (
          !isRecord(license) ||
          !isRecord(license.payload) ||
          typeof license.payload.licenseId !== 'string'
        )
          throw new Error('Missing license.');
        licenseId = license.payload.licenseId;
        token = await login('s18-5-admin@example.test');
      }
      const operationId = randomUUID();
      const before = (
        await adminPool.query(
          'select * from platform.license_issuances where store_id=$1 order by id',
          [fixtures.stores.auth],
        )
      ).rows;
      const barrier = await adminPool.connect();
      let mutation: Promise<request.Response> | undefined;
      try {
        await barrier.query('begin');
        await barrier.query(
          action === 'issue'
            ? 'select id from platform.subscriptions where store_id=$1 for update'
            : 'select id from ledger.stores where id=$1 for update',
          [fixtures.stores.auth],
        );
        const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
          ?.pid;
        if (!pid) throw new Error('Missing barrier PID.');
        mutation = request(server)
          .post(
            action === 'issue'
              ? '/v1/licenses/verify'
              : `/v1/admin/stores/${fixtures.stores.auth}/licenses/${licenseId}/revoke`,
          )
          .set('Authorization', `Bearer ${token}`)
          .send(
            action === 'issue' ? { operationId } : { operationId, reason: 'Same-pattern probe' },
          )
          .then((response) => response);
        await waitForRuntimeAuthorityLock(
          pid,
          action === 'issue' ? 'prepare_offline_license' : 'revoke_offline_license',
        );
        if (action === 'issue')
          await fixturePool.query(
            "update platform.store_memberships set status='removed' where store_id=$1 and user_id=$2",
            [fixtures.stores.auth, fixtures.users.owner],
          );
        else
          await fixturePool.query(
            "update platform.platform_admin_assignments set status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=$1,revoke_reason='Same-pattern probe' where user_id=$1",
            [fixtures.users.admin],
          );
        await barrier.query('commit');
        const response = await mutation;
        const licenses = (
          await adminPool.query(
            'select * from platform.license_issuances where store_id=$1 order by id',
            [fixtures.stores.auth],
          )
        ).rows;
        const effects = (
          await adminPool.query<{ operations: number; actions: number }>(
            `select (select count(*)::int from sync.processed_operations where operation_id=$1) as operations,
        (select count(*)::int from platform.admin_actions where request_id=$1) as actions`,
            [operationId],
          )
        ).rows[0];
        expect({
          status: response.status,
          licensesUnchanged: JSON.stringify(licenses) === JSON.stringify(before),
          ...effects,
        }).toEqual({ status: 403, licensesUnchanged: true, operations: 0, actions: 0 });
      } finally {
        await barrier.query('rollback');
        if (mutation) await Promise.allSettled([mutation]);
        barrier.release();
        await fixturePool.query(
          "update platform.store_memberships set status='active' where store_id=$1 and user_id=$2",
          [fixtures.stores.auth, fixtures.users.owner],
        );
        await fixturePool.query(
          "update platform.platform_admin_assignments set status='active',revoked_at=null,revoked_by_user_id=null,revoke_reason=null where user_id=$1",
          [fixtures.users.admin],
        );
      }
    },
  );

  it.each(['subscription', 'license_issue', 'license_revoke'] as const)(
    'linearizes admitted %s authority before revocation',
    async (kind) => {
      if (!environment || !app) throw new Error('Approved application environment required.');
      const issue = kind === 'license_issue';
      const target = fixtures.stores.auth;
      const deviceId = randomUUID();
      const ownerToken = await login('s18-5-owner@example.test', target, deviceId);
      const token = issue ? ownerToken : await login('s18-5-admin@example.test');
      let path = '/v1/licenses/verify';
      let licenseId: string = randomUUID();
      if (kind === 'subscription') path = `/v1/admin/stores/${target}/subscriptions/extend`;
      if (kind === 'license_revoke') {
        const issued = await request(server)
          .post('/v1/licenses/verify')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ operationId: randomUUID() })
          .expect(200);
        const license = bodyOf(issued).license;
        if (
          !isRecord(license) ||
          !isRecord(license.payload) ||
          typeof license.payload.licenseId !== 'string'
        )
          throw new Error('Missing license.');
        licenseId = license.payload.licenseId;
        path = `/v1/admin/stores/${target}/licenses/${licenseId}/revoke`;
      }
      const operationId = randomUUID();
      const runtime = createTestPool(environment.runtimeUrl, 'dokana-stage2b-inverse-authority', 1);
      const writer = await runtime.connect();
      const revoker = await adminPool.connect();
      let revoke: Promise<unknown> | undefined;
      try {
        await writer.query('begin');
        await writer.query(
          `select set_config('app.store_id',$1,true),set_config('app.user_id',$2,true),
          set_config('app.device_id',$3,true),set_config('app.request_id',$4,true)`,
          [target, issue ? fixtures.users.owner : fixtures.users.admin, deviceId, randomUUID()],
        );
        await writer.query('select * from ledger.assert_platform_write_authority_v1(null)');
        // These server-only objects deliberately emit no Store change feed (0027).
        // Hold the actual normal-runtime transaction after its real function returns.
        if (kind === 'subscription') {
          await writer.query(
            "select * from ledger.manage_subscription_lifecycle($1,'extend',$2,$3,'Mutation wins')",
            [target, operationId, 'a'.repeat(64)],
          );
        } else if (issue) {
          const crypto = app.get(OfflineLicenseCryptoService);
          const prepared = await writer.query<{ signed_payload: unknown }>(
            'select * from ledger.prepare_offline_license($1,$2,$3,$4,$5,$6)',
            [target, deviceId, licenseId, operationId, 'a'.repeat(64), crypto.activeSigningKeyId],
          );
          const signature = crypto.sign(prepared.rows[0]?.signed_payload).signature;
          await writer.query('select * from ledger.complete_offline_license($1,$2,$3,$4,$5)', [
            target,
            licenseId,
            operationId,
            'a'.repeat(64),
            signature,
          ]);
        } else {
          await writer.query(
            "select * from ledger.revoke_offline_license($1,$2,$3,$4,'Mutation wins')",
            [target, licenseId, operationId, 'a'.repeat(64)],
          );
        }
        const writerPid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]?.pid;
        if (!writerPid) throw new Error('Missing writer PID.');
        await revoker.query('begin');
        await revoker.query("select set_config('app.store_id',$1,true)", [target]);
        revoke = issue
          ? revoker.query(
              "update platform.store_memberships set status='removed' where store_id=$1 and user_id=$2",
              [target, fixtures.users.owner],
            )
          : revoker.query(
              "update platform.platform_admin_assignments set status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=$1,revoke_reason='Mutation wins' where user_id=$1",
              [fixtures.users.admin],
            );
        await waitForBlockedPid(writerPid, 'update%');
        await writer.query('commit');
        await revoke;
        await revoker.query('commit');
        const effect = (
          await adminPool.query<{ count: number }>(
            issue
              ? "select count(*)::int as count from sync.processed_operations where operation_id=$1 and status='applied'"
              : 'select count(*)::int as count from platform.admin_actions where request_id=$1',
            [operationId],
          )
        ).rows[0]?.count;
        expect(effect).toBe(1);
        const state = (
          await adminPool.query<{ status: string }>(
            issue
              ? 'select status from platform.store_memberships where store_id=$1 and user_id=$2'
              : 'select status from platform.platform_admin_assignments where user_id=$1',
            issue ? [target, fixtures.users.owner] : [fixtures.users.admin],
          )
        ).rows[0]?.status;
        expect(state).toBe(issue ? 'removed' : 'revoked');
        await request(server)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send(
            issue
              ? { operationId: randomUUID() }
              : { operationId: randomUUID(), reason: 'After revocation' },
          )
          .expect(issue ? 401 : 403);
      } finally {
        await writer.query('rollback');
        if (revoke) await Promise.allSettled([revoke]);
        await revoker.query('rollback');
        writer.release();
        revoker.release();
        await runtime.end();
        await fixturePool.query(
          "update platform.store_memberships set status='active' where store_id=$1 and user_id=$2",
          [target, fixtures.users.owner],
        );
        await fixturePool.query(
          "update platform.platform_admin_assignments set status='active',revoked_at=null,revoked_by_user_id=null,revoke_reason=null where user_id=$1",
          [fixtures.users.admin],
        );
      }
    },
  );

  async function waitForBlockedPid(blockerPid: number, query: string): Promise<number> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const state = await adminPool.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname=current_database()
         and wait_event_type='Lock' and query ilike $1
         and $2::int=any(pg_blocking_pids(pid))`,
        [query, blockerPid],
      );
      if (state.rows[0]) return state.rows[0].pid;
      await nextTurn();
    }
    throw new Error('Expected opposing authority transaction to wait.');
  }

  async function operationEffects(id: string, operationId: string) {
    return (
      await adminPool.query<{
        customers: number;
        operations: number;
        audit: number;
        changes: number;
      }>(
        `select (select count(*)::int from ledger.customers where id=$1) as customers,
        (select count(*)::int from sync.processed_operations where operation_id=$2) as operations,
        (select count(*)::int from audit.central_audit_logs where entity_id=$1) as audit,
        (select count(*)::int from sync.change_events where entity_id=$1) as changes`,
        [id, operationId],
      )
    ).rows[0];
  }

  it.each([
    'membership_downgraded',
    'membership_removed',
    'device_revoked',
    'admin_revoked',
  ] as const)(
    'allows an admitted mutation to win before %s and rejects the next request',
    async (transition) => {
      const isAdmin = transition === 'admin_revoked';
      const target = isAdmin ? fixtures.stores.listA : fixtures.stores.auth;
      const deviceId = randomUUID();
      const token = await login(
        isAdmin ? 's18-5-admin@example.test' : 's18-5-owner@example.test',
        fixtures.stores.auth,
        deviceId,
      );
      const id = randomUUID();
      const operationId = randomUUID();
      const before = (
        await adminPool.query<{ status: string; version: string }>(
          'select status, version::text from ledger.stores where id=$1',
          [target],
        )
      ).rows[0];
      if (!before) throw new Error('Missing target Store.');
      await fixturePool.query(
        'insert into sync.store_change_watermarks_v1(store_id,last_sequence) values($1,0) on conflict do nothing',
        [target],
      );
      const barrier = await adminPool.connect();
      const revoker = await adminPool.connect();
      let write: Promise<request.Response> | undefined;
      let revoke: Promise<unknown> | undefined;
      try {
        await barrier.query('begin');
        await barrier.query(
          'select store_id from sync.store_change_watermarks_v1 where store_id=$1 for update',
          [target],
        );
        const barrierPid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]?.pid;
        if (!barrierPid) throw new Error('Missing barrier PID.');
        write = (
          isAdmin
            ? request(server)
                .post(`/v1/admin/stores/${target}/lifecycle/suspend`)
                .set('Authorization', `Bearer ${token}`)
                .send({ operationId, expectedVersion: before.version, reason: 'Mutation wins' })
            : request(server)
                .post('/v1/customers')
                .set('Authorization', `Bearer ${token}`)
                .send({
                  id,
                  operationId,
                  name: 'Admitted mutation',
                  phone: `059290000${String(['membership_downgraded', 'membership_removed', 'device_revoked', 'admin_revoked'].indexOf(transition))}`,
                })
        ).then((response) => response);
        // Deferred change-feed allocation blocks COMMIT after real HTTP effect admission.
        const writerPid = await waitForBlockedPid(barrierPid, 'commit');
        await revoker.query('begin');
        await revoker.query(
          `select set_config('app.store_id',$1,true),set_config('app.user_id',$2,true),
          set_config('app.device_id',$3,true),set_config('app.request_id',$4,true)`,
          [
            target,
            isAdmin ? fixtures.users.admin : fixtures.users.owner,
            isAdmin ? '' : deviceId,
            randomUUID(),
          ],
        );
        revoke = isAdmin
          ? revoker.query(
              "update platform.platform_admin_assignments set status='revoked', revoked_at=clock_timestamp(), revoked_by_user_id=$1, revoke_reason='Mutation wins' where user_id=$1",
              [fixtures.users.admin],
            )
          : transition === 'device_revoked'
            ? revoker.query("update ledger.devices set status='revoked' where id=$1", [deviceId])
            : revoker.query(
                'update platform.store_memberships set role=$1,status=$2 where store_id=$3 and user_id=$4',
                [
                  transition === 'membership_downgraded' ? 'viewer' : 'owner',
                  transition === 'membership_removed' ? 'removed' : 'active',
                  target,
                  fixtures.users.owner,
                ],
              );
        await waitForBlockedPid(writerPid, 'update%');
        await barrier.query('commit');
        expect((await write).status).toBe(isAdmin ? 200 : 201);
        await revoke;
        await revoker.query('commit');
        if (isAdmin) {
          expect(
            (
              await adminPool.query<{ status: string; version: string }>(
                'select status,version::text from ledger.stores where id=$1',
                [target],
              )
            ).rows[0],
          ).toEqual({ status: 'suspended', version: (BigInt(before.version) + 1n).toString() });
          expect(
            (
              await adminPool.query<{ count: number }>(
                'select count(*)::int as count from platform.admin_actions where request_id=$1',
                [operationId],
              )
            ).rows[0]?.count,
          ).toBe(1);
          expect(
            (
              await adminPool.query<{ status: string }>(
                'select status from platform.platform_admin_assignments where user_id=$1',
                [fixtures.users.admin],
              )
            ).rows[0]?.status,
          ).toBe('revoked');
          await request(server)
            .post(`/v1/admin/stores/${target}/lifecycle/restore`)
            .set('Authorization', `Bearer ${token}`)
            .send({
              operationId: randomUUID(),
              expectedVersion: (BigInt(before.version) + 1n).toString(),
              reason: 'After revocation',
            })
            .expect(403);
        } else {
          expect(await operationEffects(id, operationId)).toEqual({
            customers: 1,
            operations: 1,
            audit: 1,
            changes: 1,
          });
          const state =
            transition === 'device_revoked'
              ? (
                  await adminPool.query<{ value: string }>(
                    'select status as value from ledger.devices where id=$1',
                    [deviceId],
                  )
                ).rows[0]?.value
              : (
                  await adminPool.query<{ value: string }>(
                    `select ${transition === 'membership_removed' ? 'status' : 'role'} as value
               from platform.store_memberships where store_id=$1 and user_id=$2`,
                    [target, fixtures.users.owner],
                  )
                ).rows[0]?.value;
          expect(state).toBe(
            transition === 'device_revoked'
              ? 'revoked'
              : transition === 'membership_removed'
                ? 'removed'
                : 'viewer',
          );
          await request(server)
            .post('/v1/customers')
            .set('Authorization', `Bearer ${token}`)
            .send({
              id: randomUUID(),
              operationId: randomUUID(),
              name: 'After revocation',
              phone: '0592999999',
            })
            .expect(transition === 'membership_downgraded' ? 403 : 401);
        }
      } finally {
        await barrier.query('rollback');
        if (write) await Promise.allSettled([write]);
        if (revoke) await Promise.allSettled([revoke]);
        await revoker.query('rollback');
        barrier.release();
        revoker.release();
        await fixturePool.query(
          "update platform.store_memberships set role='owner',status='active' where store_id=$1 and user_id=$2",
          [fixtures.stores.auth, fixtures.users.owner],
        );
        await fixturePool.query("update ledger.devices set status='active' where id=$1", [
          deviceId,
        ]);
        await fixturePool.query(
          "update platform.platform_admin_assignments set status='active',revoked_at=null,revoked_by_user_id=null,revoke_reason=null where user_id=$1",
          [fixtures.users.admin],
        );
        if (isAdmin)
          await fixturePool.query('update ledger.stores set status=$1,version=$2 where id=$3', [
            before.status,
            before.version,
            target,
          ]);
      }
    },
  );

  it('rolls back all Customer effects when a controlled failure occurs after authority admission', async () => {
    const token = await login('s18-5-owner@example.test');
    const id = randomUUID();
    const operationId = randomUUID();
    const barrier = await adminPool.connect();
    let write: Promise<request.Response> | undefined;
    try {
      await barrier.query('begin');
      await barrier.query(
        'select store_id from sync.store_change_watermarks_v1 where store_id=$1 for update',
        [fixtures.stores.auth],
      );
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        ?.pid;
      if (!pid) throw new Error('Missing barrier PID.');
      write = request(server)
        .post('/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ id, operationId, name: 'Rollback after admission', phone: '0592999998' })
        .then((response) => response);
      const writerPid = await waitForBlockedPid(pid, 'commit');
      // Cancel only this test's observed runtime COMMIT to force a real rollback.
      expect(
        (
          await adminPool.query<{ cancelled: boolean }>(
            'select pg_cancel_backend($1) as cancelled',
            [writerPid],
          )
        ).rows[0]?.cancelled,
      ).toBe(true);
      const response = await write;
      expect(response.status).toBe(500); // Injected transaction failure, not authority rejection.
      expect(JSON.stringify(response.body)).not.toMatch(/pg_|SQL|stack|statement|ledger\./i);
      expect(await operationEffects(id, operationId)).toEqual({
        customers: 0,
        operations: 0,
        audit: 0,
        changes: 0,
      });
    } finally {
      await barrier.query('rollback');
      if (write) await Promise.allSettled([write]);
      barrier.release();
    }
  });

  it('rejects a real HTTP business write when subscription expiry precedes lock admission', async () => {
    const token = await login('s18-5-owner@example.test');
    const id = randomUUID();
    const operationId = randomUUID();
    const lock = await adminPool.connect();
    let write: Promise<request.Response> | undefined;
    try {
      await lock.query('begin');
      await lock.query('select id from platform.subscriptions where store_id=$1 for update', [
        fixtures.stores.auth,
      ]);
      write = request(server)
        .post('/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ id, operationId, name: 'Stage 2B expiry race', phone: '0591234567' })
        .then((response) => response);
      const deadline = Date.now() + 4_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const state = await adminPool.query<{ blocked: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname=current_database()
           and application_name='dokana-backend-test' and wait_event_type='Lock'
           and query like '%lock_effective_entitlement%'
           and $1::int = any(pg_blocking_pids(pid))) as blocked`,
          [(await lock.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid],
        );
        if (state.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await nextTurn();
      }
      expect(blocked).toBe(true);
      // Real PostgreSQL time advances after the call has entered its lock wait.
      // The committed expiry is now past before that call can acquire authority.
      await lock.query(
        'update platform.subscriptions set expires_at=clock_timestamp() where store_id=$1',
        [fixtures.stores.auth],
      );
      await lock.query('commit');
      const response = await write;
      const effects = await adminPool.query<{
        customers: number;
        operations: number;
        audit: number;
        changes: number;
      }>(
        `select (select count(*)::int from ledger.customers where id=$1) as customers,
         (select count(*)::int from sync.processed_operations where operation_id=$2) as operations,
         (select count(*)::int from audit.central_audit_logs where entity_id=$1) as audit,
         (select count(*)::int from sync.change_events where entity_id=$1) as changes`,
        [id, operationId],
      );
      expect({ status: response.status, ...effects.rows[0] }).toEqual({
        status: 403,
        customers: 0,
        operations: 0,
        audit: 0,
        changes: 0,
      });
    } finally {
      await lock.query('rollback');
      if (write) await Promise.allSettled([write]);
      lock.release();
      await fixturePool.query(
        "update platform.subscriptions set expires_at=clock_timestamp()+interval '30 days' where store_id=$1",
        [fixtures.stores.auth],
      );
    }
  });
});
