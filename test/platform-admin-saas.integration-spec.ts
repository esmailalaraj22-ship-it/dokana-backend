import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { ForbiddenException, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { encodePlatformAdminCursor } from '../src/platform-authority/platform-admin-cursor';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
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

  function context(storeId: string, userId: string = fixtures.users.admin) {
    return {
      storeId,
      userId,
      deviceId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  async function login(email: string, storeId: string = fixtures.stores.auth): Promise<string> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email,
        password,
        storeId,
        deviceId: randomUUID(),
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
    if (!poolsInitialized) return;
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
    await expect(
      database.withBusinessWriteTransaction(context(fixtures.stores.extension), async () => 'ok'),
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
      await new Promise((resolve) => setTimeout(resolve, 100));
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
      await new Promise((resolve) => setTimeout(resolve, 100));
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
});
