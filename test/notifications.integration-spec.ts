import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { NotificationRepository } from '../src/notifications/notification.repository';
import { NotificationSchedulerService } from '../src/notifications/notification-scheduler.service';
import type {
  NotificationListResponse,
  NotificationReadStateResponse,
  NotificationSettingsMutationResponse,
  NotificationSettingsResponse,
} from '../src/notifications/notification.types';
import {
  createTestPool,
  provisionActiveTestEntitlements,
  readLocalPostgresTestEnvironment,
  removeActiveTestEntitlements,
  type ActiveTestEntitlementFixture,
} from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: 'a2100000-0000-4000-8000-000000000001',
    b: 'a2100000-0000-4000-8000-000000000002',
    readOnly: 'a2100000-0000-4000-8000-000000000003',
  },
  users: {
    ownerA: 'a2200000-0000-4000-8000-000000000001',
    ownerA2: 'a2200000-0000-4000-8000-000000000002',
    managerA: 'a2200000-0000-4000-8000-000000000003',
    ownerB: 'a2200000-0000-4000-8000-000000000004',
    readOnly: 'a2200000-0000-4000-8000-000000000005',
  },
  memberships: {
    ownerA: 'a2300000-0000-4000-8000-000000000001',
    ownerA2: 'a2300000-0000-4000-8000-000000000002',
    managerA: 'a2300000-0000-4000-8000-000000000003',
    ownerB: 'a2300000-0000-4000-8000-000000000004',
    readOnly: 'a2300000-0000-4000-8000-000000000005',
  },
  devices: {
    ownerA: 'a2400001-0001-4000-8000-000000000001',
    ownerA2: 'a2400002-0002-4000-8000-000000000002',
    managerA: 'a2400003-0003-4000-8000-000000000003',
    ownerB: 'a2400004-0004-4000-8000-000000000004',
    readOnly: 'a2400005-0005-4000-8000-000000000005',
  },
  emails: {
    ownerA: 's21-owner-a@example.test',
    ownerA2: 's21-owner-a2@example.test',
    managerA: 's21-manager-a@example.test',
    ownerB: 's21-owner-b@example.test',
    readOnly: 's21-read-only@example.test',
  },
  password: 'S21-Notification-Test-Password!',
};

type AccessKey = keyof typeof fixture.emails;
type MembershipRole = 'owner' | 'manager';

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface AccountingSnapshot {
  sales: number;
  purchaseInvoices: number;
  moneyMovements: number;
  inventoryMovements: number;
  customerLedgerEntries: number;
  supplierLedgerEntries: number;
  expenses: number;
}

const storeByAccess: Readonly<Record<AccessKey, string>> = {
  ownerA: fixture.stores.a,
  ownerA2: fixture.stores.a,
  managerA: fixture.stores.a,
  ownerB: fixture.stores.b,
  readOnly: fixture.stores.readOnly,
};
const roleByAccess: Readonly<Record<AccessKey, MembershipRole>> = {
  ownerA: 'owner',
  ownerA2: 'owner',
  managerA: 'manager',
  ownerB: 'owner',
  readOnly: 'owner',
};
const accessKeys = Object.keys(fixture.emails) as AccessKey[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readAccessToken(response: Response): string {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.accessToken !== 'string') {
    throw new Error('Expected an access token.');
  }
  return body.accessToken;
}

function responseBody(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) throw new Error('Expected an object response body.');
  return response.body;
}

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

