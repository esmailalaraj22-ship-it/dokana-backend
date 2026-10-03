import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import { Test } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';

import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { SystemCashProvisioningService } from '../src/money-accounts/system-cash-provisioning.service';
import { PlatformAuthorityService } from '../src/platform-authority/platform-authority.service';
import { StoreProvisioningService } from '../src/platform-authority/store-provisioning.service';
import { SubscriptionLifecycleRepository } from '../src/platform-authority/subscription-lifecycle.repository';
import { SubscriptionLifecycleService } from '../src/platform-authority/subscription-lifecycle.service';
import type {
  PlatformProvisioningActorContext,
  StoreProvisioningCommand,
} from '../src/platform-authority/subscription-lifecycle.types';
import { MVP_TIMEZONE_NAME } from '../src/settings/app-settings.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(120_000);

const fixtures = {
  stores: {
    state: '18400000-0000-4000-8000-000000000001',
    activate: '18400000-0000-4000-8000-000000000002',
    boundary: '18400000-0000-4000-8000-000000000003',
    lifecycle: '18400000-0000-4000-8000-000000000004',
    expired: '18400000-0000-4000-8000-000000000005',
    readOnly: '18400000-0000-4000-8000-000000000006',
    suspended: '18400000-0000-4000-8000-000000000007',
    archived: '18400000-0000-4000-8000-000000000008',
    extendRace: '18400000-0000-4000-8000-000000000009',
    cancelRace: '18400000-0000-4000-8000-000000000010',
    reactivateRace: '18400000-0000-4000-8000-000000000011',
  },
  users: {
    admin: '18410000-0000-4000-8000-000000000001',
    ownerA: '18410000-0000-4000-8000-000000000002',
    ownerB: '18410000-0000-4000-8000-000000000003',
    ordinary: '18410000-0000-4000-8000-000000000004',
    inactiveOwner: '18410000-0000-4000-8000-000000000005',
  },
  plan: '18420000-0000-4000-8000-000000000001',
  extraPlan: '18420000-0000-4000-8000-000000000002',
  provisioningOperations: {
    withoutSubscription: '18430000-0000-4000-8000-000000000001',
    withSubscription: '18430000-0000-4000-8000-000000000002',
    concurrent: '18430000-0000-4000-8000-000000000003',
    inactiveOwner: '18430000-0000-4000-8000-000000000004',
    invalidSettings: '18430000-0000-4000-8000-000000000005',
    cashFailure: '18430000-0000-4000-8000-000000000006',
    subscriptionFailure: '18430000-0000-4000-8000-000000000007',
  },
} as const;

const storeIdNamespace = '330f8db6-2a17-5f42-9bc5-8e8879df0f46';

