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

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import type { AuditListResponse } from '../src/audit/audit.types';
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
    a: 'a3100000-0000-4000-8000-000000000001',
    b: 'a3100000-0000-4000-8000-000000000002',
    readOnly: 'a3100000-0000-4000-8000-000000000003',
  },
  users: {
    ownerA: 'a3200000-0000-4000-8000-000000000001',
    ownerA2: 'a3200000-0000-4000-8000-000000000002',
    managerA: 'a3200000-0000-4000-8000-000000000003',
    ownerB: 'a3200000-0000-4000-8000-000000000004',
    readOnly: 'a3200000-0000-4000-8000-000000000005',
  },
  memberships: {
    ownerA: 'a3300000-0000-4000-8000-000000000001',
    ownerA2: 'a3300000-0000-4000-8000-000000000002',
    managerA: 'a3300000-0000-4000-8000-000000000003',
    ownerB: 'a3300000-0000-4000-8000-000000000004',
    readOnly: 'a3300000-0000-4000-8000-000000000005',
  },
  devices: {
    ownerA: 'a3400001-0001-4000-8000-000000000001',
    ownerA2: 'a3400002-0002-4000-8000-000000000002',
    managerA: 'a3400003-0003-4000-8000-000000000003',
    ownerB: 'a3400004-0004-4000-8000-000000000004',
    readOnly: 'a3400005-0005-4000-8000-000000000005',
  },
  emails: {
    ownerA: 's21-audit-owner-a@example.test',
    ownerA2: 's21-audit-owner-a2@example.test',
    managerA: 's21-audit-manager-a@example.test',
    ownerB: 's21-audit-owner-b@example.test',
    readOnly: 's21-audit-read-only@example.test',
  },
  account: 'a3500000-0000-4000-8000-000000000001',
  password: 'S21-Audit-Test-Password!',
};
const periodId = deriveAccountingPeriodId(fixture.stores.a, 2026, 10);

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
  customerLedgerEntries: number;
  supplierLedgerEntries: number;
  expenses: number;
  inventoryMovements: number;
  moneyMovements: number;
  ownerLedgerEntries: number;
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
const storeIds = Object.values(fixture.stores);
const userIds = Object.values(fixture.users);
const membershipIds = Object.values(fixture.memberships);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseBody(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) throw new Error('Expected an object response body.');
  return response.body;
}

function accessToken(response: Response): string {
  const body = responseBody(response);
  if (typeof body.accessToken !== 'string') throw new Error('Expected an access token.');
  return body.accessToken;
}

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