describe('Owner-focused notifications with real PostgreSQL', () => {
  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const nullLogs = new NullLogDestination();
  let app: INestApplication | undefined;
  let server: Server;
  let fixturePool: Pool;
  let triggerPool: Pool;
  let runtimePool: Pool;
  let poolsInitialized = false;
  let entitlementFixture: ActiveTestEntitlementFixture | undefined;
  let access: Record<AccessKey, AccessIdentity>;
  let subscriptionA: string;
  let accountingBefore: AccountingSnapshot;

  async function removeFixtures(): Promise<void> {
    await fixturePool.query(
      `delete from platform.refresh_tokens
       where session_id in (
         select id from platform.auth_sessions where user_id = any($1::uuid[])
       )`,
      [userIds],
    );
    await fixturePool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await fixturePool.query(
      `delete from ledger.notification_user_states where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from ledger.notifications where store_id = any($1::uuid[])`, [
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
      `delete from sync.store_change_events_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.store_change_watermarks_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from audit.central_audit_logs where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await removeActiveTestEntitlements(fixturePool, entitlementFixture);
    entitlementFixture = undefined;
    await fixturePool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await fixturePool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function login(key: AccessKey): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: storeByAccess[key],
        deviceId: fixture.devices[key],
        deviceName: `S21 ${key} device`,
        devicePlatform: 'android',
      });
    if (response.status !== 200) {
      const body: unknown = response.body;
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : 'UNKNOWN';
      throw new Error(
        `S21 fixture login failed for ${key}: HTTP ${String(response.status)} ${code}`,
      );
    }
    return {
      accessToken: readAccessToken(response),
      storeId: storeByAccess[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function authorized(identity: AccessIdentity, method: 'get' | 'patch', path: string) {
    return request(server)[method](path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  function context(key: AccessKey): TenantTransactionContext {
    return {
      storeId: access[key].storeId,
      userId: access[key].userId,
      deviceId: access[key].deviceId,
      requestId: randomUUID(),
    };
  }

  async function setRuntimeContext(client: PoolClient, identity: AccessIdentity): Promise<void> {
    await client.query(
      `select
         set_config('app.store_id', $1, true),
         set_config('app.user_id', $2, true),
         set_config('app.device_id', $3, true),
         set_config('app.request_id', $4, true)`,
      [identity.storeId, identity.userId, identity.deviceId, randomUUID()],
    );
  }

  async function accountingSnapshot(): Promise<AccountingSnapshot> {
    const result = await fixturePool.query<AccountingSnapshot>(
      `select
         (select count(*)::integer from ledger.sales where store_id = any($1::uuid[])) as sales,
         (select count(*)::integer from ledger.purchase_invoices
          where store_id = any($1::uuid[])) as "purchaseInvoices",
         (select count(*)::integer from ledger.money_movements
          where store_id = any($1::uuid[])) as "moneyMovements",
         (select count(*)::integer from ledger.inventory_movements
          where store_id = any($1::uuid[])) as "inventoryMovements",
         (select count(*)::integer from ledger.customer_ledger_entries
          where store_id = any($1::uuid[])) as "customerLedgerEntries",
         (select count(*)::integer from ledger.supplier_ledger_entries
          where store_id = any($1::uuid[])) as "supplierLedgerEntries",
         (select count(*)::integer from ledger.expenses
          where store_id = any($1::uuid[])) as expenses`,
      [storeIds],
    );
    const snapshot = result.rows[0];
    if (!snapshot) throw new Error('Expected an accounting snapshot.');
    return snapshot;
  }

  async function insertNotification(input: {
    id?: string;
    storeId?: string;
    key: string;
    type?: string;
    createdAt?: string;
    resolvedAt?: string | null;
  }): Promise<string> {
    const id = input.id ?? randomUUID();
    await fixturePool.query(
      `insert into ledger.notifications (
         id, store_id, notification_key, notification_type, severity,
         title, body, status, resolved_at, created_at, updated_at
       ) values (
         $1, $2, $3, $4, 'warning', 'Fixture notification', 'Fixture body',
         $5, $6::timestamptz, coalesce($7::timestamptz, clock_timestamp()),
         coalesce($7::timestamptz, clock_timestamp())
       )`,
      [
        id,
        input.storeId ?? fixture.stores.a,
        input.key,
        input.type ?? 'review_required',
        input.resolvedAt ? 'resolved' : 'unread',
        input.resolvedAt ?? null,
        input.createdAt ?? null,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s21-notification-fixtures',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    triggerPool = createTestPool(
      environment.adminUrl,
      'dokana-s21-notification-trigger',
      2,
      '-c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s21-notification-runtime', 2);
    poolsInitialized = true;

    await removeFixtures();
    for (const [key, storeId] of Object.entries(fixture.stores)) {
      await fixturePool.query(
        `insert into ledger.stores (id, name, status) values ($1, $2, 'active')`,
        [storeId, `S21 ${key} Store`],
      );
      await fixturePool.query(
        `insert into ledger.app_settings (
           store_id, debt_age_alert_days, customer_debt_amount_alert_minor
         ) values ($1, 30, 50000)`,
        [storeId],
      );
    }

    const passwordHash = await new PasswordService().hash(fixture.password);
    for (const key of accessKeys) {
      await fixturePool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1, $2, $2, $3, $4, 'active')`,
        [fixture.users[key], fixture.emails[key], passwordHash, `S21 ${key}`],
      );
      await fixturePool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, $4, 'active')`,
        [fixture.memberships[key], storeByAccess[key], fixture.users[key], roleByAccess[key]],
      );
    }
    entitlementFixture = await provisionActiveTestEntitlements(fixturePool, storeIds);
    const subscription = await fixturePool.query<{ id: string }>(
      `select id from platform.subscriptions where store_id = $1 and status = 'active'`,
      [fixture.stores.a],
    );
    const subscriptionRow = subscription.rows[0];
    if (!subscriptionRow) throw new Error('Expected the Store A entitlement fixture.');
    subscriptionA = subscriptionRow.id;

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config, nullLogs),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();
    nestApp.get(NotificationSchedulerService).onModuleDestroy();

    access = {} as Record<AccessKey, AccessIdentity>;
    for (const key of accessKeys) access[key] = await login(key);
    await fixturePool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.readOnly,
    ]);
    accountingBefore = await accountingSnapshot();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) return;
    await removeFixtures();
    const residue = await fixturePool.query<{ count: number }>(
      `select (
         (select count(*) from ledger.notification_user_states
          where store_id = any($1::uuid[]))
         + (select count(*) from ledger.notifications where store_id = any($1::uuid[]))
         + (select count(*) from ledger.app_settings where store_id = any($1::uuid[]))
         + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
         + (select count(*) from platform.store_memberships where id = any($2::uuid[]))
         + (select count(*) from platform.users where id = any($3::uuid[]))
         + (select count(*) from ledger.stores where id = any($1::uuid[]))
         + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
         + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
         + (select count(*) from sync.store_change_events_v1 where store_id = any($1::uuid[]))
         + (select count(*) from sync.store_change_watermarks_v1
            where store_id = any($1::uuid[]))
         + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
       )::integer as count`,
      [storeIds, membershipIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), triggerPool.end(), fixturePool.end()]);
  }, 60_000);

  it('maps the 0029/0030 catalog, least privilege, and updated_at-only touch trigger exactly', async () => {
    const catalog = await triggerPool.query<{
      migrationCount: number;
      hasVersion: boolean;
      triggerFunction: string;
      securityDefiner: boolean;
      functionConfig: string[] | null;
      publicExecute: boolean;
      runtimeExecute: boolean;
      stateOwner: string;
      rlsEnabled: boolean;
      rlsForced: boolean;
      runtimeSelectState: boolean;
      runtimeInsertState: boolean;
      runtimeUpdateState: boolean;
      runtimeDeleteState: boolean;
      publicSelectState: boolean;
      authSelectState: boolean;
      debtSettingDefault: string | null;
      debtSettingBigint: boolean;
      debtSettingChecked: boolean;
      amountTypeAccepted: boolean;
    }>(`
      select
        (select count(*)::integer from platform.schema_migrations
         where filename in (
           '0029_notification_user_state_and_debt_threshold.sql',
           '0030_notification_touch_trigger_fix.sql'
         )) as "migrationCount",
        exists (
          select 1 from information_schema.columns
          where table_schema='ledger' and table_name='notifications' and column_name='version'
        ) as "hasVersion",
        (select namespace.nspname || '.' || function_state.proname
         from pg_trigger trigger_state
         join pg_proc function_state on function_state.oid=trigger_state.tgfoid
         join pg_namespace namespace on namespace.oid=function_state.pronamespace
         where trigger_state.tgrelid='ledger.notifications'::regclass
           and trigger_state.tgname='trg_notifications_touch'
           and not trigger_state.tgisinternal) as "triggerFunction",
        (select prosecdef from pg_proc
         where oid='ledger.touch_notification_row()'::regprocedure) as "securityDefiner",
        (select proconfig from pg_proc
         where oid='ledger.touch_notification_row()'::regprocedure) as "functionConfig",
        has_function_privilege('public', 'ledger.touch_notification_row()', 'execute')
          as "publicExecute",
        has_function_privilege('shop_app_runtime', 'ledger.touch_notification_row()', 'execute')
          as "runtimeExecute",
        (select pg_get_userbyid(relowner) from pg_class
         where oid='ledger.notification_user_states'::regclass) as "stateOwner",
        (select relrowsecurity from pg_class
         where oid='ledger.notification_user_states'::regclass) as "rlsEnabled",
        (select relforcerowsecurity from pg_class
         where oid='ledger.notification_user_states'::regclass) as "rlsForced",
        has_table_privilege(
          'shop_app_runtime', 'ledger.notification_user_states', 'select'
        ) as "runtimeSelectState",
        has_table_privilege(
          'shop_app_runtime', 'ledger.notification_user_states', 'insert'
        ) as "runtimeInsertState",
        has_table_privilege(
          'shop_app_runtime', 'ledger.notification_user_states', 'update'
        ) as "runtimeUpdateState",
        has_table_privilege(
          'shop_app_runtime', 'ledger.notification_user_states', 'delete'
        ) as "runtimeDeleteState",
        has_table_privilege(
          'public', 'ledger.notification_user_states', 'select'
        ) as "publicSelectState",
        has_table_privilege(
          'shop_app_auth', 'ledger.notification_user_states', 'select'
        ) as "authSelectState",
        (select column_default from information_schema.columns
         where table_schema='ledger' and table_name='app_settings'
           and column_name='customer_debt_amount_alert_minor') as "debtSettingDefault",
        exists (
          select 1 from information_schema.columns
          where table_schema='ledger' and table_name='app_settings'
            and column_name='customer_debt_amount_alert_minor' and data_type='bigint'
        ) as "debtSettingBigint",
        exists (
          select 1 from pg_constraint
          where conrelid='ledger.app_settings'::regclass
            and conname='app_settings_customer_debt_amount_alert_minor_check'
            and pg_get_constraintdef(oid) like '%customer_debt_amount_alert_minor >= 0%'
        ) as "debtSettingChecked",
        exists (
          select 1 from pg_constraint
          where conrelid='ledger.notifications'::regclass
            and conname='notifications_notification_type_check'
            and pg_get_constraintdef(oid) like '%customer_debt_amount%'
        ) as "amountTypeAccepted"
    `);
    expect(catalog.rows[0]).toEqual({
      migrationCount: 2,
      hasVersion: false,
      triggerFunction: 'ledger.touch_notification_row',
      securityDefiner: false,
      functionConfig: ['search_path=pg_catalog, pg_temp'],
      publicExecute: false,
      runtimeExecute: false,
      stateOwner: 'shop_app_migrator',
      rlsEnabled: true,
      rlsForced: true,
      runtimeSelectState: true,
      runtimeInsertState: true,
      runtimeUpdateState: true,
      runtimeDeleteState: false,
      publicSelectState: false,
      authSelectState: false,
      debtSettingDefault: '50000',
      debtSettingBigint: true,
      debtSettingChecked: true,
      amountTypeAccepted: true,
    });

    const notificationId = await insertNotification({
      key: 's21-trigger-proof',
      type: 'customer_debt_amount',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const updated = await triggerPool.query<{ updatedAt: Date }>(
      `update ledger.notifications set body = 'Updated through 0030'
       where store_id=$1 and id=$2 returning updated_at as "updatedAt"`,
      [fixture.stores.a, notificationId],
    );
    expect(updated.rows[0]?.updatedAt.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
    const genericDefinition = await triggerPool.query<{ definition: string }>(
      `select pg_get_functiondef('ledger.touch_mutable_row()'::regprocedure) as definition`,
    );
    expect(genericDefinition.rows[0]?.definition).toContain('NEW.version := OLD.version + 1');
  });

  it('enforces owner authorization while allowing list and read-state in READ_ONLY', async () => {
    const notificationA = await insertNotification({ key: 'manual-owner-a' });
    const notificationB = await insertNotification({
      key: 'manual-owner-b',
      storeId: fixture.stores.b,
    });
    const notificationReadOnly = await insertNotification({
      key: 'manual-read-only',
      storeId: fixture.stores.readOnly,
    });

    await request(server).get('/v1/notifications').expect(401);
    await authorized(access.managerA, 'get', '/v1/notifications')
      .expect(403)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'NOTIFICATION_ACCESS_NOT_ALLOWED' }),
      );

    const ownerList = responseBody(
      await authorized(access.ownerA, 'get', '/v1/notifications').expect(200),
    ) as unknown as NotificationListResponse;
    expect(ownerList.items.some((item) => item.id === notificationA)).toBe(true);
    expect(ownerList.items.some((item) => item.id === notificationB)).toBe(false);

    const readOnlyList = responseBody(
      await authorized(access.readOnly, 'get', '/v1/notifications').expect(200),
    ) as unknown as NotificationListResponse;
    expect(readOnlyList.items.some((item) => item.id === notificationReadOnly)).toBe(true);
    await authorized(
      access.readOnly,
      'patch',
      `/v1/notifications/${notificationReadOnly}/read-state`,
    )
      .send({ read: true })
      .expect(200);

    await authorized(access.ownerA, 'patch', `/v1/notifications/${notificationB}/read-state`)
      .send({ read: true })
      .expect(404);
  });

  it('keeps read state user-specific and independent from canonical resolution under RLS', async () => {
    const notificationId = await insertNotification({ key: 'manual-multi-owner' });
    const ownerARead = responseBody(
      await authorized(
        access.ownerA,
        'patch',
        `/v1/notifications/${notificationId.toUpperCase()}/read-state`,
      )
        .send({ read: true })
        .expect(200),
    ) as unknown as NotificationReadStateResponse;
    expect(ownerARead).toMatchObject({ id: notificationId, read: true });

    const ownerAList = responseBody(
      await authorized(access.ownerA, 'get', '/v1/notifications?read=true').expect(200),
    ) as unknown as NotificationListResponse;
    const ownerA2List = responseBody(
      await authorized(access.ownerA2, 'get', '/v1/notifications?read=false').expect(200),
    ) as unknown as NotificationListResponse;
    expect(ownerAList.items.some((item) => item.id === notificationId)).toBe(true);
    expect(ownerA2List.items.some((item) => item.id === notificationId)).toBe(true);

    const canonical = await fixturePool.query<{ resolvedAt: Date | null }>(
      `select resolved_at as "resolvedAt" from ledger.notifications where id=$1`,
      [notificationId],
    );
    expect(canonical.rows[0]?.resolvedAt).toBeNull();

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setRuntimeContext(client, access.ownerA);
      await expect(
        client.query(
          `insert into ledger.notification_user_states (
             store_id, notification_id, user_id, read_at
           ) values ($1, $2, $3, clock_timestamp())`,
          [fixture.stores.a, notificationId, fixture.users.ownerA2],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      client.release();
    }

    const noContext = await runtimePool.query<{ notificationCount: number; stateCount: number }>(`
      select
        (select count(*)::integer from ledger.notifications) as "notificationCount",
        (select count(*)::integer from ledger.notification_user_states) as "stateCount"
    `);
    expect(noContext.rows[0]).toEqual({ notificationCount: 0, stateCount: 0 });
  });

  it('uses bounded scope-bound keyset pagination and approved notification filters', async () => {
    const newest = await insertNotification({
      key: 'manual-page-newest',
      type: 'daily_report',
      createdAt: '2026-10-16T12:00:00.000Z',
    });
    const second = await insertNotification({
      key: 'manual-page-second',
      type: 'daily_report',
      createdAt: '2026-10-16T11:00:00.000Z',
    });
    const firstPage = responseBody(
      await authorized(access.ownerA, 'get', '/v1/notifications?limit=1&type=daily_report').expect(
        200,
      ),
    ) as unknown as NotificationListResponse;
    expect(firstPage.items[0]?.id).toBe(newest);
    expect(firstPage.nextCursor).not.toBeNull();

    const nextPage = responseBody(
      await authorized(
        access.ownerA,
        'get',
        `/v1/notifications?limit=1&type=daily_report&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      ).expect(200),
    ) as unknown as NotificationListResponse;
    expect(nextPage.items[0]?.id).toBe(second);

    await authorized(
      access.ownerA,
      'get',
      `/v1/notifications?limit=1&type=daily_report&read=true&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    ).expect(400);
    await authorized(access.ownerA, 'get', '/v1/notifications?limit=101').expect(400);
  });

  it('uses the established idempotent settings authority and blocks READ_ONLY changes', async () => {
    const initial = responseBody(
      await authorized(access.ownerA, 'get', '/v1/notifications/settings').expect(200),
    ) as unknown as NotificationSettingsResponse;
    expect(initial).toMatchObject({
      customerDebtAmountAlertMinor: '50000',
      debtAgeAlertDays: 30,
      lowStockAlertEnabled: true,
    });
    const operationId = randomUUID();
    const updated = responseBody(
      await authorized(access.ownerA, 'patch', '/v1/notifications/settings')
        .send({
          operationId,
          expectedVersion: initial.version,
          customerDebtAmountAlertMinor: '75000',
          debtAgeAlertDays: 45,
          lowStockAlertEnabled: false,
        })
        .expect(200),
    ) as unknown as NotificationSettingsMutationResponse;
    expect(updated).toMatchObject({
      operationId,
      customerDebtAmountAlertMinor: '75000',
      debtAgeAlertDays: 45,
      lowStockAlertEnabled: false,
    });

    const readOnlySettings = responseBody(
      await authorized(access.readOnly, 'get', '/v1/notifications/settings').expect(200),
    ) as unknown as NotificationSettingsResponse;
    await authorized(access.readOnly, 'patch', '/v1/notifications/settings')
      .send({
        operationId: randomUUID(),
        expectedVersion: readOnlySettings.version,
        debtAgeAlertDays: 45,
      })
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));
  });

  it('exposes only safe backup status to Owners, including READ_ONLY, and blocks non-Owners', async () => {
    const ownerA = responseBody(
      await authorized(access.ownerA, 'get', '/v1/backup-status').expect(200),
    );
    expect(ownerA).toEqual({
      protectionStatus: 'configuration_required',
      logicalBackupStatus: 'unconfigured',
      pitrStatus: 'unverified',
      lastVerifiedRecoveryPointAt: null,
      attentionRequired: false,
    });
    expect(ownerA).not.toHaveProperty('bucket');
    expect(ownerA).not.toHaveProperty('artifact');
    expect(ownerA).not.toHaveProperty('manifest');
    await authorized(access.managerA, 'get', '/v1/backup-status')
      .expect(403)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'BACKUP_STATUS_ACCESS_NOT_ALLOWED' }),
      );
    await authorized(access.readOnly, 'get', '/v1/backup-status').expect(200);
    await authorized(access.ownerB, 'get', '/v1/backup-status')
      .expect(200)
      .expect(({ body }) => expect(body).toEqual(ownerA));
  });

  it('deduplicates and resolves the external backup-protection notification episode', async () => {
    if (!app) throw new Error('The notification integration application is unavailable.');
    const repository = app.get(NotificationRepository);
    const cause = {
      key: `s21:v1:backup_failure:backup_protection:${fixture.stores.a}`,
      type: 'backup_failure' as const,
      severity: 'critical' as const,
      title: 'Backup protection needs attention',
      body: 'There is a problem protecting your Store data backup.',
      entityType: 'backup_protection',
      entityId: fixture.stores.a,
    };
    await Promise.all([
      repository.reconcile(context('ownerA'), [cause]),
      repository.reconcile(context('ownerA2'), [cause]),
    ]);
    const active = await fixturePool.query<{ id: string }>(
      `select id from ledger.notifications
       where store_id=$1 and notification_key=$2 and resolved_at is null`,
      [fixture.stores.a, cause.key],
    );
    expect(active.rowCount).toBe(1);

    await repository.reconcile(context('ownerA'), []);
    const resolved = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.notifications
       where store_id=$1 and notification_type='backup_failure' and resolved_at is not null`,
      [fixture.stores.a],
    );
    expect(resolved.rows[0]?.count).toBe(1);
    const otherStore = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.notifications
       where store_id=$1 and notification_type='backup_failure'`,
      [fixture.stores.b],
    );
    expect(otherStore.rows[0]?.count).toBe(0);
    expect(await accountingSnapshot()).toEqual(accountingBefore);
  });

  it('deduplicates concurrent canonical causes and preserves history/read state across resolution and recurrence', async () => {
    if (!app) throw new Error('The notification integration application is unavailable.');
    const repository = app.get(NotificationRepository);
    await fixturePool.query(
      `update platform.subscriptions
       set expires_at=clock_timestamp() + interval '5 days'
       where id=$1`,
      [subscriptionA],
    );

    await Promise.all([
      repository.reconcile(context('ownerA')),
      repository.reconcile(context('ownerA2')),
    ]);
    const active = await fixturePool.query<{ id: string; updatedAt: Date }>(
      `select id, updated_at as "updatedAt" from ledger.notifications
       where store_id=$1 and notification_key=$2 and resolved_at is null`,
      [fixture.stores.a, `s21:v1:subscription_expiry:subscription:${subscriptionA}`],
    );
    expect(active.rowCount).toBe(1);
    const firstEpisode = active.rows[0];
    if (!firstEpisode) throw new Error('Expected the first Subscription notification episode.');

    await Promise.all([
      repository.setReadState(context('ownerA'), firstEpisode.id, true),
      repository.setReadState(context('ownerA2'), firstEpisode.id, true),
    ]);
    await fixturePool.query(
      `update platform.subscriptions
       set expires_at=clock_timestamp() + interval '365 days'
       where id=$1`,
      [subscriptionA],
    );
    await repository.reconcile(context('ownerA'));
    const resolved = await fixturePool.query<{
      resolvedAt: Date;
      updatedAt: Date;
      stateCount: number;
    }>(
      `select notification.resolved_at as "resolvedAt",
              notification.updated_at as "updatedAt",
              (select count(*)::integer from ledger.notification_user_states state
               where state.store_id=notification.store_id
                 and state.notification_id=notification.id) as "stateCount"
       from ledger.notifications notification where notification.id=$1`,
      [firstEpisode.id],
    );
    expect(resolved.rows[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(resolved.rows[0]?.updatedAt.getTime()).toBeGreaterThan(firstEpisode.updatedAt.getTime());
    expect(resolved.rows[0]?.stateCount).toBe(2);

    await fixturePool.query(
      `update platform.subscriptions
       set expires_at=clock_timestamp() + interval '4 days'
       where id=$1`,
      [subscriptionA],
    );
    await Promise.all([
      repository.reconcile(context('ownerA')),
      repository.reconcile(context('ownerA2')),
    ]);
    const episodes = await fixturePool.query<{
      id: string;
      resolvedAt: Date | null;
      notificationKey: string;
    }>(
      `select id, resolved_at as "resolvedAt", notification_key as "notificationKey"
       from ledger.notifications
       where store_id=$1 and notification_type='subscription_expiry'
         and entity_id=$2
       order by created_at, id`,
      [fixture.stores.a, subscriptionA],
    );
    expect(episodes).toMatchObject({ rowCount: 2 });
    expect(episodes.rows.filter((row) => row.resolvedAt === null)).toHaveLength(1);
    expect(episodes.rows.some((row) => row.id === firstEpisode.id && row.resolvedAt !== null)).toBe(
      true,
    );
    expect(episodes.rows.find((row) => row.id === firstEpisode.id)?.notificationKey).toContain(
      ':resolved:',
    );
  });

  it('removes only notification presentation older than 180 days with zero accounting mutation', async () => {
    if (!app) throw new Error('The notification integration application is unavailable.');
    const oldId = await insertNotification({
      key: 'manual-expired-history',
      createdAt: '2025-01-01T00:00:00.000Z',
      resolvedAt: '2025-01-02T00:00:00.000Z',
    });
    await fixturePool.query(
      `insert into ledger.notification_user_states (
         store_id, notification_id, user_id, read_at
       ) values ($1, $2, $3, '2025-01-02T00:00:00Z')`,
      [fixture.stores.a, oldId, fixture.users.ownerA],
    );

    await app.get(NotificationRepository).reconcile(context('ownerA'));
    const retained = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.notifications where id=$1`,
      [oldId],
    );
    const state = await fixturePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.notification_user_states
       where notification_id=$1`,
      [oldId],
    );
    expect(retained.rows[0]?.count).toBe(0);
    expect(state.rows[0]?.count).toBe(0);
    expect(await accountingSnapshot()).toEqual(accountingBefore);
  });
});