function deriveProvisionedStoreId(operationId: string): string {
  const namespaceBytes = Buffer.from(storeIdNamespace.replaceAll('-', ''), 'hex');
  const operationBytes = Buffer.from(operationId.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1')
    .update(namespaceBytes)
    .update(operationBytes)
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

const provisionedStoreIds = Object.values(fixtures.provisioningOperations).map(
  deriveProvisionedStoreId,
);
const storeIds = [...Object.values(fixtures.stores), ...provisionedStoreIds];
const userIds = Object.values(fixtures.users);

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

const settings = {
  dailyReportTimeMinutes: 1200,
  defaultCreditPolicy: 'warn',
  defaultCreditLimitMinor: null,
  allowNegativeStock: false,
  lowStockAlertEnabled: true,
  debtAgeAlertDays: 30,
  backupEnabled: true,
  backupIntervalHours: 24,
  timezoneName: MVP_TIMEZONE_NAME,
  businessDayMode: 'fixed_24h',
} as const;

describe('S18.4 Subscription lifecycle and Store provisioning with real PostgreSQL', () => {
  let adminPool: Pool;
  let fixturePool: Pool;
  let runtimePool: Pool;
  let app: INestApplication | undefined;
  let database: DatabaseService;
  let lifecycle: SubscriptionLifecycleService;
  let provisioning: StoreProvisioningService;
  let repository: SubscriptionLifecycleRepository;
  let platformAuthority: PlatformAuthorityService;
  let systemCash: SystemCashProvisioningService;
  let activePlanId: string;
  let planDurationDays: number;
  let ownsFixturePlan = false;
  let poolsInitialized = false;

  function context(storeId: string, userId: string = fixtures.users.admin) {
    return {
      storeId,
      userId,
      deviceId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  function provisioningActor(): PlatformProvisioningActorContext {
    return {
      userId: fixtures.users.admin,
      deviceId: randomUUID(),
      requestId: randomUUID(),
    };
  }

  function provisioningCommand(
    operationId: string,
    overrides: Partial<StoreProvisioningCommand> = {},
  ): StoreProvisioningCommand {
    return {
      operationId,
      ownerUserId: fixtures.users.ownerA,
      name: `S18.4 Provisioned ${operationId.slice(-4)}`,
      phone: null,
      reason: 'S18.4 verified Store provisioning',
      activateSubscription: false,
      settings,
      ...overrides,
    };
  }

  async function setTenantContext(
    client: PoolClient,
    storeId: string,
    userId: string,
  ): Promise<void> {
    await client.query(`select set_config('app.store_id', $1, true)`, [storeId]);
    await client.query(`select set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`select set_config('app.device_id', $1, true)`, [randomUUID()]);
    await client.query(`select set_config('app.request_id', $1, true)`, [randomUUID()]);
  }

  async function insertSubscription(
    storeId: string,
    status: 'active' | 'expired' | 'cancelled',
    startsAt: Date,
    endsAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await fixturePool.query(
      `insert into platform.subscriptions (
         id, store_id, plan_id, status, starts_at, expires_at
       ) values ($1, $2, $3, $4, $5, $6)`,
      [id, storeId, activePlanId, status, startsAt, endsAt],
    );
    return id;
  }

  async function countStoreFoundation(storeId: string): Promise<{
    stores: number;
    memberships: number;
    settings: number;
    cash: number;
    subscriptions: number;
    actions: number;
  }> {
    const result = await adminPool.query<{
      stores: number;
      memberships: number;
      settings: number;
      cash: number;
      subscriptions: number;
      actions: number;
    }>(
      `select
         (select count(*)::integer from ledger.stores where id = $1) as stores,
         (select count(*)::integer from platform.store_memberships where store_id = $1)
           as memberships,
         (select count(*)::integer from ledger.app_settings where store_id = $1) as settings,
         (select count(*)::integer from ledger.money_accounts
          where store_id = $1 and account_type = 'cash') as cash,
         (select count(*)::integer from platform.subscriptions where store_id = $1)
           as subscriptions,
         (select count(*)::integer from platform.admin_actions where store_id = $1) as actions`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected Store-foundation counts.');
    return row;
  }

  async function removeFixtures(): Promise<void> {
    await fixturePool.query(
      `delete from platform.license_issuances where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from platform.admin_actions where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from platform.subscriptions where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from sync.conflicts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from audit.central_audit_logs where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from ledger.money_accounts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from platform.store_memberships where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from platform.platform_admin_assignments where user_id = $1`, [
      fixtures.users.admin,
    ]);
    await fixturePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await fixturePool.query(`delete from platform.subscription_plans where id = $1`, [
      fixtures.extraPlan,
    ]);
    if (ownsFixturePlan) {
      await fixturePool.query(`delete from platform.subscription_plans where id = $1`, [
        fixtures.plan,
      ]);
    }
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL verification environment is unavailable.');
    }

    adminPool = createTestPool(environment.adminUrl, 'dokana-s18-4-admin', 4);
    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s18-4-fixture',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s18-4-runtime', 3);
    poolsInitialized = true;

    await removeFixtures();

    const activePlans = await adminPool.query<{ id: string; durationDays: number }>(
      `select id, duration_days as "durationDays"
       from platform.subscription_plans
       where status = 'active'
       order by id`,
    );
    if (activePlans.rowCount === 0) {
      await fixturePool.query(
        `insert into platform.subscription_plans (
           id, code, name, duration_days, price_minor, offline_grace_days, status
         ) values ($1, 'dokana-s18-4-mvp', 'Dokana S18.4 MVP', 30, 0, 0, 'active')`,
        [fixtures.plan],
      );
      activePlanId = fixtures.plan;
      planDurationDays = 30;
      ownsFixturePlan = true;
    } else if (activePlans.rowCount === 1 && activePlans.rows[0]) {
      activePlanId = activePlans.rows[0].id;
      planDurationDays = activePlans.rows[0].durationDays;
    } else {
      throw new Error('S18.4 requires exactly one active MVP Subscription plan.');
    }

    await fixturePool.query(
      `insert into ledger.stores (id, name, status) values
       ($1, 'S18.4 State', 'active'),
       ($2, 'S18.4 Activate', 'active'),
       ($3, 'S18.4 Boundary', 'active'),
       ($4, 'S18.4 Lifecycle', 'active'),
       ($5, 'S18.4 Expired', 'active'),
       ($6, 'S18.4 Read Only', 'read_only'),
       ($7, 'S18.4 Suspended', 'suspended'),
       ($8, 'S18.4 Archived', 'archived'),
       ($9, 'S18.4 Extend Race', 'active'),
       ($10, 'S18.4 Cancel Race', 'active'),
       ($11, 'S18.4 Reactivate Race', 'active')`,
      Object.values(fixtures.stores),
    );
    await fixturePool.query(
      `insert into platform.users (
         id, email, normalized_email, password_hash, full_name, status
       ) values
       ($1, 's18-4-admin@example.test', 's18-4-admin@example.test', 'not-used',
        'S18.4 Platform Admin', 'active'),
       ($2, 's18-4-owner-a@example.test', 's18-4-owner-a@example.test', 'not-used',
        'S18.4 Owner A', 'active'),
       ($3, 's18-4-owner-b@example.test', 's18-4-owner-b@example.test', 'not-used',
        'S18.4 Owner B', 'active'),
       ($4, 's18-4-ordinary@example.test', 's18-4-ordinary@example.test', 'not-used',
        'S18.4 Ordinary', 'active'),
       ($5, 's18-4-inactive@example.test', 's18-4-inactive@example.test', 'not-used',
        'S18.4 Inactive Owner', 'disabled')`,
      userIds,
    );
    await fixturePool.query(
      `insert into platform.platform_admin_assignments (user_id, status)
       values ($1, 'active')`,
      [fixtures.users.admin],
    );
    await fixturePool.query(
      `insert into platform.store_memberships (
         id, store_id, user_id, role, status, created_at, updated_at
       ) values
       ($1, $2, $3, 'owner', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
       ($4, $2, $5, 'owner', 'active', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
      [
        randomUUID(),
        fixtures.stores.state,
        fixtures.users.ownerA,
        randomUUID(),
        fixtures.users.ownerB,
      ],
    );

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) =>
          createLoggingParams(config, { write: () => undefined }),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = moduleRef.createNestApplication();
    nestApp.useLogger(nestApp.get(Logger));
    await nestApp.init();
    app = nestApp;
    database = nestApp.get(DatabaseService);
    lifecycle = nestApp.get(SubscriptionLifecycleService);
    provisioning = nestApp.get(StoreProvisioningService);
    repository = nestApp.get(SubscriptionLifecycleRepository);
    platformAuthority = nestApp.get(PlatformAuthorityService);
    systemCash = nestApp.get(SystemCashProvisioningService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) return;

    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `select (
         (select count(*) from ledger.stores where id = any($1::uuid[]))
         + (select count(*) from platform.users where id = any($2::uuid[]))
         + (select count(*) from platform.store_memberships where store_id = any($1::uuid[]))
         + (select count(*) from platform.subscriptions where store_id = any($1::uuid[]))
         + (select count(*) from platform.admin_actions where store_id = any($1::uuid[]))
         + (select count(*) from ledger.app_settings where store_id = any($1::uuid[]))
         + (select count(*) from ledger.money_accounts where store_id = any($1::uuid[]))
         + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
         + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
       )::integer as count`,
      [storeIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([fixturePool.end(), runtimePool.end(), adminPool.end()]);
  }, 30_000);

  it('keeps the five S18.4 functions narrow and executes corrected deterministic Owner selection', async () => {
    const security = await adminPool.query<{
      signature: string;
      owner: string;
      securityDefiner: boolean;
      configuration: string[];
      publicExecute: boolean;
      runtimeExecute: boolean;
      authExecute: boolean;
      authOwnerExecute: boolean;
    }>(`
      select
        routine.oid::regprocedure::text as signature,
        pg_get_userbyid(routine.proowner) as owner,
        routine.prosecdef as "securityDefiner",
        routine.proconfig as configuration,
        exists (
          select 1
          from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        has_function_privilege('shop_app_runtime', routine.oid, 'EXECUTE') as "runtimeExecute",
        has_function_privilege('shop_app_auth', routine.oid, 'EXECUTE') as "authExecute",
        has_function_privilege('shop_app_auth_owner', routine.oid, 'EXECUTE')
          as "authOwnerExecute"
      from pg_proc routine
      where routine.oid in (
        'ledger.manage_subscription_lifecycle(uuid,text,uuid,text,text)'::regprocedure,
        'ledger.provision_store_identity(uuid,uuid,text,text,uuid,text,text,boolean)'::regprocedure,
        'ledger.read_subscription_lifecycle(uuid)'::regprocedure,
        'ledger.read_subscription_history(uuid)'::regprocedure,
        'ledger.read_store_provisioning_state(uuid)'::regprocedure
      )
      order by signature
    `);
    expect(security.rows).toHaveLength(5);
    for (const row of security.rows) {
      expect(row).toMatchObject({
        owner: 'shop_app_migrator',
        securityDefiner: true,
        configuration: ['search_path=pg_catalog, pg_temp'],
        publicExecute: false,
        runtimeExecute: true,
        authExecute: false,
        authOwnerExecute: false,
      });
    }

    const privileges = await adminPool.query<{
      platformUsage: boolean;
      subscriptionSelect: boolean;
      subscriptionInsert: boolean;
      membershipInsert: boolean;
      actionInsert: boolean;
    }>(`
      select
        has_schema_privilege('shop_app_runtime', 'platform', 'USAGE') as "platformUsage",
        has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'SELECT')
          as "subscriptionSelect",
        has_table_privilege('shop_app_runtime', 'platform.subscriptions', 'INSERT')
          as "subscriptionInsert",
        has_table_privilege('shop_app_runtime', 'platform.store_memberships', 'INSERT')
          as "membershipInsert",
        has_table_privilege('shop_app_runtime', 'platform.admin_actions', 'INSERT')
          as "actionInsert"
    `);
    expect(privileges.rows[0]).toEqual({
      platformUsage: false,
      subscriptionSelect: false,
      subscriptionInsert: false,
      membershipInsert: false,
      actionInsert: false,
    });

    const state = await database.withTenantTransaction(
      context(fixtures.stores.state),
      (transaction) => repository.readProvisioningState(transaction, fixtures.stores.state),
    );
    expect(state).toMatchObject({
      storeId: fixtures.stores.state,
      ownerCount: 2n,
      ownerUserId: fixtures.users.ownerA,
      settingsCount: 0n,
      systemCashCount: 0n,
      subscriptionCount: 0n,
    });
  });

  it('fails closed for ordinary actors, cross-Store calls, and direct platform-table access', async () => {
    await expectPostgresError(
      lifecycle.activate(context(fixtures.stores.activate, fixtures.users.ordinary), {
        operationId: randomUUID(),
        reason: 'Unauthorized activation',
      }),
      '42501',
    );

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setTenantContext(client, fixtures.stores.state, fixtures.users.admin);
      await expectPostgresError(
        client.query(`select * from ledger.read_store_provisioning_state($1)`, [
          fixtures.stores.activate,
        ]),
        '42501',
      );
      await client.query('rollback');
    } finally {
      client.release();
    }

    await expectPostgresError(
      runtimePool.query(`select * from platform.subscriptions limit 1`),
      '42501',
    );
  });

  it('activates from server time, replays exactly, rejects conflicting reuse, and records history', async () => {
    const operationId = randomUUID();
    const before = await adminPool.query<{ now: Date }>(`select clock_timestamp() as now`);
    const first = await lifecycle.activate(context(fixtures.stores.activate), {
      operationId,
      reason: 'Initial commercial activation',
    });
    const after = await adminPool.query<{ now: Date }>(`select clock_timestamp() as now`);

    expect(first).toMatchObject({
      planId: activePlanId,
      status: 'active',
      action: 'activate',
      version: 1n,
      replayed: false,
    });
    expect(first.startsAt.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]?.now.getTime() ?? Infinity,
    );
    expect(first.startsAt.getTime()).toBeLessThanOrEqual(after.rows[0]?.now.getTime() ?? -Infinity);
    const expectedEnd = await adminPool.query<{ endsAt: Date }>(
      `select $1::timestamptz + make_interval(days => $2::integer) as "endsAt"`,
      [first.startsAt, planDurationDays],
    );
    expect(first.endsAt).toEqual(expectedEnd.rows[0]?.endsAt);

    const replay = await lifecycle.activate(context(fixtures.stores.activate), {
      operationId,
      reason: 'Initial commercial activation',
    });
    expect(replay).toEqual({ ...first, replayed: true });
    await expectPostgresError(
      lifecycle.activate(context(fixtures.stores.activate), {
        operationId,
        reason: 'Different activation semantics',
      }),
      '23505',
    );

    const history = await lifecycle.readHistory(context(fixtures.stores.activate));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      adminUserId: fixtures.users.admin,
      action: 'subscription_activate',
      reason: 'Initial commercial activation',
      operationId,
      previousValues: null,
    });
    expect(history[0]?.currentValues).toMatchObject({
      subscriptionId: first.subscriptionId,
      status: 'active',
      version: '1',
    });
  });

  it('derives exact-end and future entitlement from server time without client-time input', async () => {
    const now = Date.now();
    await insertSubscription(
      fixtures.stores.boundary,
      'active',
      new Date(now - 3_600_000),
      new Date(now - 1),
    );
    let records = await lifecycle.readLifecycle(context(fixtures.stores.boundary));
    expect(records[0]).toMatchObject({
      storedStatus: 'active',
      effectiveStatus: 'expired',
      current: true,
      writeEligible: false,
    });

    await fixturePool.query(`delete from platform.subscriptions where store_id = $1`, [
      fixtures.stores.boundary,
    ]);
    await insertSubscription(
      fixtures.stores.boundary,
      'active',
      new Date(now + 3_600_000),
      new Date(now + 7_200_000),
    );
    records = await lifecycle.readLifecycle(context(fixtures.stores.boundary));
    expect(records[0]).toMatchObject({
      effectiveStatus: 'active',
      current: true,
      writeEligible: false,
    });

    const signature = await adminPool.query<{ arguments: string }>(`
      select pg_get_function_identity_arguments(
        'ledger.manage_subscription_lifecycle(uuid,text,uuid,text,text)'::regprocedure
      ) as arguments
    `);
    expect(signature.rows[0]?.arguments).toBe(
      'p_store_id uuid, p_action text, p_operation_id uuid, p_request_hash text, p_reason text',
    );
  });

  it('extends and cancels immutably without changing Store lifecycle', async () => {
    const activated = await lifecycle.activate(context(fixtures.stores.lifecycle), {
      operationId: randomUUID(),
      reason: 'Lifecycle activation',
    });
    const extended = await lifecycle.extend(context(fixtures.stores.lifecycle), {
      operationId: randomUUID(),
      reason: 'Approved manual extension',
    });
    expect(extended).toMatchObject({
      subscriptionId: activated.subscriptionId,
      status: 'active',
      version: 2n,
      action: 'extend',
    });
    expect(extended.endsAt.getTime() - activated.endsAt.getTime()).toBe(
      planDurationDays * 24 * 60 * 60 * 1000,
    );

    const cancelled = await lifecycle.cancel(context(fixtures.stores.lifecycle), {
      operationId: randomUUID(),
      reason: 'Approved commercial cancellation',
    });
    expect(cancelled).toMatchObject({
      subscriptionId: activated.subscriptionId,
      status: 'cancelled',
      version: 3n,
      action: 'cancel',
    });
    expect(cancelled.cancelledAt).not.toBeNull();

    const history = await lifecycle.readHistory(context(fixtures.stores.lifecycle));
    expect(history.map((entry) => entry.action)).toEqual([
      'subscription_activate',
      'subscription_extend',
      'subscription_cancel',
    ]);
    expect(history[1]?.previousValues).toMatchObject({ version: '1' });
    expect(history[1]?.currentValues).toMatchObject({ version: '2' });
    expect(history[2]?.previousValues).toMatchObject({ version: '2' });
    expect(history[2]?.currentValues).toMatchObject({ status: 'cancelled', version: '3' });

    const store = await adminPool.query<{ status: string }>(
      `select status from ledger.stores where id = $1`,
      [fixtures.stores.lifecycle],
    );
    expect(store.rows[0]?.status).toBe('active');
  });

  it('reactivates only after expiry and preserves the expired entitlement gap', async () => {
    const oldEnd = new Date(Date.now() - 3_600_000);
    const oldId = await insertSubscription(
      fixtures.stores.expired,
      'active',
      new Date(oldEnd.getTime() - 30 * 24 * 60 * 60 * 1000),
      oldEnd,
    );
    const reactivated = await lifecycle.reactivate(context(fixtures.stores.expired), {
      operationId: randomUUID(),
      reason: 'Expired entitlement reactivation',
    });
    expect(reactivated).toMatchObject({ status: 'active', action: 'reactivate', version: 1n });
    expect(reactivated.subscriptionId).not.toBe(oldId);
    expect(reactivated.startsAt.getTime()).toBeGreaterThan(oldEnd.getTime());

    const persisted = await adminPool.query<{
      id: string;
      status: string;
      startsAt: Date;
      endsAt: Date;
    }>(
      `select id, status, starts_at as "startsAt", expires_at as "endsAt"
       from platform.subscriptions where store_id = $1 order by starts_at`,
      [fixtures.stores.expired],
    );
    expect(persisted.rows).toHaveLength(2);
    expect(persisted.rows[0]).toMatchObject({ id: oldId, status: 'expired', endsAt: oldEnd });
    expect(persisted.rows[1]).toMatchObject({
      id: reactivated.subscriptionId,
      status: 'active',
      startsAt: reactivated.startsAt,
    });
  });

  it('allows read-only commercial activation but rejects suspended and archived Stores', async () => {
    const readOnly = await lifecycle.activate(context(fixtures.stores.readOnly), {
      operationId: randomUUID(),
      reason: 'Commercial activation independent of Store read-only state',
    });
    expect(readOnly.status).toBe('active');
    const entitlement = await platformAuthority.withLockedEffectiveEntitlement(
      context(fixtures.stores.readOnly),
      async (authority) => authority,
    );
    expect(entitlement).toMatchObject({
      storeStatus: 'read_only',
      effectiveAccess: 'read_only',
      writeEligible: false,
      denialReason: 'store_read_only',
    });

    for (const storeId of [fixtures.stores.suspended, fixtures.stores.archived]) {
      await expectPostgresError(
        lifecycle.activate(context(storeId), {
          operationId: randomUUID(),
          reason: 'Restricted Store activation rejection',
        }),
        '55000',
      );
      const rows = await adminPool.query(
        `select id from platform.subscriptions where store_id = $1`,
        [storeId],
      );
      expect(rows.rowCount).toBe(0);
    }
  });

  it('serializes extension, cancellation, and reactivation races into coherent history', async () => {
    const initial = await lifecycle.activate(context(fixtures.stores.extendRace), {
      operationId: randomUUID(),
      reason: 'Extension race activation',
    });
    const extensions = await Promise.all([
      lifecycle.extend(context(fixtures.stores.extendRace), {
        operationId: randomUUID(),
        reason: 'Concurrent extension A',
      }),
      lifecycle.extend(context(fixtures.stores.extendRace), {
        operationId: randomUUID(),
        reason: 'Concurrent extension B',
      }),
    ]);
    expect(extensions.map((result) => result.version).sort()).toEqual([2n, 3n]);
    const extensionState = await adminPool.query<{ endsAt: Date; version: string }>(
      `select expires_at as "endsAt", version::text as version
       from platform.subscriptions where id = $1`,
      [initial.subscriptionId],
    );
    const extendedState = extensionState.rows[0];
    if (!extendedState) throw new Error('Expected the concurrently extended Subscription.');
    expect(extendedState).toMatchObject({ version: '3' });
    expect(extendedState.endsAt.getTime() - initial.endsAt.getTime()).toBe(
      2 * planDurationDays * 24 * 60 * 60 * 1000,
    );

    await lifecycle.activate(context(fixtures.stores.cancelRace), {
      operationId: randomUUID(),
      reason: 'Cancellation race activation',
    });
    const cancellationRace = await Promise.allSettled([
      lifecycle.extend(context(fixtures.stores.cancelRace), {
        operationId: randomUUID(),
        reason: 'Concurrent extension before cancellation',
      }),
      lifecycle.cancel(context(fixtures.stores.cancelRace), {
        operationId: randomUUID(),
        reason: 'Concurrent cancellation',
      }),
    ]);
    expect(cancellationRace[1].status).toBe('fulfilled');
    const cancelled = await adminPool.query<{ status: string; count: number }>(
      `select max(status) as status, count(*)::integer as count
       from platform.subscriptions where store_id = $1`,
      [fixtures.stores.cancelRace],
    );
    expect(cancelled.rows[0]).toEqual({ status: 'cancelled', count: 1 });

    await insertSubscription(
      fixtures.stores.reactivateRace,
      'active',
      new Date(Date.now() - 7_200_000),
      new Date(Date.now() - 3_600_000),
    );
    const reactivationRace = await Promise.allSettled([
      lifecycle.reactivate(context(fixtures.stores.reactivateRace), {
        operationId: randomUUID(),
        reason: 'Concurrent reactivation A',
      }),
      lifecycle.reactivate(context(fixtures.stores.reactivateRace), {
        operationId: randomUUID(),
        reason: 'Concurrent reactivation B',
      }),
    ]);
    expect(reactivationRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(reactivationRace.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const reactivated = await adminPool.query<{ active: number; expired: number }>(
      `select
         count(*) filter (where status = 'active')::integer as active,
         count(*) filter (where status = 'expired')::integer as expired
       from platform.subscriptions where store_id = $1`,
      [fixtures.stores.reactivateRace],
    );
    expect(reactivated.rows[0]).toEqual({ active: 1, expired: 1 });
  });

  it('provisions complete atomic Store foundations with optional Subscription separation', async () => {
    const withoutSubscription = await provisioning.provision(
      provisioningActor(),
      provisioningCommand(fixtures.provisioningOperations.withoutSubscription),
    );
    expect(withoutSubscription).toMatchObject({
      ownerUserId: fixtures.users.ownerA,
      subscriptionId: null,
      replayed: false,
      state: {
        ownerCount: 1n,
        ownerUserId: fixtures.users.ownerA,
        settingsCount: 1n,
        systemCashCount: 1n,
        subscriptionCount: 0n,
      },
    });
    const noSubscriptionEntitlement = await platformAuthority.withLockedEffectiveEntitlement(
      context(withoutSubscription.storeId),
      async (authority) => authority,
    );
    expect(noSubscriptionEntitlement).toMatchObject({
      effectiveAccess: 'read_only',
      writeEligible: false,
      denialReason: 'subscription_missing',
    });

    const withSubscription = await provisioning.provision(
      provisioningActor(),
      provisioningCommand(fixtures.provisioningOperations.withSubscription, {
        activateSubscription: true,
      }),
    );
    expect(withSubscription).toMatchObject({
      ownerUserId: fixtures.users.ownerA,
      subscriptionStatus: 'active',
      subscriptionVersion: 1n,
      state: {
        ownerCount: 1n,
        settingsCount: 1n,
        systemCashCount: 1n,
        subscriptionCount: 1n,
      },
    });
    expect(withSubscription.subscriptionId).not.toBeNull();
    expect(withSubscription.state.currentSubscriptionId).toBe(withSubscription.subscriptionId);
    const activeEntitlement = await platformAuthority.withLockedEffectiveEntitlement(
      context(withSubscription.storeId),
      async (authority) => authority,
    );
    expect(activeEntitlement).toMatchObject({ effectiveAccess: 'write', writeEligible: true });

    const adminMembership = await adminPool.query(
      `select id from platform.store_memberships where store_id = any($1::uuid[]) and user_id = $2`,
      [[withoutSubscription.storeId, withSubscription.storeId], fixtures.users.admin],
    );
    expect(adminMembership.rowCount).toBe(0);
  });

  it('replays and serializes duplicate provisioning without duplicate foundation', async () => {
    const command = provisioningCommand(fixtures.provisioningOperations.concurrent, {
      activateSubscription: true,
    });
    const [first, second] = await Promise.all([
      provisioning.provision(provisioningActor(), command),
      provisioning.provision(provisioningActor(), command),
    ]);
    expect(first.storeId).toBe(second.storeId);
    expect(first.membershipId).toBe(second.membershipId);
    expect(first.subscriptionId).toBe(second.subscriptionId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await expect(countStoreFoundation(first.storeId)).resolves.toEqual({
      stores: 1,
      memberships: 1,
      settings: 1,
      cash: 1,
      subscriptions: 1,
      actions: 1,
    });

    await expectPostgresError(
      provisioning.provision(
        provisioningActor(),
        provisioningCommand(fixtures.provisioningOperations.concurrent, {
          name: 'Conflicting retry name',
          activateSubscription: true,
        }),
      ),
      '23505',
    );
  });

  it('rolls back Owner, settings, System Cash, and initial-Subscription failures without residue', async () => {
    const inactiveOperation = fixtures.provisioningOperations.inactiveOwner;
    await expectPostgresError(
      provisioning.provision(
        provisioningActor(),
        provisioningCommand(inactiveOperation, { ownerUserId: fixtures.users.inactiveOwner }),
      ),
      '42501',
    );
    await expect(
      countStoreFoundation(deriveProvisionedStoreId(inactiveOperation)),
    ).resolves.toEqual({
      stores: 0,
      memberships: 0,
      settings: 0,
      cash: 0,
      subscriptions: 0,
      actions: 0,
    });

    const invalidSettingsOperation = fixtures.provisioningOperations.invalidSettings;
    await expect(
      provisioning.provision(
        provisioningActor(),
        provisioningCommand(invalidSettingsOperation, {
          settings: { ...settings, dailyReportTimeMinutes: 1440 },
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      countStoreFoundation(deriveProvisionedStoreId(invalidSettingsOperation)),
    ).resolves.toEqual({
      stores: 0,
      memberships: 0,
      settings: 0,
      cash: 0,
      subscriptions: 0,
      actions: 0,
    });

    const cashFailureOperation = fixtures.provisioningOperations.cashFailure;
    const cashFailure = jest
      .spyOn(systemCash, 'ensureForStoreInTransaction')
      .mockRejectedValueOnce(new Error('S18.4 injected System Cash failure'));
    await expect(
      provisioning.provision(provisioningActor(), provisioningCommand(cashFailureOperation)),
    ).rejects.toThrow('S18.4 injected System Cash failure');
    cashFailure.mockRestore();
    await expect(
      countStoreFoundation(deriveProvisionedStoreId(cashFailureOperation)),
    ).resolves.toEqual({
      stores: 0,
      memberships: 0,
      settings: 0,
      cash: 0,
      subscriptions: 0,
      actions: 0,
    });

    await fixturePool.query(
      `insert into platform.subscription_plans (
         id, code, name, duration_days, price_minor, offline_grace_days, status
       ) values ($1, 'dokana-s18-4-conflict', 'Dokana S18.4 Conflict', 30, 0, 0, 'active')`,
      [fixtures.extraPlan],
    );
    const subscriptionFailureOperation = fixtures.provisioningOperations.subscriptionFailure;
    try {
      await expectPostgresError(
        provisioning.provision(
          provisioningActor(),
          provisioningCommand(subscriptionFailureOperation, { activateSubscription: true }),
        ),
        '55000',
      );
    } finally {
      await fixturePool.query(`delete from platform.subscription_plans where id = $1`, [
        fixtures.extraPlan,
      ]);
    }
    await expect(
      countStoreFoundation(deriveProvisionedStoreId(subscriptionFailureOperation)),
    ).resolves.toEqual({
      stores: 0,
      memberships: 0,
      settings: 0,
      cash: 0,
      subscriptions: 0,
      actions: 0,
    });
  });
});
