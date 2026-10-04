import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { OfflineEntitlementHandoffService } from '../src/offline-licenses/offline-entitlement-handoff.service';
import { OfflineLicenseService } from '../src/offline-licenses/offline-license.service';
import type {
  OfflineEntitlementSyncEnvelope,
  OfflineLicenseResponse,
} from '../src/offline-licenses/offline-license.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const describeWithPostgres = environment ? describe : describe.skip;

jest.setTimeout(180_000);

const fixtures = {
  users: {
    owner: '18610000-0000-4000-8000-000000000001',
    admin: '18610000-0000-4000-8000-000000000002',
    ordinary: '18610000-0000-4000-8000-000000000003',
  },
  stores: {
    auth: '18600000-0000-4000-8000-000000000001',
    happy: '18600000-0000-4000-8000-000000000002',
    cap: '18600000-0000-4000-8000-000000000003',
    expired: '18600000-0000-4000-8000-000000000004',
    cancelled: '18600000-0000-4000-8000-000000000005',
    future: '18600000-0000-4000-8000-000000000006',
    missing: '18600000-0000-4000-8000-000000000007',
    readOnly: '18600000-0000-4000-8000-000000000008',
    suspended: '18600000-0000-4000-8000-000000000009',
    archived: '18600000-0000-4000-8000-000000000010',
    invalidDevice: '18600000-0000-4000-8000-000000000011',
    adminTarget: '18600000-0000-4000-8000-000000000012',
    handoff: '18600000-0000-4000-8000-000000000013',
    subscriptionRace: '18600000-0000-4000-8000-000000000014',
    suspensionRace: '18600000-0000-4000-8000-000000000015',
  },
  devices: {
    cap: '18620000-0000-4000-8000-000000000003',
    expired: '18620000-0000-4000-8000-000000000004',
    cancelled: '18620000-0000-4000-8000-000000000005',
    future: '18620000-0000-4000-8000-000000000006',
    missing: '18620000-0000-4000-8000-000000000007',
    readOnly: '18620000-0000-4000-8000-000000000008',
    suspended: '18620000-0000-4000-8000-000000000009',
    archived: '18620000-0000-4000-8000-000000000010',
    invalidDevice: '18620000-0000-4000-8000-000000000011',
    adminTarget: '18620000-0000-4000-8000-000000000012',
    handoff: '18620000-0000-4000-8000-000000000013',
    subscriptionRace: '18620000-0000-4000-8000-000000000014',
    suspensionRace: '18620000-0000-4000-8000-000000000015',
  },
  plan: '18630000-0000-4000-8000-000000000001',
} as const;

const password = 'S18.6-Integration-Password!';
const fixtureStoreIds = Object.values(fixtures.stores);
const fixtureUserIds = Object.values(fixtures.users);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(response: { body: unknown }): Record<string, unknown> {
  if (!isRecord(response.body)) throw new Error('Expected a structured response body.');
  return response.body;
}

function postgresErrorCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

