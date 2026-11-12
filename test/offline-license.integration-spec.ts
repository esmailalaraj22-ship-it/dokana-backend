import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PinoLogger } from 'nestjs-pino';
import type { Pool, PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import { AppModule } from '../src/app.module';
import { AuthenticationDatabaseService } from '../src/auth/auth-database.service';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { OfflineEntitlementHandoffService } from '../src/offline-licenses/offline-entitlement-handoff.service';
import { OfflineLicenseService } from '../src/offline-licenses/offline-license.service';
import { OfflineLicenseCryptoService } from '../src/offline-licenses/offline-license-crypto';
import { DatabaseService } from '../src/database/database.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { OfflineOperationService } from '../src/sync/offline-operation.service';
import { OfflineOperationRepository } from '../src/sync/offline-operation.repository';
import { OfflineOperationRegistry } from '../src/sync/offline-operation.registry';
import { CustomerWriteService } from '../src/customers/customer-write.service';
import { MoneyTransferWriteService } from '../src/money-transfers/money-transfer-write.service';
import { MoneyMovementPostingRepository } from '../src/money-movements/money-movement-posting.repository';
import { PlatformAdminService } from '../src/platform-authority/platform-admin.service';
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
  let orphanBaseline: { count: string; fingerprint: string | null } | undefined;
  let removedFixtureTokens = 0;
  const subscriptionIds = new Map<string, string>();

  async function orphanSnapshot() {
    const result = await adminPool.query<{ count: string; fingerprint: string | null }>(`
      select count(*)::text as count,
        md5(string_agg(to_jsonb(r)::text, ',' order by r.id)) as fingerprint
      from platform.refresh_tokens r
      where not exists (select 1 from platform.auth_sessions s where s.id = r.session_id)
    `);
    return result.rows[0];
  }

  function directContext(storeId: string, deviceId: string): TenantTransactionContext {
    return {
      storeId,
      userId: fixtures.users.owner,
      deviceId,
      requestId: randomUUID(),
      recoveryGenerationId: undefined,
    };
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
      recoveryGenerationId: context.recoveryGenerationId ?? '44a15e52-f6d1-41c7-b282-3c5576678dc1',
    };
  }

  async function login(
    email: string,
    storeId: string,
    deviceId = randomUUID(),
  ): Promise<{ token: string; deviceId: string; refreshToken: string }> {
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
    if (
      typeof body.accessToken !== 'string' ||
      typeof body.deviceId !== 'string' ||
      typeof body.refreshToken !== 'string'
    ) {
      throw new Error('Expected authentication token and device identity.');
    }
    return { token: body.accessToken, deviceId: body.deviceId, refreshToken: body.refreshToken };
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
    // This fixture connection suppresses triggers, including FK cascades. Remove
    // only tokens belonging to our still-identifiable sessions before those sessions.
    const removed = await fixturePool.query(
      `delete from platform.refresh_tokens where session_id in
         (select id from platform.auth_sessions where user_id = any($1::uuid[]))`,
      [fixtureUserIds],
    );
    removedFixtureTokens += removed.rowCount ?? 0;
    for (const table of [
      'sync.offline_operation_recovery_events_v1',
      'sync.offline_operation_provenance_v1',
      'sync.store_change_events_v1',
      'sync.store_change_watermarks_v1',
      'ledger.money_transfers',
      'ledger.money_movements',
      'ledger.money_accounts',
      'ledger.accounting_periods',
      'ledger.app_settings',
    ]) {
      await fixturePool.query(`delete from ${table} where store_id = any($1::uuid[])`, [
        fixtureStoreIds,
      ]);
    }
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
    await fixturePool.query(`delete from ledger.customers where store_id = any($1::uuid[])`, [
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
    orphanBaseline = await orphanSnapshot();
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
    try {
      if (poolsInitialized) {
        await removeFixtures();
        const after = await orphanSnapshot();
        expect(after).toEqual(orphanBaseline);
        console.info('Stage 3A fixture residue', {
          orphanBefore: orphanBaseline?.count,
          orphanAfter: after?.count,
          removedFixtureTokens,
          newOrphans: 0,
          preExistingOrphansUnchanged: true,
        });
      }
    } finally {
      if (app) await app.close();
      if (poolsInitialized)
        await Promise.all([adminPool.end(), fixturePool.end(), runtimePool.end()]);
    }
  });

  it.each(['issue', 'refresh'] as const)(
    'Stage 3A Auth %s preserves committed state when the release listener fails',
    async (path) => {
      if (!app || !environment) throw new Error('Approved application fixture is required.');
      const logger = await app.resolve(PinoLogger);
      const authPool = createTestPool(environment.authUrl, 'dokana-stage3a-auth-cleanup', 1);
      const auth = new AuthenticationDatabaseService(authPool, logger);
      const input = {
        userId: fixtures.users.owner,
        storeId: fixtures.stores.happy,
        deviceId: randomUUID(),
        deviceName: 'Stage 3A Auth cleanup',
        devicePlatform: 'android' as const,
        sessionId: randomUUID(),
        accessTokenJti: randomUUID(),
        refreshTokenId: randomUUID(),
        refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        refreshFamilyId: randomUUID(),
        sessionExpiresAt: new Date(Date.now() + 2 * 86_400_000),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
      };
      const rotation = {
        currentTokenHash: input.refreshTokenHash,
        newTokenId: randomUUID(),
        newTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        newAccessTokenJti: randomUUID(),
        refreshTtlSeconds: 3600,
      };
      let leased: PoolClient | undefined;
      let committed = false;
      let oldPid: number | undefined;
      let acquisition: jest.SpyInstance | undefined;
      let querySpy: jest.SpyInstance | undefined;
      try {
        if (path === 'refresh') {
          expect(await auth.issueSession(input)).toMatchObject({ sessionId: input.sessionId });
        }
        const connect = authPool.connect.bind(authPool);
        acquisition = jest.spyOn(authPool, 'connect').mockImplementationOnce(async () => {
          leased = await connect();
          leased.on('error', () => undefined);
          oldPid = (await leased.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
            ?.pid;
          const query = leased.query.bind(leased);
          querySpy = jest.spyOn(leased, 'query').mockImplementation((async (...args: unknown[]) => {
            const result = await (Reflect.apply(query, leased, args) as Promise<QueryResult>);
            if (args[0] === 'commit') {
              committed = true;
              authPool.once('release', () => {
                throw new Error('Stage 3A Auth post-COMMIT release failure');
              });
            }
            return result;
          }) as PoolClient['query']);
          return leased;
        });
        let response: unknown;
        let failure: unknown;
        try {
          response =
            path === 'issue'
              ? await auth.issueSession(input)
              : await auth.rotateRefreshToken(rotation, async (row) => {
                  expect(row.outcome).toBe('rotated');
                  return { sessionId: row.sessionId };
                });
        } catch (error) {
          failure = error;
        }
        acquisition.mockRestore();
        querySpy?.mockRestore();
        expect(committed).toBe(true);
        const sessions = await adminPool.query(
          `select id, access_token_jti, revoked_at from platform.auth_sessions
           where user_id=$1 and device_id=$2`,
          [input.userId, input.deviceId],
        );
        expect(sessions.rows).toEqual([
          {
            id: input.sessionId,
            access_token_jti: path === 'issue' ? input.accessTokenJti : rotation.newAccessTokenJti,
            revoked_at: null,
          },
        ]);
        const tokens = await adminPool.query(
          `select id, session_id, family_id, used_at is not null as used,
             revoked_at, replaced_by_id from platform.refresh_tokens
           where family_id=$1 order by issued_at, id`,
          [input.refreshFamilyId],
        );
        expect(tokens.rows).toHaveLength(path === 'issue' ? 1 : 2);
        expect(tokens.rows).toEqual(
          expect.arrayContaining([
            {
              id: input.refreshTokenId,
              session_id: input.sessionId,
              family_id: input.refreshFamilyId,
              used: path === 'refresh',
              revoked_at: null,
              replaced_by_id: path === 'refresh' ? rotation.newTokenId : null,
            },
          ]),
        );
        if (path === 'refresh')
          expect(tokens.rows).toEqual(
            expect.arrayContaining([
              {
                id: rotation.newTokenId,
                session_id: input.sessionId,
                family_id: input.refreshFamilyId,
                used: false,
                revoked_at: null,
                replaced_by_id: null,
              },
            ]),
          );
        expect(failure).toBeUndefined();
        expect(response).toMatchObject({ sessionId: input.sessionId });
        expect(authPool.totalCount).toBe(0);
        expect(authPool.waitingCount).toBe(0);
        const next = await authPool.connect();
        try {
          const state = await next.query<{ pid: number; store: string | null }>(
            "select pg_backend_pid() as pid, nullif(current_setting('app.store_id', true), '') as store",
          );
          expect(state.rows[0]?.pid).not.toBe(oldPid);
          expect(state.rows[0]?.store).toBeNull();
          await next.query('begin');
          await next.query('select 1');
          await next.query('commit');
        } finally {
          next.release();
        }
        expect(authPool.totalCount).toBe(1);
        expect(authPool.idleCount).toBe(1);
      } finally {
        acquisition?.mockRestore();
        querySpy?.mockRestore();
        if (leased) {
          try {
            leased.release(true);
          } catch {
            /* Already consumed release guard. */
          }
          leased.emit('error', new Error('Stage 3A Auth fixture cleanup'));
        }
        await authPool.end();
      }
    },
  );

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

  it.each(['verify', 'verificationKey'] as const)(
    'Stage 3A rolls back issuance when response %s fails',
    async (boundary) => {
      if (!app) throw new Error('Application is not initialized.');
      const session = await login('s18-6-owner@example.test', fixtures.stores.happy);
      const operationId = randomUUID();
      const crypto = app.get(OfflineLicenseCryptoService);
      const failure = jest.spyOn(crypto, boundary).mockImplementationOnce(() => {
        throw new Error('Stage 3A injected response preparation failure');
      });
      try {
        const response = await request(server)
          .post('/v1/licenses/verify')
          .set('Authorization', `Bearer ${session.token}`)
          .send({ operationId })
          .expect(500);
        expect(JSON.stringify(response.body)).not.toContain('injected');
        expect(
          (
            await adminPool.query(
              'select id from platform.license_issuances where store_id=$1 and device_id=$2',
              [fixtures.stores.happy, session.deviceId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await adminPool.query(
              'select operation_id from sync.processed_operations where store_id=$1 and operation_id=$2',
              [fixtures.stores.happy, operationId],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        failure.mockRestore();
      }
    },
  );

  it.each(['push', 'recover'] as const)(
    'Stage 3A C03 preserves %s completion failure and rolls back every associated effect',
    async (path) => {
      if (!app) throw new Error('Application is not initialized.');
      const session = await login('s18-6-owner@example.test', fixtures.stores.happy);
      const context = directContext(fixtures.stores.happy, session.deviceId);
      const database = app.get(DatabaseService);
      const authority = await database.withTenantTransaction(context, (tx) =>
        database.capturePlatformRecoveryAuthority(tx),
      );
      context.recoveryGenerationId = authority.recoveryGenerationId;
      const actor = principal(context);
      const license = await licenses.issue(actor, context, { operationId: randomUUID() });
      const payload = license.license.payload;
      const operationId = randomUUID();
      const customerId = randomUUID();
      const recordedAt = new Date().toISOString();
      const operation = {
        protocolVersion: 1,
        operationId,
        operationType: 'customers.create.v1',
        storeId: context.storeId,
        deviceId: context.deviceId,
        recoveryGenerationId: context.recoveryGenerationId,
        aggregateId: customerId,
        payload: {
          name: `Stage 3A offline atomicity ${path}`,
          phone: path === 'push' ? '0599000077' : '0599000078',
        },
        clientRecordedAt: recordedAt,
        offlineLicenseId: payload.licenseId,
        signedLicense: license.license,
        signingKeyId: payload.signingKeyId,
        subscriptionId: payload.subscriptionId,
        subscriptionVersion: payload.subscriptionVersion,
        trustedTimeEvidence: {
          version: 1,
          trustedServerTime: new Date(payload.issuedAt).toISOString(),
          observedDeviceTime: recordedAt,
          clockState: path === 'recover' ? 'clock_rollback_suspected' : 'trusted',
          knownStoreStatus: 'active',
          knownStoreStatusAt: new Date(payload.issuedAt).toISOString(),
        },
        localSequence: '1',
        dependsOnOperationIds: [],
      };
      const offline = app.get(OfflineOperationService);
      if (path === 'recover') {
        expect(
          (await offline.push({ operations: [operation] }, actor, context)).results[0]?.status,
        ).toBe('QUARANTINED');
      }
      const snapshot = async () => {
        const tables = [
          'ledger.customers',
          'sync.processed_operations',
          'sync.offline_operation_provenance_v1',
          'sync.offline_operation_recovery_events_v1',
          'audit.central_audit_logs',
          'sync.change_events',
          'sync.store_change_events_v1',
        ];
        const counts: Record<string, number> = {};
        for (const table of tables) {
          counts[table] =
            (
              await adminPool.query<{ count: number }>(
                `select count(*)::integer as count from ${table} where store_id=$1`,
                [context.storeId],
              )
            ).rows[0]?.count ?? -1;
        }
        const provenance = (
          await adminPool.query(
            'select to_jsonb(p) as value from sync.offline_operation_provenance_v1 p where store_id=$1 and operation_id=$2',
            [context.storeId, operationId],
          )
        ).rows;
        return { counts, provenance };
      };
      const before = await snapshot();
      const repository = app.get(OfflineOperationRepository);
      const registry = app.get(OfflineOperationRegistry);
      const dispatch = jest.spyOn(registry, 'dispatch');
      const method = path === 'push' ? 'finish' : 'finishRecovery';
      const primary = new Error('Stage 3A completion failed after successful dispatch');
      const completion = jest
        .spyOn(repository, method)
        .mockImplementationOnce(
          async (
            ...args:
              | Parameters<OfflineOperationRepository['finish']>
              | Parameters<OfflineOperationRepository['finishRecovery']>
          ) => {
            const [tx] = args;
            // Assert actual domain effects exist on the same transaction before failure.
            const { sql } = await import('drizzle-orm');
            const rows = await tx.execute(
              sql`select id from ledger.customers where id=${customerId}::uuid`,
            );
            expect(rows.rowCount).toBe(1);
            throw primary;
          },
        );
      let surfaced: unknown;
      let outerResult: unknown;
      try {
        try {
          if (path === 'push')
            outerResult = await offline.push({ operations: [operation] }, actor, context);
          else outerResult = await offline.recover(operationId, { operation }, actor, context);
        } catch (error) {
          surfaced = error;
        }
        expect({
          dispatches: dispatch.mock.calls.length,
          sqlstate: postgresErrorCode(surfaced),
          result: outerResult,
        }).toEqual({ dispatches: 1, sqlstate: undefined, result: undefined });
        expect(completion).toHaveBeenCalledTimes(1);
        expect(await snapshot()).toEqual(before);
        const pool = app.get<Pool>(DATABASE_POOL);
        expect(pool.totalCount - pool.idleCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
        expect(
          (await pool.query("select nullif(current_setting('app.store_id', true), '') as store"))
            .rows,
        ).toEqual([{ store: null }]);
        expect({
          originalPreserved: surfaced === primary,
          sqlstate: postgresErrorCode(surfaced),
        }).toEqual({ originalPreserved: true, sqlstate: undefined });
      } finally {
        dispatch.mockRestore();
        completion.mockRestore();
      }
      const success =
        path === 'push'
          ? (await offline.push({ operations: [operation] }, actor, context)).results[0]
          : await offline.recover(operationId, { operation }, actor, context);
      expect(success?.status).toBe('APPLIED');
      const after = await snapshot();
      expect(after.counts['ledger.customers']).toBe((before.counts['ledger.customers'] ?? -1) + 1);
      expect(after.counts['sync.processed_operations']).toBe(
        (before.counts['sync.processed_operations'] ?? -1) + 1,
      );
      expect(after.counts['audit.central_audit_logs']).toBeGreaterThan(
        before.counts['audit.central_audit_logs'] ?? -1,
      );
      expect(after.counts['sync.store_change_events_v1']).toBe(
        (before.counts['sync.store_change_events_v1'] ?? -1) + 1,
      );
      expect((await offline.status(operationId, undefined, context)).status).toBe('APPLIED');
    },
  );

  it('Stage 3A C06 preserves an earlier envelope commit when the later envelope fails', async () => {
    if (!app) throw new Error('Application is not initialized.');
    const session = await login('s18-6-owner@example.test', fixtures.stores.happy);
    const syncResponse = bodyOf(
      await request(server)
        .post('/v1/sync/auth/token')
        .send({ refreshToken: session.refreshToken })
        .expect(200),
    );
    if (
      typeof syncResponse.syncToken !== 'string' ||
      typeof syncResponse.recoveryGenerationId !== 'string'
    )
      throw new Error('Sync authentication fixture unavailable.');
    const context = {
      ...directContext(fixtures.stores.happy, session.deviceId),
      recoveryGenerationId: syncResponse.recoveryGenerationId,
    };
    const license = await licenses.issue(principal(context), context, {
      operationId: randomUUID(),
    });
    const payload = license.license.payload;
    const recordedAt = new Date().toISOString();
    const operations = [1, 2].map((sequence) => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      operationType: 'customers.create.v1',
      storeId: context.storeId,
      deviceId: context.deviceId,
      recoveryGenerationId: context.recoveryGenerationId,
      aggregateId: randomUUID(),
      payload: { name: `C06 envelope ${String(sequence)}`, phone: `059900008${String(sequence)}` },
      clientRecordedAt: recordedAt,
      offlineLicenseId: payload.licenseId,
      signedLicense: license.license,
      signingKeyId: payload.signingKeyId,
      subscriptionId: payload.subscriptionId,
      subscriptionVersion: payload.subscriptionVersion,
      trustedTimeEvidence: {
        version: 1,
        trustedServerTime: new Date(payload.issuedAt).toISOString(),
        observedDeviceTime: recordedAt,
        clockState: 'trusted',
        knownStoreStatus: 'active',
        knownStoreStatusAt: new Date(payload.issuedAt).toISOString(),
      },
      localSequence: String(sequence),
      dependsOnOperationIds: [],
    }));
    const first = operations[0];
    const second = operations[1];
    if (!first || !second) throw new Error('Batch fixture unavailable.');
    const repository = app.get(OfflineOperationRepository);
    const finish = repository.finish.bind(repository);
    const completion = jest.spyOn(repository, 'finish').mockImplementation(async (...args) => {
      if (args[2] === second.operationId) throw new Error('C06 later envelope completion failed');
      return finish(...args);
    });
    try {
      const response = await request(server)
        .post('/v1/sync/push')
        .set('authorization', `Bearer ${syncResponse.syncToken}`)
        .send({ operations })
        .expect(500);
      expect(bodyOf(response)).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      });
      for (const [item, expected] of [
        [first, 1],
        [second, 0],
      ] as const) {
        expect(
          (
            await adminPool.query('select id from ledger.customers where store_id=$1 and id=$2', [
              context.storeId,
              item.aggregateId,
            ])
          ).rowCount,
        ).toBe(expected);
        expect(
          (
            await adminPool.query(
              "select operation_id from sync.processed_operations where store_id=$1 and operation_id=$2 and status='applied'",
              [context.storeId, item.operationId],
            )
          ).rowCount,
        ).toBe(expected);
        expect(
          (
            await adminPool.query(
              "select operation_id from sync.offline_operation_provenance_v1 where store_id=$1 and operation_id=$2 and disposition='applied'",
              [context.storeId, item.operationId],
            )
          ).rowCount,
        ).toBe(expected);
        expect(
          (
            await adminPool.query(
              'select operation_id from sync.store_change_events_v1 where store_id=$1 and operation_id=$2',
              [context.storeId, item.operationId],
            )
          ).rowCount,
        ).toBe(expected);
      }
      expect(completion).toHaveBeenCalledTimes(2);
      const pool = app.get<Pool>(DATABASE_POOL);
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    } finally {
      completion.mockRestore();
    }
    // One bounded replay observes the existing commit boundary. Protocol and
    // canonical replay correctness remain Stage 3B/Stage 5 work.
    const replay = bodyOf(
      await request(server)
        .post('/v1/sync/push')
        .set('authorization', `Bearer ${syncResponse.syncToken}`)
        .send({ operations })
        .expect(200),
    );
    expect(replay.results).toEqual([
      expect.objectContaining({ operationId: first.operationId, status: 'EXACT_REPLAY' }),
      expect.objectContaining({ operationId: second.operationId, status: 'APPLIED' }),
    ]);
    for (const item of operations) {
      expect(
        (
          await adminPool.query('select id from ledger.customers where store_id=$1 and id=$2', [
            context.storeId,
            item.aggregateId,
          ])
        ).rowCount,
      ).toBe(1);
    }
  });

  async function stage3aWriteContext(admin = false): Promise<TenantTransactionContext> {
    if (!app) throw new Error('Application is not initialized.');
    const session = await login(
      admin ? 's18-6-admin@example.test' : 's18-6-owner@example.test',
      admin ? fixtures.stores.auth : fixtures.stores.happy,
    );
    const context = {
      ...directContext(
        admin ? fixtures.stores.adminTarget : fixtures.stores.happy,
        session.deviceId,
      ),
      userId: admin ? fixtures.users.admin : fixtures.users.owner,
    };
    const database = app.get(DatabaseService);
    context.recoveryGenerationId = (
      await database.withTenantTransaction(context, (tx) =>
        database.capturePlatformRecoveryAuthority(tx),
      )
    ).recoveryGenerationId;
    return context;
  }

  async function stage3aEffectCounts(storeId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of [
      'ledger.customers',
      'ledger.money_movements',
      'ledger.money_transfers',
      'ledger.accounting_periods',
      'sync.processed_operations',
      'audit.central_audit_logs',
      'sync.change_events',
      'sync.store_change_events_v1',
      'platform.admin_actions',
    ]) {
      counts[table] =
        (
          await adminPool.query<{ count: number }>(
            `select count(*)::integer as count from ${table} where store_id=$1`,
            [storeId],
          )
        ).rows[0]?.count ?? -1;
    }
    return counts;
  }

  it.each(['customer', 'platform-admin'] as const)(
    'Stage 3A atomicity rolls back completed %s work before COMMIT',
    async (kind) => {
      if (!app) throw new Error('Application is not initialized.');
      const context = await stage3aWriteContext(kind === 'platform-admin');
      const before = await stage3aEffectCounts(context.storeId);
      const storeBefore = (
        await adminPool.query<{ status: string; version: string }>(
          'select status, version::text from ledger.stores where id=$1',
          [context.storeId],
        )
      ).rows;
      const database = app.get(DatabaseService);
      const original = database.withTenantTransaction.bind(database);
      const failure = new Error('Stage 3A injected failure before COMMIT');
      const operationId = randomUUID();
      const customerId = randomUUID();
      let reached = false;
      const boundary = jest
        .spyOn(database, 'withTenantTransaction')
        .mockImplementation((scope, work) =>
          original(scope, async (tx) => {
            await work(tx);
            reached = true;
            if (kind === 'customer') {
              expect(
                (
                  await tx.execute(
                    sql`select id from ledger.customers where id=${customerId}::uuid`,
                  )
                ).rowCount,
              ).toBe(1);
              expect(
                (
                  await tx.execute(
                    sql`select operation_id from sync.processed_operations where operation_id=${operationId}::uuid and status='applied'`,
                  )
                ).rowCount,
              ).toBe(1);
            } else {
              expect(
                (
                  await tx.execute(
                    sql`select status from ledger.stores where id=${context.storeId}::uuid`,
                  )
                ).rows[0]?.status,
              ).toBe('suspended');
            }
            throw failure;
          }),
        );
      try {
        const pending =
          kind === 'customer'
            ? app.get(CustomerWriteService).create(principal(context), context, {
                id: customerId,
                operationId,
                name: 'Stage 3A ordinary rollback',
                phone: '0599000091',
              })
            : app
                .get(PlatformAdminService)
                .mutateStoreLifecycle(context, context.storeId, 'suspend', {
                  operationId,
                  expectedVersion: String(storeBefore[0]?.version),
                  reason: 'Stage 3A rollback proof',
                });
        await expect(pending).rejects.toBe(failure);
        expect(reached).toBe(true);
        expect(await stage3aEffectCounts(context.storeId)).toEqual(before);
        expect(
          (
            await adminPool.query('select status, version::text from ledger.stores where id=$1', [
              context.storeId,
            ])
          ).rows,
        ).toEqual(storeBefore);
      } finally {
        boundary.mockRestore();
      }
    },
  );

  it.each(['domain', 'infrastructure'] as const)(
    'Stage 3A atomicity distinguishes Money Transfer %s rejection',
    async (kind) => {
      if (!app) throw new Error('Application is not initialized.');
      const context = await stage3aWriteContext();
      await fixturePool.query(
        'insert into ledger.app_settings(store_id) values($1) on conflict do nothing',
        [context.storeId],
      );
      const source = randomUUID();
      const destination = randomUUID();
      for (const id of [source, destination])
        await fixturePool.query(
          `insert into ledger.money_accounts(id, store_id, name, normalized_name, account_type, availability, status, operation_id)
      values($1,$2,$3,$3,'transfer','available','active',$4)`,
          [id, context.storeId, `C3A ${id}`, randomUUID()],
        );
      const before = await stage3aEffectCounts(context.storeId);
      const balancesBefore = (
        await adminPool.query(
          'select account_id, balance_minor::text from ledger.v_money_account_balances where store_id=$1 order by account_id',
          [context.storeId],
        )
      ).rows;
      const operationId = randomUUID();
      const movements = app.get(MoneyMovementPostingRepository);
      const insert = movements.insertMovementWithinTransaction.bind(movements);
      const failure = new Error('Stage 3A second movement infrastructure failure');
      let stagedSource = false;
      const injection = jest
        .spyOn(movements, 'insertMovementWithinTransaction')
        .mockImplementation(async (...args) => {
          if (kind === 'infrastructure' && args[2].discriminator === 'transfer-destination')
            throw failure;
          const result = await insert(...args);
          stagedSource = true;
          return result;
        });
      try {
        const pending = app.get(MoneyTransferWriteService).create(principal(context), context, {
          operationId,
          sourceAccountId: source,
          destinationAccountId: kind === 'domain' ? source : destination,
          amountMinor: '100',
          occurredAt: new Date().toISOString(),
        });
        if (kind === 'domain')
          await expect(pending).rejects.toMatchObject({
            response: { code: 'MONEY_TRANSFER_SAME_ACCOUNT' },
          });
        else {
          await expect(pending).rejects.toBe(failure);
          expect(stagedSource).toBe(true);
        }
        const after = await stage3aEffectCounts(context.storeId);
        expect(after).toEqual({
          ...before,
          'sync.processed_operations':
            (before['sync.processed_operations'] ?? -1) + (kind === 'domain' ? 1 : 0),
        });
        expect(
          (
            await adminPool.query(
              'select status from sync.processed_operations where store_id=$1 and operation_id=$2',
              [context.storeId, operationId],
            )
          ).rows,
        ).toEqual(kind === 'domain' ? [{ status: 'rejected' }] : []);
        expect(
          (
            await adminPool.query(
              'select account_id, balance_minor::text from ledger.v_money_account_balances where store_id=$1 order by account_id',
              [context.storeId],
            )
          ).rows,
        ).toEqual(balancesBefore);
      } finally {
        injection.mockRestore();
      }
    },
  );

  it('Stage 3A atomicity rolls back business, operation and audit when mandatory change publication fails', async () => {
    if (!app) throw new Error('Application is not initialized.');
    const context = await stage3aWriteContext();
    const customers = app.get(CustomerWriteService);
    await customers.create(principal(context), context, {
      id: randomUUID(),
      operationId: randomUUID(),
      name: 'Stage 3A watermark seed',
      phone: '0599000092',
    });
    const before = await stage3aEffectCounts(context.storeId);
    const blocker = await adminPool.connect();
    const database = app.get(DatabaseService);
    const original = database.withTenantTransaction.bind(database);
    let completedBody = false;
    const boundary = jest
      .spyOn(database, 'withTenantTransaction')
      .mockImplementation((scope, work) =>
        original(scope, async (tx) => {
          await tx.execute(sql`set local lock_timeout='30ms'`);
          const result = await work(tx);
          completedBody = true;
          await tx.execute(sql`set constraints all immediate`);
          return result;
        }),
      );
    try {
      await blocker.query('begin');
      expect(
        (
          await blocker.query(
            'select store_id from sync.store_change_watermarks_v1 where store_id=$1 for update',
            [context.storeId],
          )
        ).rowCount,
      ).toBe(1);
      const pending = customers.create(principal(context), context, {
        id: randomUUID(),
        operationId: randomUUID(),
        name: 'Stage 3A change failure',
        phone: '0599000093',
      });
      await expect(pending).rejects.toMatchObject({ cause: { code: '55P03' } });
      expect(completedBody).toBe(true);
      expect(await stage3aEffectCounts(context.storeId)).toEqual(before);
    } finally {
      boundary.mockRestore();
      await blocker.query('rollback');
      blocker.release();
    }
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