describe('privacy-safe Owner business audit with real PostgreSQL', () => {
  const nullLogs = new NullLogDestination();
  let app: INestApplication | undefined;
  let server: Server;
  let fixturePool: Pool;
  let evidencePool: Pool;
  let runtimePool: Pool;
  let poolsInitialized = false;
  let entitlementFixture: ActiveTestEntitlementFixture | undefined;
  let access: Record<AccessKey, AccessIdentity>;

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
    await fixturePool.query(`delete from sync.conflicts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from sync.offline_operation_recovery_events_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.offline_operation_provenance_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.store_change_events_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from sync.store_change_watermarks_v1 where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from audit.central_audit_logs where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(
      `delete from ledger.owner_ledger_entries where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from ledger.money_movements where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(
      `delete from ledger.accounting_periods where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await fixturePool.query(`delete from ledger.money_accounts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await fixturePool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await fixturePool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await removeActiveTestEntitlements(fixturePool, entitlementFixture);
    entitlementFixture = undefined;
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
        deviceName: `S21 audit ${key}`,
        devicePlatform: 'android',
      });
    if (response.status !== 200) {
      throw new Error(`S21 audit login failed for ${key}: HTTP ${String(response.status)}`);
    }
    return {
      accessToken: accessToken(response),
      storeId: storeByAccess[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function authorized(identity: AccessIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  async function setContext(
    client: PoolClient,
    identity: Pick<AccessIdentity, 'storeId' | 'userId' | 'deviceId'>,
  ): Promise<void> {
    await client.query(
      `select
         set_config('app.store_id', $1, true),
         set_config('app.user_id', $2, true),
         set_config('app.device_id', $3, true),
         set_config('app.request_id', $4, true)`,
      [identity.storeId, identity.userId, identity.deviceId, randomUUID()],
    );
  }

  async function seedEvidence(input: {
    entityType: string;
    entityId?: string;
    userId?: string | null;
    occurredAt: string;
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
    action?: 'insert' | 'update';
  }): Promise<string> {
    const eventId = randomUUID();
    await evidencePool.query(
      `insert into audit.central_audit_logs (
         event_id, store_id, user_id, device_id, request_id, action,
         entity_type, entity_id, old_values, new_values, occurred_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::timestamptz)`,
      [
        eventId,
        fixture.stores.a,
        input.userId === undefined ? fixture.users.ownerA : input.userId,
        fixture.devices.ownerA,
        randomUUID(),
        input.action ?? 'update',
        input.entityType,
        input.entityId ?? randomUUID(),
        input.oldValues === undefined ? null : JSON.stringify(input.oldValues),
        input.newValues === undefined ? null : JSON.stringify(input.newValues),
        input.occurredAt,
      ],
    );
    return eventId;
  }

  async function accountingSnapshot(): Promise<AccountingSnapshot> {
    const result = await fixturePool.query<AccountingSnapshot>(
      `select
         (select count(*)::integer from ledger.sales
          where store_id = any($1::uuid[])) as sales,
         (select count(*)::integer from ledger.customer_ledger_entries
          where store_id = any($1::uuid[])) as "customerLedgerEntries",
         (select count(*)::integer from ledger.supplier_ledger_entries
          where store_id = any($1::uuid[])) as "supplierLedgerEntries",
         (select count(*)::integer from ledger.expenses
          where store_id = any($1::uuid[])) as expenses,
         (select count(*)::integer from ledger.inventory_movements
          where store_id = any($1::uuid[])) as "inventoryMovements",
         (select count(*)::integer from ledger.money_movements
          where store_id = any($1::uuid[])) as "moneyMovements",
         (select count(*)::integer from ledger.owner_ledger_entries
          where store_id = any($1::uuid[])) as "ownerLedgerEntries"`,
      [storeIds],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected an accounting snapshot.');
    return row;
  }

  beforeAll(async () => {
    if (!environment)
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    fixturePool = createTestPool(
      environment.adminUrl,
      'dokana-s21-audit-fixtures',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    evidencePool = createTestPool(
      environment.adminUrl,
      'dokana-s21-audit-evidence',
      2,
      '-c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-s21-audit-runtime', 2);
    poolsInitialized = true;

    await removeFixtures();
    for (const [key, storeId] of Object.entries(fixture.stores)) {
      await fixturePool.query(
        `insert into ledger.stores (id, name, status) values ($1, $2, 'active')`,
        [storeId, `S21 audit ${key}`],
      );
      await fixturePool.query(`insert into ledger.app_settings (store_id) values ($1)`, [storeId]);
    }

    const passwordHash = await new PasswordService().hash(fixture.password);
    for (const key of accessKeys) {
      await fixturePool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1,$2,$2,$3,$4,'active')`,
        [fixture.users[key], fixture.emails[key], passwordHash, `S21 audit ${key}`],
      );
      await fixturePool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1,$2,$3,$4,'active')`,
        [fixture.memberships[key], storeByAccess[key], fixture.users[key], roleByAccess[key]],
      );
    }

    const periodBoundaries = resolveAccountingPeriodBoundaries(2026, 10);
    await fixturePool.query(
      `insert into ledger.accounting_periods (
         id, store_id, period_year, period_month, starts_at, ends_at,
         status, operation_id
       ) values (
         $1,$2,2026,10,$3,$4,'open',$5
       )`,
      [
        periodId,
        fixture.stores.a,
        periodBoundaries.startsAt,
        periodBoundaries.endsAt,
        randomUUID(),
      ],
    );
    await fixturePool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability,
         is_default, status, operation_id
       ) values ($1,$2,'S21 Audit Cash','s21 audit cash','cash','available',true,'active',$3)`,
      [fixture.account, fixture.stores.a, randomUUID()],
    );
    entitlementFixture = await provisionActiveTestEntitlements(fixturePool, storeIds);

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

    access = {} as Record<AccessKey, AccessIdentity>;
    for (const key of accessKeys) access[key] = await login(key);
    await fixturePool.query(`update ledger.stores set status='read_only' where id=$1`, [
      fixture.stores.readOnly,
    ]);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) return;
    await removeFixtures();
    const residue = await fixturePool.query<{ count: number }>(
      `select (
         (select count(*) from audit.central_audit_logs where store_id=any($1::uuid[]))
         + (select count(*) from ledger.owner_ledger_entries where store_id=any($1::uuid[]))
         + (select count(*) from ledger.money_movements where store_id=any($1::uuid[]))
         + (select count(*) from ledger.v_money_account_balances where store_id=any($1::uuid[]))
         + (select count(*) from ledger.app_settings where store_id=any($1::uuid[]))
         + (select count(*) from ledger.accounting_periods where store_id=any($1::uuid[]))
         + (select count(*) from ledger.money_accounts where store_id=any($1::uuid[]))
         + (select count(*) from ledger.devices where store_id=any($1::uuid[]))
         + (select count(*) from platform.store_memberships where id=any($2::uuid[]))
         + (select count(*) from platform.users where id=any($3::uuid[]))
         + (select count(*) from ledger.stores where id=any($1::uuid[]))
         + (select count(*) from sync.processed_operations where store_id=any($1::uuid[]))
         + (select count(*) from sync.change_events where store_id=any($1::uuid[]))
         + (select count(*) from sync.store_change_events_v1 where store_id=any($1::uuid[]))
         + (select count(*) from sync.store_change_watermarks_v1 where store_id=any($1::uuid[]))
       )::integer as count`,
      [storeIds, membershipIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), evidencePool.end(), fixturePool.end()]);
  }, 60_000);

  it('installs only the approved least-privileged 0031 database boundary', async () => {
    const catalog = await evidencePool.query<{
      migrationCount: number;
      owner: string;
      securityDefiner: boolean;
      functionConfig: string[] | null;
      runtimeExecute: boolean;
      publicExecute: boolean;
      authExecute: boolean;
      runtimeRawSelect: boolean;
      runtimeAuditUsage: boolean;
      settingsTrigger: boolean;
      ownerTrigger: boolean;
      immutableTrigger: boolean;
    }>(`
      select
        (select count(*)::integer from platform.schema_migrations
         where filename='0031_sanitized_owner_business_audit.sql') as "migrationCount",
        (select pg_get_userbyid(proowner) from pg_proc
         where oid='ledger.read_owner_business_audit_v1(integer,timestamptz,uuid,timestamptz,timestamptz,uuid,text,text,uuid)'::regprocedure) as owner,
        (select prosecdef from pg_proc
         where oid='ledger.read_owner_business_audit_v1(integer,timestamptz,uuid,timestamptz,timestamptz,uuid,text,text,uuid)'::regprocedure) as "securityDefiner",
        (select proconfig from pg_proc
         where oid='ledger.read_owner_business_audit_v1(integer,timestamptz,uuid,timestamptz,timestamptz,uuid,text,text,uuid)'::regprocedure) as "functionConfig",
        has_function_privilege('shop_app_runtime',
          'ledger.read_owner_business_audit_v1(integer,timestamptz,uuid,timestamptz,timestamptz,uuid,text,text,uuid)','execute') as "runtimeExecute",
        has_function_privilege('public',
          'ledger.read_owner_business_audit_v1(integer,timestamptz,uuid,timestamptz,timestamptz,uuid,text,text,uuid)','execute') as "publicExecute",
        has_function_privilege('shop_app_auth',
          'ledger.read_owner_business_audit_v1(integer,timestamptz,uuid,timestamptz,timestamptz,uuid,text,text,uuid)','execute') as "authExecute",
        has_table_privilege('shop_app_runtime','audit.central_audit_logs','select') as "runtimeRawSelect",
        has_schema_privilege('shop_app_runtime','audit','usage') as "runtimeAuditUsage",
        exists(select 1 from pg_trigger where tgrelid='ledger.app_settings'::regclass
          and tgname='trg_app_settings_central_audit' and not tgisinternal) as "settingsTrigger",
        exists(select 1 from pg_trigger where tgrelid='ledger.owner_ledger_entries'::regclass
          and tgname='trg_owner_ledger_entries_central_audit' and not tgisinternal) as "ownerTrigger",
        exists(select 1 from pg_trigger where tgrelid='audit.central_audit_logs'::regclass
          and tgname='trg_central_audit_immutable' and not tgisinternal) as "immutableTrigger"
    `);
    expect(catalog.rows[0]).toEqual({
      migrationCount: 1,
      owner: 'shop_app_migrator',
      securityDefiner: true,
      functionConfig: ['search_path=pg_catalog, pg_temp'],
      runtimeExecute: true,
      publicExecute: false,
      authExecute: false,
      runtimeRawSelect: false,
      runtimeAuditUsage: false,
      settingsTrigger: true,
      ownerTrigger: true,
      immutableTrigger: true,
    });

    await expect(
      runtimePool.query('select event_id from audit.central_audit_logs limit 1'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      runtimePool.query(
        `select * from ledger.read_owner_business_audit_v1(
           10,null,null,null,null,null,null,null,null
         )`,
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('captures settings and Owner Ledger atomically, replays exactly once, and enforces Owner policy', async () => {
    await request(server).get('/v1/audit').expect(401);
    await authorized(access.managerA, '/v1/audit')
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'AUDIT_ACCESS_NOT_ALLOWED' }));

    const settings = responseBody(await authorized(access.ownerA, '/v1/settings').expect(200));
    const settingsOperation = randomUUID();
    const settingsPayload = {
      operationId: settingsOperation,
      expectedVersion: settings.version,
      debtAgeAlertDays: 45,
      defaultCreditLimitMinor: '9007199254740993',
    };
    await request(server)
      .patch('/v1/settings')
      .set('authorization', `Bearer ${access.ownerA.accessToken}`)
      .send(settingsPayload)
      .expect(200);
    await request(server)
      .patch('/v1/settings')
      .set('authorization', `Bearer ${access.ownerA.accessToken}`)
      .send(settingsPayload)
      .expect(200);

    const ownerOperation = randomUUID();
    const ownerPayload = {
      operationId: ownerOperation,
      moneyAccountId: fixture.account,
      amountMinor: '125000',
      occurredAt: '2026-10-17T10:00:00.000Z',
    };
    await request(server)
      .post('/v1/owner-ledger/contributions')
      .set('authorization', `Bearer ${access.ownerA.accessToken}`)
      .send(ownerPayload)
      .expect(201);
    await request(server)
      .post('/v1/owner-ledger/contributions')
      .set('authorization', `Bearer ${access.ownerA.accessToken}`)
      .send(ownerPayload)
      .expect(201);

    const centralCounts = await evidencePool.query<{ settings: number; owner: number }>(
      `select
         count(*) filter (where entity_type='ledger.app_settings')::integer as settings,
         count(*) filter (where entity_type='ledger.owner_ledger_entries')::integer as owner
       from audit.central_audit_logs where store_id=$1`,
      [fixture.stores.a],
    );
    expect(centralCounts.rows[0]).toEqual({ settings: 1, owner: 1 });

    const result = responseBody(
      await authorized(access.ownerA, '/v1/audit').expect(200),
    ) as unknown as AuditListResponse;
    const settingEvent = result.items.find((item) => item.action === 'STORE_SETTINGS_UPDATED');
    const ownerEvent = result.items.find((item) => item.action === 'OWNER_LEDGER_ENTRY_CREATED');
    expect(settingEvent).toMatchObject({
      actor: { type: 'user', userId: fixture.users.ownerA, displayName: 'S21 audit ownerA' },
      entity: { type: 'store_settings', id: fixture.stores.a },
      context: {
        changes: {
          debtAgeAlertDays: { previous: 90, current: 45 },
          defaultCreditLimitMinor: { previous: null, current: '9007199254740993' },
        },
      },
    });
    expect(ownerEvent).toMatchObject({
      actor: { type: 'user', userId: fixture.users.ownerA, displayName: 'S21 audit ownerA' },
      entity: { type: 'owner_ledger' },
      context: {
        entryType: 'capital_contribution',
        ownerLiabilityDeltaMinor: '0',
        equityDeltaMinor: '125000',
      },
    });
    expect(Object.keys(settingEvent ?? {}).sort()).toEqual(
      [
        'id',
        'action',
        'summary',
        'entity',
        'actor',
        'occurredAt',
        'businessDate',
        'context',
      ].sort(),
    );

    const storeB = responseBody(
      await authorized(access.ownerB, '/v1/audit').expect(200),
    ) as unknown as AuditListResponse;
    expect(storeB.items).toEqual([]);
    await authorized(access.readOnly, '/v1/audit').expect(200);
  });

  it('returns a bounded business timeline with safe actors, filters, pagination, and immutable correction history', async () => {
    const saleId = randomUUID();
    const saleEvent = await seedEvidence({
      entityType: 'ledger.sales',
      entityId: saleId,
      userId: fixture.users.ownerA2,
      occurredAt: '2026-09-01T08:00:00.000Z',
      oldValues: { id: saleId, status: 'draft' },
      newValues: {
        id: saleId,
        status: 'posted',
        correction_of_id: null,
        display_number: 'S-21-001',
        total_minor: 10000,
        paid_total_minor: 10000,
        credit_total_minor: 0,
        password_hash: 'must-not-leak',
        access_token: 'must-not-leak',
      },
    });
    await seedEvidence({
      entityType: 'ledger.customer_payments',
      occurredAt: '2026-09-01T09:00:00.000Z',
      oldValues: { status: 'draft' },
      newValues: {
        status: 'posted',
        customer_id: randomUUID(),
        amount_minor: 5000,
        allocated_total_minor: 5000,
        credit_created_minor: 0,
        refresh_token: 'must-not-leak',
      },
    });
    await seedEvidence({
      entityType: 'ledger.expenses',
      occurredAt: '2026-09-01T10:00:00.000Z',
      oldValues: { status: 'draft', paid_total_minor: 0 },
      newValues: { status: 'posted', amount_minor: 7000, paid_total_minor: 0 },
    });
    await seedEvidence({
      entityType: 'ledger.sale_returns',
      occurredAt: '2026-09-01T11:00:00.000Z',
      oldValues: { status: 'draft' },
      newValues: { status: 'posted', sale_id: saleId, total_minor: 1000, display_number: 'R-1' },
    });
    await seedEvidence({
      entityType: 'ledger.supplier_payments',
      occurredAt: '2026-09-01T12:00:00.000Z',
      oldValues: { status: 'draft' },
      newValues: {
        status: 'posted',
        supplier_id: randomUUID(),
        amount_minor: 3000,
        payment_source: 'money_account',
      },
    });
    await seedEvidence({
      entityType: 'ledger.stock_counts',
      occurredAt: '2026-09-01T13:00:00.000Z',
      oldValues: { status: 'counting' },
      newValues: { status: 'posted', count_type: 'partial', display_number: 'SC-1' },
    });
    await seedEvidence({
      entityType: 'ledger.sales',
      entityId: saleId,
      occurredAt: '2026-09-01T14:00:00.000Z',
      oldValues: { status: 'posted', display_number: 'S-21-001', total_minor: 10000 },
      newValues: {
        status: 'corrected',
        display_number: 'S-21-001',
        total_minor: 10000,
        reversed_by_id: randomUUID(),
      },
    });
    await seedEvidence({
      entityType: 'ledger.inventory_movements',
      occurredAt: '2026-09-01T15:00:00.000Z',
      action: 'insert',
      newValues: { quantity_delta_milli: -1000, sync_hash: 'must-not-leak' },
    });
    await seedEvidence({
      entityType: 'platform.admin_actions',
      occurredAt: '2026-09-01T16:00:00.000Z',
      action: 'insert',
      newValues: { reason: 'platform-private', ip_hash: 'must-not-leak' },
    });

    const range =
      'occurredFrom=2026-09-01T00%3A00%3A00.000Z&occurredTo=2026-09-02T00%3A00%3A00.000Z';
    const firstPage = responseBody(
      await authorized(access.ownerA, `/v1/audit?${range}&limit=2`).expect(200),
    ) as unknown as AuditListResponse;
    expect(firstPage.items.map((item) => item.action)).toEqual([
      'SALE_CORRECTED',
      'STOCK_COUNT_CREATED',
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = responseBody(
      await authorized(
        access.ownerA,
        `/v1/audit?${range}&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      ).expect(200),
    ) as unknown as AuditListResponse;
    expect(secondPage.items.map((item) => item.action)).toEqual([
      'SUPPLIER_PAYMENT_CREATED',
      'SALE_RETURN_CREATED',
    ]);

    await authorized(
      access.ownerB,
      `/v1/audit?${range}&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    ).expect(400);

    const actorFiltered = responseBody(
      await authorized(
        access.ownerA,
        `/v1/audit?${range}&actorUserId=${fixture.users.ownerA2}`,
      ).expect(200),
    ) as unknown as AuditListResponse;
    expect(actorFiltered.items).toHaveLength(1);
    expect(actorFiltered.items[0]).toMatchObject({
      id: saleEvent,
      action: 'SALE_CREATED',
      actor: { userId: fixture.users.ownerA2, displayName: 'S21 audit ownerA2' },
    });

    const saleHistory = responseBody(
      await authorized(access.ownerA, `/v1/audit?${range}&entityId=${saleId}`).expect(200),
    ) as unknown as AuditListResponse;
    expect(saleHistory.items.map((item) => item.action)).toEqual([
      'SALE_CORRECTED',
      'SALE_CREATED',
    ]);

    const serialized = JSON.stringify(
      responseBody(await authorized(access.ownerA, `/v1/audit?${range}`).expect(200)),
    ).toLowerCase();
    for (const forbidden of [
      'old_values',
      'new_values',
      'password_hash',
      'access_token',
      'refresh_token',
      'ip_hash',
      'user_agent',
      'sync_hash',
      'quarantine',
      'platform-private',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('rolls back capture, leaves accounting unchanged on reads, and preserves lifecycle denial', async () => {
    const beforeRollback = await evidencePool.query<{ settings: number; owner: number }>(
      `select
         count(*) filter (where entity_type='ledger.app_settings')::integer as settings,
         count(*) filter (where entity_type='ledger.owner_ledger_entries')::integer as owner
       from audit.central_audit_logs where store_id=$1`,
      [fixture.stores.a],
    );
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await setContext(client, access.ownerA);
      await client.query(
        `update ledger.app_settings set debt_age_alert_days=46 where store_id=$1`,
        [fixture.stores.a],
      );
      await client.query(
        `insert into ledger.owner_ledger_entries (
           id, store_id, accounting_period_id, entry_type,
           owner_liability_delta_minor, equity_delta_minor, money_account_id,
           transaction_group_id, occurred_at, device_id, operation_id
         ) values ($1,$2,$3,'capital_contribution',0,1,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          fixture.stores.a,
          periodId,
          fixture.account,
          randomUUID(),
          new Date('2026-10-17T11:00:00.000Z'),
          fixture.devices.ownerA,
          randomUUID(),
        ],
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
    const afterRollback = await evidencePool.query<{ settings: number; owner: number }>(
      `select
         count(*) filter (where entity_type='ledger.app_settings')::integer as settings,
         count(*) filter (where entity_type='ledger.owner_ledger_entries')::integer as owner
       from audit.central_audit_logs where store_id=$1`,
      [fixture.stores.a],
    );
    expect(afterRollback.rows[0]).toEqual(beforeRollback.rows[0]);

    const accountingBefore = await accountingSnapshot();
    await Promise.all([
      authorized(access.ownerA, '/v1/audit').expect(200),
      authorized(access.ownerA2, '/v1/audit?action=SALE_CREATED').expect(200),
    ]);
    expect(await accountingSnapshot()).toEqual(accountingBefore);

    await fixturePool.query(`update ledger.stores set status='suspended' where id=$1`, [
      fixture.stores.b,
    ]);
    await authorized(access.ownerB, '/v1/audit').expect(401);
    await fixturePool.query(`update ledger.stores set status='archived' where id=$1`, [
      fixture.stores.b,
    ]);
    await authorized(access.ownerB, '/v1/audit').expect(401);
    await fixturePool.query(`update ledger.stores set status='active' where id=$1`, [
      fixture.stores.b,
    ]);
  });
});