async function expectPostgresError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error ${code}.`);
  } catch (error) {
    expect(postgresErrorCode(error)).toBe(code);
  }
}

describeWithPostgres('S18.6 signed Offline License authority', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let fixturePool: Pool;
  let runtimePool: Pool;
  let licenses: OfflineLicenseService;
  let handoff: OfflineEntitlementHandoffService;
  let activePlanId: string;
  let ownsPlan = false;
  let poolsInitialized = false;
  const subscriptionIds = new Map<string, string>();

  function directContext(storeId: string, deviceId: string): TenantTransactionContext {
    return { storeId, userId: fixtures.users.owner, deviceId, requestId: randomUUID() };
  }

  function principal(context: TenantTransactionContext): AuthenticatedPrincipal {
    return {
      userId: context.userId,
      email: 's18-6-owner@example.test',
      fullName: 'S18.6 Owner',
      storeId: context.storeId,
      storeName: 'S18.6 Store',
      storeStatus: 'active',
      membershipRole: 'owner',
      membershipVersion: '1',
      deviceId: context.deviceId,
      sessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    };
  }

  async function login(
    email: string,
    storeId: string,
    deviceId = randomUUID(),
  ): Promise<{ token: string; deviceId: string }> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email,
        password,
        storeId,
        deviceId,
        deviceName: 'S18.6 integration device',
        devicePlatform: 'android',
      })
      .expect(200);
    const body = bodyOf(response);
    if (typeof body.accessToken !== 'string' || typeof body.deviceId !== 'string') {
      throw new Error('Expected authentication token and device identity.');
    }
    return { token: body.accessToken, deviceId: body.deviceId };
  }

  async function seedSubscription(
    storeId: string,
    status: 'active' | 'cancelled',
    startsAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    const id = randomUUID();
    subscriptionIds.set(storeId, id);
    await fixturePool.query(
      `insert into platform.subscriptions (
         id, store_id, plan_id, status, starts_at, expires_at, cancelled_at
       ) values (
         $1, $2, $3, $4, $5, $6,
         case when $4::text = 'cancelled' then clock_timestamp() else null end
       )`,
      [id, storeId, activePlanId, status, startsAt, expiresAt],
    );
  }

  async function setTenantContext(
    client: PoolClient,
    storeId: string,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    await client.query(`select set_config('app.store_id', $1, true)`, [storeId]);
    await client.query(`select set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`select set_config('app.device_id', $1, true)`, [deviceId]);
    await client.query(`select set_config('app.request_id', $1, true)`, [randomUUID()]);
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
    adminPool = createTestPool(environment.adminUrl, 'dokana-s18-6-admin', 5);
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s18-6-fixture',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s18-6-runtime', 3);
    poolsInitialized = true;
    await removeFixtures();

    const plans = await adminPool.query<{ id: string }>(
      `select id from platform.subscription_plans where status = 'active' order by id`,
    );
    if (plans.rowCount === 0) {
      await fixturePool.query(
        `insert into platform.subscription_plans (
           id, code, name, duration_days, price_minor, offline_grace_days, status
         ) values ($1, 'dokana-s18-6-mvp', 'Dokana S18.6 MVP', 30, 0, 0, 'active')`,
        [fixtures.plan],
      );
      activePlanId = fixtures.plan;
      ownsPlan = true;
    } else if (plans.rowCount === 1 && plans.rows[0]) {
      activePlanId = plans.rows[0].id;
    } else {
      throw new Error('S18.6 requires exactly one active Subscription plan.');
    }

    for (const [name, id] of Object.entries(fixtures.stores)) {
      const status =
        name === 'readOnly'
          ? 'read_only'
          : name === 'suspended'
            ? 'suspended'
            : name === 'archived'
              ? 'archived'
              : 'active';
      await fixturePool.query(`insert into ledger.stores (id, name, status) values ($1, $2, $3)`, [
        id,
        `S18.6 ${name}`,
        status,
      ]);
    }

    const passwordHash = await new PasswordService().hash(password);
    await fixturePool.query(
      `insert into platform.users (
         id, email, normalized_email, password_hash, full_name, status
       ) values
       ($1, 's18-6-owner@example.test', 's18-6-owner@example.test', $4, 'S18.6 Owner', 'active'),
       ($2, 's18-6-admin@example.test', 's18-6-admin@example.test', $4, 'S18.6 Admin', 'active'),
       ($3, 's18-6-ordinary@example.test', 's18-6-ordinary@example.test', $4, 'S18.6 Ordinary', 'active')`,
      [fixtures.users.owner, fixtures.users.admin, fixtures.users.ordinary, passwordHash],
    );

    for (const storeId of fixtureStoreIds) {
      await fixturePool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, 'owner', 'active')`,
        [randomUUID(), storeId, fixtures.users.owner],
      );
    }
    for (const userId of [fixtures.users.admin, fixtures.users.ordinary]) {
      await fixturePool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, 'support', 'active')`,
        [randomUUID(), fixtures.stores.auth, userId],
      );
    }
    await fixturePool.query(
      `insert into platform.platform_admin_assignments (user_id, status)
       values ($1, 'active')`,
      [fixtures.users.admin],
    );

    let deviceIndex = 0;
    for (const [name, deviceId] of Object.entries(fixtures.devices)) {
      deviceIndex += 1;
      const storeId = fixtures.stores[name as keyof typeof fixtures.stores];
      await fixturePool.query(
        `insert into ledger.devices (
           id, store_id, device_name, platform, installation_id, device_prefix, status
         ) values ($1, $2, $3, 'android', $4, $5, $6)`,
        [
          deviceId,
          storeId,
          `S18.6 ${name} device`,
          randomUUID(),
          `L${String(deviceIndex).padStart(2, '0')}`,
          name === 'invalidDevice' ? 'revoked' : 'active',
        ],
      );
    }

    const now = Date.now();
    const activeStores = [
      fixtures.stores.happy,
      fixtures.stores.cap,
      fixtures.stores.readOnly,
      fixtures.stores.suspended,
      fixtures.stores.archived,
      fixtures.stores.invalidDevice,
      fixtures.stores.adminTarget,
      fixtures.stores.handoff,
      fixtures.stores.subscriptionRace,
      fixtures.stores.suspensionRace,
    ];
    for (const storeId of activeStores) {
      const end =
        storeId === fixtures.stores.cap ? now + 2 * 60 * 60 * 1_000 : now + 30 * 86_400_000;
      await seedSubscription(storeId, 'active', new Date(now - 86_400_000), new Date(end));
    }
    await seedSubscription(
      fixtures.stores.expired,
      'active',
      new Date(now - 2 * 86_400_000),
      new Date(now - 60_000),
    );
    await seedSubscription(
      fixtures.stores.cancelled,
      'cancelled',
      new Date(now - 86_400_000),
      new Date(now + 86_400_000),
    );
    await seedSubscription(
      fixtures.stores.future,
      'active',
      new Date(now + 86_400_000),
      new Date(now + 31 * 86_400_000),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    const config = app.get(AppConfigService);
    configureApplication(app as NestExpressApplication, config);
    app.useLogger(app.get(Logger));
    await app.init();
    server = app.getHttpServer() as Server;
    licenses = app.get(OfflineLicenseService);
    handoff = app.get(OfflineEntitlementHandoffService);
  });

  afterAll(async () => {
    if (poolsInitialized) await removeFixtures();
    if (app) await app.close();
    if (poolsInitialized)
      await Promise.all([adminPool.end(), fixturePool.end(), runtimePool.end()]);
  });

  it('preserves forced RLS and grants only narrow runtime function execution', async () => {
    const functions = await adminPool.query<{
      functionName: string;
      owner: string;
      securityDefiner: boolean;
      configuration: string[] | null;
      runtimeExecute: boolean;
      authExecute: boolean;
      publicExecute: boolean;
    }>(`
      select
        p.proname as "functionName",
        pg_get_userbyid(p.proowner) as owner,
        p.prosecdef as "securityDefiner",
        p.proconfig as configuration,
        has_function_privilege('shop_app_runtime', p.oid, 'EXECUTE') as "runtimeExecute",
        has_function_privilege('shop_app_auth', p.oid, 'EXECUTE') as "authExecute",
        has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute"
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ledger'
        and p.proname in (
          'prepare_offline_license',
          'complete_offline_license',
          'read_offline_license_for_validation',
          'list_offline_licenses',
          'revoke_offline_license'
        )
      order by p.proname
    `);
    expect(functions.rows).toHaveLength(5);
    for (const row of functions.rows) {
      expect(row).toMatchObject({
        owner: 'shop_app_migrator',
        securityDefiner: true,
        configuration: ['search_path=pg_catalog, pg_temp'],
        runtimeExecute: true,
        authExecute: false,
        publicExecute: false,
      });
    }

    const firewall = await adminPool.query<{
      platformUsage: boolean;
      licenseSelect: boolean;
      licenseInsert: boolean;
      licenseUpdate: boolean;
      sequenceUsage: boolean;
      forcedRls: boolean;
    }>(`
      select
        has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') as "platformUsage",
        has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'SELECT') as "licenseSelect",
        has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'INSERT') as "licenseInsert",
        has_table_privilege('shop_app_runtime', 'platform.license_issuances', 'UPDATE') as "licenseUpdate",
        has_sequence_privilege(
          'shop_app_runtime', 'platform.license_issuances_license_serial_seq', 'USAGE'
        ) as "sequenceUsage",
        (select relrowsecurity and relforcerowsecurity
         from pg_class where oid = 'platform.license_issuances'::regclass) as "forcedRls"
    `);
    expect(firewall.rows[0]).toEqual({
      platformUsage: false,
      licenseSelect: false,
      licenseInsert: false,
      licenseUpdate: false,
      sequenceUsage: false,
      forcedRls: true,
    });
    await expectPostgresError(
      runtimePool.query(`select * from platform.license_issuances`),
      '42501',
    );
  });

  it('issues a 7-day Store/device-bound License and exactly replays it', async () => {
    const session = await login('s18-6-owner@example.test', fixtures.stores.happy);
    const operationId = randomUUID();
    const first = await request(server)
      .post('/v1/licenses/verify')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ operationId })
      .expect(200);
    const firstBody = bodyOf(first) as unknown as OfflineLicenseResponse;
    expect(firstBody).toMatchObject({
      operationId,
      replayed: false,
      license: {
        algorithm: 'Ed25519',
        payload: {
          storeId: fixtures.stores.happy,
          deviceId: session.deviceId,
          licenseVersion: 1,
          storeEntitlement: {
            storeStatus: 'active',
            subscriptionStatus: 'active',
            effectiveAccess: 'write',
          },
        },
      },
      trustedTime: {
        expiryBoundary: 'exclusive',
        clockRollbackPolicy: 'read_only_and_online_revalidation_required',
      },
    });
    expect(
      Date.parse(firstBody.license.payload.offlineValidUntil) -
        Date.parse(firstBody.license.payload.issuedAt),
    ).toBe(168 * 60 * 60 * 1_000);

    const replay = await request(server)
      .post('/v1/licenses/verify')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ operationId })
      .expect(200);
    const replayBody = bodyOf(replay) as unknown as OfflineLicenseResponse;
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.license).toEqual(firstBody.license);
    expect(replayBody.serverTime).toBe(firstBody.serverTime);
  });

  it('caps validity at Subscription end and rejects ineligible central states and devices', async () => {
    const capContext = directContext(fixtures.stores.cap, fixtures.devices.cap);
    const capped = await licenses.issue(principal(capContext), capContext, {
      operationId: randomUUID(),
    });
    const capSubscription = await adminPool.query<{ expiresAt: Date }>(
      `select expires_at as "expiresAt" from platform.subscriptions where id = $1`,
      [subscriptionIds.get(fixtures.stores.cap)],
    );
    expect(Date.parse(capped.nextOnlineVerificationRequiredAt)).toBe(
      capSubscription.rows[0]?.expiresAt.getTime(),
    );

    const rejected = [
      [fixtures.stores.expired, fixtures.devices.expired],
      [fixtures.stores.cancelled, fixtures.devices.cancelled],
      [fixtures.stores.future, fixtures.devices.future],
      [fixtures.stores.missing, fixtures.devices.missing],
      [fixtures.stores.readOnly, fixtures.devices.readOnly],
      [fixtures.stores.suspended, fixtures.devices.suspended],
      [fixtures.stores.archived, fixtures.devices.archived],
      [fixtures.stores.invalidDevice, fixtures.devices.invalidDevice],
      [fixtures.stores.invalidDevice, fixtures.devices.cap],
    ] as const;
    for (const [storeId, deviceId] of rejected) {
      const context = directContext(storeId, deviceId);
      await expect(
        licenses.issue(principal(context), context, { operationId: randomUUID() }),
      ).rejects.toMatchObject({ response: { code: 'OFFLINE_LICENSE_NOT_AVAILABLE' } });
    }
  });

  it('provides deterministic conflict and one issuance under concurrent duplicate requests', async () => {
    const firstSession = await login('s18-6-owner@example.test', fixtures.stores.happy);
    const secondSession = await login('s18-6-owner@example.test', fixtures.stores.happy);
    const conflictOperation = randomUUID();
    await request(server)
      .post('/v1/licenses/verify')
      .set('Authorization', `Bearer ${firstSession.token}`)
      .send({ operationId: conflictOperation })
      .expect(200);
    await request(server)
      .post('/v1/licenses/verify')
      .set('Authorization', `Bearer ${secondSession.token}`)
      .send({ operationId: conflictOperation })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
      });

    const duplicateOperation = randomUUID();
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(server)
          .post('/v1/licenses/verify')
          .set('Authorization', `Bearer ${firstSession.token}`)
          .send({ operationId: duplicateOperation })
          .expect(200),
      ),
    );
    const bodies = responses.map(
      (response) => bodyOf(response) as unknown as OfflineLicenseResponse,
    );
    expect(bodies.map((body) => body.replayed).sort()).toEqual([false, true]);
    expect(bodies[0]?.license).toEqual(bodies[1]?.license);
    const count = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count
       from sync.processed_operations
       where store_id = $1 and operation_id = $2 and status = 'applied'`,
      [fixtures.stores.happy, duplicateOperation],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('supports narrow Platform Admin reads, idempotent revocation, and immutable audit', async () => {
    const context = directContext(fixtures.stores.adminTarget, fixtures.devices.adminTarget);
    const issued = await licenses.issue(principal(context), context, { operationId: randomUUID() });
    const admin = await login('s18-6-admin@example.test', fixtures.stores.auth);
    const ordinary = await login('s18-6-ordinary@example.test', fixtures.stores.auth);

    await request(server)
      .get(`/v1/admin/stores/${fixtures.stores.adminTarget}/licenses?limit=10`)
      .set('Authorization', `Bearer ${ordinary.token}`)
      .expect(403);
    const listed = await request(server)
      .get(`/v1/admin/stores/${fixtures.stores.adminTarget}/licenses?limit=10`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(bodyOf(listed).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ licenseId: issued.license.payload.licenseId, status: 'active' }),
      ]),
    );

    const operationId = randomUUID();
    const command = { operationId, reason: 'Compromised local device trust' };
    const revoked = await request(server)
      .post(
        `/v1/admin/stores/${fixtures.stores.adminTarget}/licenses/${issued.license.payload.licenseId}/revoke`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .send(command)
      .expect(200);
    expect(bodyOf(revoked)).toMatchObject({ replayed: false, operationId });
    const replay = await request(server)
      .post(
        `/v1/admin/stores/${fixtures.stores.adminTarget}/licenses/${issued.license.payload.licenseId}/revoke`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .send(command)
      .expect(200);
    expect(bodyOf(replay)).toMatchObject({ replayed: true, operationId });
    await request(server)
      .post(
        `/v1/admin/stores/${fixtures.stores.adminTarget}/licenses/${issued.license.payload.licenseId}/revoke`,
      )
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ ...command, reason: 'Changed reason' })
      .expect(409);

    const audit = await adminPool.query<{ id: string }>(
      `select id from platform.admin_actions
       where store_id = $1 and request_id = $2 and action = 'offline_license_revoked'`,
      [fixtures.stores.adminTarget, operationId],
    );
    expect(audit.rowCount).toBe(1);
    await expectPostgresError(
      adminPool.query(`update platform.admin_actions set reason = 'tampered' where id = $1`, [
        audit.rows[0]?.id,
      ]),
      '55000',
    );
    await expect(
      licenses.issue(principal(context), context, { operationId: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: 'OFFLINE_LICENSE_NOT_AVAILABLE' } });
  });

  it('preserves the S19 distinction between valid late sync and invalid entitlement evidence', async () => {
    const context = directContext(fixtures.stores.handoff, fixtures.devices.handoff);
    const issued = await licenses.issue(principal(context), context, { operationId: randomUUID() });
    const payload = issued.license.payload;
    const envelope: OfflineEntitlementSyncEnvelope = {
      storeId: payload.storeId,
      deviceId: payload.deviceId,
      operationId: randomUUID(),
      licenseId: payload.licenseId,
      licenseVersion: 1,
      signingKeyId: payload.signingKeyId,
      subscriptionId: payload.subscriptionId,
      subscriptionVersion: payload.subscriptionVersion,
      clientRecordedAt: new Date(Date.parse(payload.issuedAt) + 1_000).toISOString(),
      trustedTimeState: 'trusted',
      license: issued.license,
    };

    await fixturePool.query(
      `update platform.subscriptions
       set status = 'expired', expires_at = clock_timestamp() - interval '1 second',
           updated_at = clock_timestamp(), version = version + 1
       where id = $1`,
      [payload.subscriptionId],
    );
    await expect(handoff.classify(context, envelope)).resolves.toEqual({
      disposition: 'eligible',
      reason: 'licensed_within_window',
    });
    await expect(
      handoff.classify(context, {
        ...envelope,
        clientRecordedAt: payload.offlineValidUntil,
      }),
    ).resolves.toEqual({ disposition: 'reject', reason: 'outside_license_window' });
    await expect(
      handoff.classify(context, { ...envelope, licenseId: randomUUID() }),
    ).resolves.toEqual({ disposition: 'reject', reason: 'invalid_license' });
  });

  it('serializes issuance after a winning Subscription cancellation', async () => {
    const storeId = fixtures.stores.subscriptionRace;
    const context = directContext(storeId, fixtures.devices.subscriptionRace);
    const adminClient = await adminPool.connect();
    try {
      await adminClient.query('begin');
      await setTenantContext(adminClient, storeId, fixtures.users.admin, randomUUID());
      await adminClient.query(
        `select * from ledger.manage_subscription_lifecycle(
           $1::uuid, 'cancel', $2::uuid, $3::text, $4::text
         )`,
        [storeId, randomUUID(), 'a'.repeat(64), 'S18.6 cancellation race'],
      );
      const pending = licenses.issue(principal(context), context, { operationId: randomUUID() });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await adminClient.query('commit');
      await expect(pending).rejects.toMatchObject({
        response: { code: 'OFFLINE_LICENSE_NOT_AVAILABLE' },
      });
    } finally {
      try {
        await adminClient.query('rollback');
      } catch {
        // Transaction already completed.
      }
      adminClient.release();
    }
  });

  it('serializes issuance after a winning Store suspension', async () => {
    const storeId = fixtures.stores.suspensionRace;
    const context = directContext(storeId, fixtures.devices.suspensionRace);
    const adminClient = await adminPool.connect();
    try {
      await adminClient.query('begin');
      await setTenantContext(adminClient, storeId, fixtures.users.admin, randomUUID());
      await adminClient.query(
        `select * from ledger.manage_store_lifecycle(
           $1::uuid, 'suspend', 1::bigint, $2::uuid, $3::text, $4::text
         )`,
        [storeId, randomUUID(), 'b'.repeat(64), 'S18.6 suspension race'],
      );
      const pending = licenses.issue(principal(context), context, { operationId: randomUUID() });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await adminClient.query('commit');
      await expect(pending).rejects.toMatchObject({
        response: { code: 'OFFLINE_LICENSE_NOT_AVAILABLE' },
      });
    } finally {
      try {
        await adminClient.query('rollback');
      } catch {
        // Transaction already completed.
      }
      adminClient.release();
    }
  });
});
