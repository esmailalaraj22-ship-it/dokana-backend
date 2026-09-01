import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { MoneyAccountWriteRepository } from '../src/money-accounts/money-account-write.repository';
import {
  MONEY_ACCOUNT_WRITE_REQUEST_VERSION,
  MoneyAccountWriteService,
} from '../src/money-accounts/money-account-write.service';
import type { MoneyAccountMutationResponse } from '../src/money-accounts/money-account-write.types';
import { canonicalizeMoneyAccountNameV1 } from '../src/money-accounts/money-account-normalization';
import { SYSTEM_CASH_MONEY_ACCOUNT } from '../src/money-accounts/money-account.types';
import {
  SYSTEM_CASH_NORMALIZED_NAME,
  SystemCashInvariantError,
} from '../src/money-accounts/system-cash-invariants';
import { SystemCashProvisioningService } from '../src/money-accounts/system-cash-provisioning.service';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(120_000);

const fixture = {
  stores: {
    ownerA: '85000000-0000-4000-8000-000000000001',
    ownerB: '85000000-0000-4000-8000-000000000002',
    readOnly: '85000000-0000-4000-8000-000000000003',
    viewer: '85000000-0000-4000-8000-000000000004',
    missing: '85000000-0000-4000-8000-000000000005',
    ensure: '85000000-0000-4000-8000-000000000006',
    concurrent: '85000000-0000-4000-8000-000000000007',
    invalid: '85000000-0000-4000-8000-000000000008',
    flip: '85000000-0000-4000-8000-000000000009',
    balance: '85000000-0000-4000-8000-000000000010',
  },
  users: {
    ownerA: '85100000-0000-4000-8000-000000000001',
    ownerB: '85100000-0000-4000-8000-000000000002',
    readOnly: '85100000-0000-4000-8000-000000000003',
    viewer: '85100000-0000-4000-8000-000000000004',
    missing: '85100000-0000-4000-8000-000000000005',
    ensure: '85100000-0000-4000-8000-000000000006',
    concurrent: '85100000-0000-4000-8000-000000000007',
    invalid: '85100000-0000-4000-8000-000000000008',
    flip: '85100000-0000-4000-8000-000000000009',
    balance: '85100000-0000-4000-8000-000000000010',
  },
  memberships: {
    ownerA: '85200000-0000-4000-8000-000000000001',
    ownerB: '85200000-0000-4000-8000-000000000002',
    readOnly: '85200000-0000-4000-8000-000000000003',
    viewer: '85200000-0000-4000-8000-000000000004',
    missing: '85200000-0000-4000-8000-000000000005',
    ensure: '85200000-0000-4000-8000-000000000006',
    concurrent: '85200000-0000-4000-8000-000000000007',
    invalid: '85200000-0000-4000-8000-000000000008',
    flip: '85200000-0000-4000-8000-000000000009',
    balance: '85200000-0000-4000-8000-000000000010',
  },
  devices: {
    ownerA: '85300000-0000-4000-8000-000000000001',
    ownerASecond: '85300000-0000-4000-8000-000000000101',
    ownerB: '85300000-0000-4000-8000-000000000002',
    readOnly: '85300000-0000-4000-8000-000000000003',
    viewer: '85300000-0000-4000-8000-000000000004',
    missing: '85300000-0000-4000-8000-000000000005',
    ensure: '85300000-0000-4000-8000-000000000006',
    concurrent: '85300000-0000-4000-8000-000000000007',
    invalid: '85300000-0000-4000-8000-000000000008',
    flip: '85300000-0000-4000-8000-000000000009',
    balance: '85300000-0000-4000-8000-000000000010',
  },
  emails: {
    ownerA: 'task84-owner-a@example.test',
    ownerB: 'task84-owner-b@example.test',
    readOnly: 'task84-read-only@example.test',
    viewer: 'task84-viewer@example.test',
    missing: 'task84-missing@example.test',
    ensure: 'task84-ensure@example.test',
    concurrent: 'task84-concurrent@example.test',
    invalid: 'task84-invalid@example.test',
    flip: 'task84-flip@example.test',
    balance: 'task84-balance@example.test',
  },
  password: 'Task-8.4-Test-Password!',
  accounts: {
    ownerCash: '85400000-0000-4000-8000-000000000001',
    foreignCash: '85400000-0000-4000-8000-000000000002',
    readOnlyCash: '85400000-0000-4000-8000-000000000003',
    viewerCash: '85400000-0000-4000-8000-000000000004',
    flipCash: '85400000-0000-4000-8000-000000000005',
    balanceCash: '85400000-0000-4000-8000-000000000006',
    invalidCash: '85400000-0000-4000-8000-000000000007',
    external: '85400000-0000-4000-8000-000000000008',
    held: '85400000-0000-4000-8000-000000000009',
    foreignTransfer: '85400000-0000-4000-8000-000000000010',
    positive: '85400000-0000-4000-8000-000000000011',
    negative: '85400000-0000-4000-8000-000000000012',
  },
  period: '85500000-0000-4000-8000-000000000001',
  movements: {
    positive: '85600000-0000-4000-8000-000000000001',
    negative: '85600000-0000-4000-8000-000000000002',
  },
};

type AccessKey = keyof typeof fixture.emails;
type MembershipRole = 'owner' | 'viewer';

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface MoneyAccountRow {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  accountType: 'cash' | 'transfer' | 'external_party';
  availability: 'available' | 'held_by_external_party';
  isDefault: boolean;
  status: 'active' | 'archived';
  archivedAt: Date | null;
  deviceId: string | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: string;
}

interface OperationRow {
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  requestHash: string;
  status: 'processing' | 'applied' | 'rejected';
  responseCode: number | null;
  responseBody: unknown;
  errorCode: string | null;
  completed: boolean;
}

interface EffectCounts {
  changeEvents: number;
  auditLogs: number;
}

const storeIds = Object.values(fixture.stores);
const userIds = Object.values(fixture.users);
const membershipIds = Object.values(fixture.memberships);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseBody(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) {
    throw new Error('Expected an object response body.');
  }
  return response.body;
}

function mutationBody(response: Response): MoneyAccountMutationResponse {
  const body = responseBody(response);
  if (typeof body.id !== 'string' || typeof body.operationId !== 'string') {
    throw new Error('Expected a Money Account mutation response.');
  }
  return body as unknown as MoneyAccountMutationResponse;
}

function withoutTraceFields(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const stable = { ...value };
  delete stable.requestId;
  delete stable.timestamp;
  delete stable.path;
  return stable;
}

function createFingerprint(payload: { id: string; name: string }): string {
  const { name, normalizedName } = canonicalizeMoneyAccountNameV1(payload.name);
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: MONEY_ACCOUNT_WRITE_REQUEST_VERSION,
        action: 'money_account.create',
        moneyAccountId: payload.id,
        name,
        normalizedName,
      }),
      'utf8',
    )
    .digest('hex');
}

describe('Money Account write API and Cash invariants with real PostgreSQL', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let initializer: SystemCashProvisioningService;
  let repository: MoneyAccountWriteRepository;
  let moneyAccountWrites: MoneyAccountWriteService;
  let poolsInitialized = false;
  const access = {} as Record<AccessKey, AccessIdentity>;

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      `delete from platform.refresh_tokens where session_id in (
         select id from platform.auth_sessions where user_id = any($1::uuid[])
       )`,
      [userIds],
    );
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await adminPool.query(`delete from sync.conflicts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from audit.central_audit_logs where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from ledger.money_movements where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from ledger.money_accounts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(
      `delete from ledger.accounting_periods where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function insertAccount(values: {
    id: string;
    storeId: string;
    name: string;
    normalizedName: string;
    accountType: MoneyAccountRow['accountType'];
    availability?: MoneyAccountRow['availability'];
    isDefault?: boolean;
    status?: MoneyAccountRow['status'];
  }): Promise<void> {
    await adminPool.query(
      `insert into ledger.money_accounts (
         id, store_id, name, normalized_name, account_type, availability,
         is_default, status, archived_at, device_id, operation_id
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         case when $8 = 'archived' then clock_timestamp() else null end,
         null, $9
       )`,
      [
        values.id,
        values.storeId,
        values.name,
        values.normalizedName,
        values.accountType,
        values.availability ?? 'available',
        values.isDefault ?? false,
        values.status ?? 'active',
        randomUUID(),
      ],
    );
  }

  async function login(key: AccessKey, deviceId = fixture.devices[key]): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: fixture.stores[key],
        deviceId,
        deviceName: `Task 8.4 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    const token = responseBody(response).accessToken;
    if (typeof token !== 'string') {
      throw new Error('Login did not return an access token.');
    }
    return {
      accessToken: token,
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId,
    };
  }

  function authorizedPost(identity: AccessIdentity, path = '/v1/money-accounts') {
    return request(server).post(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  function authorizedGet(identity: AccessIdentity, path = '/v1/money-accounts') {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  function lifecycle(identity: AccessIdentity, id: string, action: 'archive' | 'restore') {
    return authorizedPost(identity, `/v1/money-accounts/${id}/${action}`);
  }

  function tenantContext(identity: AccessIdentity): TenantTransactionContext {
    return {
      storeId: identity.storeId,
      userId: identity.userId,
      deviceId: identity.deviceId,
      requestId: randomUUID(),
    };
  }

  function createPayload(name: string, id = randomUUID(), operationId = randomUUID()) {
    return { id, operationId, name };
  }

  async function readAccount(id: string): Promise<MoneyAccountRow | null> {
    const result = await adminPool.query<MoneyAccountRow>(
      `select
         id, store_id as "storeId", name, normalized_name as "normalizedName",
         account_type as "accountType", availability, is_default as "isDefault",
         status, archived_at as "archivedAt", device_id as "deviceId",
         operation_id as "operationId", created_at as "createdAt",
         updated_at as "updatedAt", version::text as version
       from ledger.money_accounts where id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async function readCashRows(storeId: string): Promise<MoneyAccountRow[]> {
    const result = await adminPool.query<MoneyAccountRow>(
      `select
         id, store_id as "storeId", name, normalized_name as "normalizedName",
         account_type as "accountType", availability, is_default as "isDefault",
         status, archived_at as "archivedAt", device_id as "deviceId",
         operation_id as "operationId", created_at as "createdAt",
         updated_at as "updatedAt", version::text as version
       from ledger.money_accounts where store_id = $1 and account_type = 'cash'
       order by id`,
      [storeId],
    );
    return result.rows;
  }

  async function readOperation(storeId: string, operationId: string): Promise<OperationRow | null> {
    const result = await adminPool.query<OperationRow>(
      `select
         device_id as "deviceId", aggregate_type as "aggregateType",
         aggregate_id as "aggregateId", action, request_hash as "requestHash",
         status, response_code as "responseCode", response_body as "responseBody",
         error_code as "errorCode", completed_at is not null as completed
       from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [storeId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async function readEffects(storeId: string, accountId: string): Promise<EffectCounts> {
    const result = await adminPool.query<EffectCounts>(
      `select
         (select count(*)::integer from sync.change_events
          where store_id = $1 and entity_type = 'money_accounts' and entity_id = $2)
           as "changeEvents",
         (select count(*)::integer from audit.central_audit_logs
          where store_id = $1 and entity_type = 'ledger.money_accounts' and entity_id = $2)
           as "auditLogs"`,
      [storeId, accountId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Expected Money Account effect counts.');
    }
    return row;
  }

  async function countRows(query: string, values: unknown[] = []): Promise<number> {
    const result = await adminPool.query<{ count: number }>(query, values);
    return result.rows[0]?.count ?? -1;
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;
    process.env.DB_POOL_MAX = '12';

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task84-admin',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task84-runtime', 2);
    poolsInitialized = true;

    const approval = await adminPool.query<{
      databaseName: string;
      isSuperuser: boolean;
      users: number;
      stores: number;
      accounts: number;
      periods: number;
      movements: number;
    }>(`
      select
        current_database() as "databaseName",
        role_state.rolsuper as "isSuperuser",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        (select count(*)::integer from ledger.money_accounts) as accounts,
        (select count(*)::integer from ledger.accounting_periods) as periods,
        (select count(*)::integer from ledger.money_movements) as movements
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    const state = approval.rows[0];
    if (
      state?.databaseName !== environment.databaseName ||
      !state.isSuperuser ||
      state.users !== 0 ||
      state.stores !== 0 ||
      state.accounts !== 0 ||
      state.periods !== 0 ||
      state.movements !== 0
    ) {
      throw new Error('The local Money Account mutation fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    for (const key of Object.keys(fixture.stores) as AccessKey[]) {
      await adminPool.query(
        `insert into ledger.stores (id, name, status) values ($1, $2, 'active')`,
        [fixture.stores[key], `Task 8.4 ${key} store`],
      );
      await adminPool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1, $2, $2, $3, $4, 'active')`,
        [fixture.users[key], fixture.emails[key], passwordHash, `Task 8.4 ${key}`],
      );
      const role: MembershipRole = key === 'viewer' ? 'viewer' : 'owner';
      await adminPool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, $4, 'active')`,
        [fixture.memberships[key], fixture.stores[key], fixture.users[key], role],
      );
    }

    for (const [id, storeId] of [
      [fixture.accounts.ownerCash, fixture.stores.ownerA],
      [fixture.accounts.foreignCash, fixture.stores.ownerB],
      [fixture.accounts.readOnlyCash, fixture.stores.readOnly],
      [fixture.accounts.viewerCash, fixture.stores.viewer],
      [fixture.accounts.flipCash, fixture.stores.flip],
      [fixture.accounts.balanceCash, fixture.stores.balance],
    ] as const) {
      await insertAccount({
        id,
        storeId,
        name: SYSTEM_CASH_MONEY_ACCOUNT.name,
        normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
        accountType: 'cash',
        isDefault: true,
      });
    }
    await insertAccount({
      id: fixture.accounts.invalidCash,
      storeId: fixture.stores.invalid,
      name: 'Invalid Cash',
      normalizedName: 'invalid cash',
      accountType: 'cash',
      isDefault: false,
    });
    await insertAccount({
      id: fixture.accounts.external,
      storeId: fixture.stores.ownerA,
      name: 'Hidden External Party',
      normalizedName: 'hidden external party',
      accountType: 'external_party',
    });
    await insertAccount({
      id: fixture.accounts.held,
      storeId: fixture.stores.ownerA,
      name: 'Held Transfer',
      normalizedName: 'held transfer',
      accountType: 'transfer',
      availability: 'held_by_external_party',
    });
    await insertAccount({
      id: fixture.accounts.foreignTransfer,
      storeId: fixture.stores.ownerB,
      name: 'Foreign Transfer',
      normalizedName: 'foreign transfer',
      accountType: 'transfer',
    });
    await insertAccount({
      id: fixture.accounts.positive,
      storeId: fixture.stores.balance,
      name: 'Positive Account',
      normalizedName: 'positive account',
      accountType: 'transfer',
    });
    await insertAccount({
      id: fixture.accounts.negative,
      storeId: fixture.stores.balance,
      name: 'Negative Account',
      normalizedName: 'negative account',
      accountType: 'transfer',
    });
    await adminPool.query(
      `insert into ledger.accounting_periods (
         id, store_id, period_year, period_month, starts_at, ends_at, status, operation_id
       ) values ($1, $2, 2026, 9, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'open', $3)`,
      [fixture.period, fixture.stores.balance, randomUUID()],
    );
    for (const [id, accountId, amount] of [
      [fixture.movements.positive, fixture.accounts.positive, '500'],
      [fixture.movements.negative, fixture.accounts.negative, '-500'],
    ] as const) {
      await adminPool.query(
        `insert into ledger.money_movements (
           id, store_id, account_id, accounting_period_id, movement_type,
           amount_delta_minor, reference_type, reference_id, transaction_group_id,
           occurred_at, operation_id
         ) values ($1, $2, $3, $4, 'other', $5::bigint, 'task_8_4_fixture', $6, $7,
                   '2026-09-01T12:00:00Z', $8)`,
        [
          id,
          fixture.stores.balance,
          accountId,
          fixture.period,
          amount,
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ],
      );
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();
    initializer = nestApp.get(SystemCashProvisioningService);
    repository = nestApp.get(MoneyAccountWriteRepository);
    moneyAccountWrites = nestApp.get(MoneyAccountWriteService);

    for (const key of Object.keys(fixture.emails) as AccessKey[]) {
      access[key] = await login(key);
    }
    await adminPool.query(
      `insert into ledger.devices (
         id, store_id, device_name, platform, installation_id, device_prefix, status
       ) values ($1, $2, 'Task 8.4 trusted second device', 'android', $3, 't84b', 'active')`,
      [fixture.devices.ownerASecond, fixture.stores.ownerA, randomUUID()],
    );
    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.readOnly,
    ]);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) {
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `select (
         (select count(*) from ledger.stores where id = any($1::uuid[]))
         + (select count(*) from platform.users where id = any($2::uuid[]))
         + (select count(*) from platform.store_memberships where id = any($3::uuid[]))
         + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
         + (select count(*) from ledger.money_accounts where store_id = any($1::uuid[]))
         + (select count(*) from ledger.accounting_periods where store_id = any($1::uuid[]))
         + (select count(*) from ledger.money_movements where store_id = any($1::uuid[]))
         + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
         + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
         + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
         + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
       )::integer as count`,
      [storeIds, userIds, membershipIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end()]);
  }, 30_000);

  it('enforces authentication, Owner authorization, read_only, and exact DTOs', async () => {
    await request(server)
      .post('/v1/money-accounts')
      .send(createPayload('Unauthorized'))
      .expect(401);
    await authorizedPost(access.viewer)
      .send(createPayload('Viewer Account'))
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_WRITE_NOT_ALLOWED' });
      });
    await authorizedPost(access.readOnly)
      .send(createPayload('Read Only Account'))
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' });
      });
    await authorizedPost(access.ownerA)
      .send({ ...createPayload('Injected Type'), accountType: 'cash' })
      .expect(400);
    await authorizedPost(access.ownerA)
      .send({ id: 'invalid', operationId: randomUUID(), name: 'Invalid UUID' })
      .expect(400);
    await authorizedPost(access.ownerA)
      .send({ id: randomUUID(), operationId: randomUUID(), name: '   ' })
      .expect(400);
  });

  it('creates, preserves, and converges the internal system Cash while failing closed', async () => {
    expect(await readCashRows(fixture.stores.ensure)).toEqual([]);
    const ensureContext = tenantContext(access.ensure);
    const first = await initializer.ensureForStore(ensureContext);
    expect(first).toMatchObject({
      name: SYSTEM_CASH_MONEY_ACCOUNT.name,
      normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
      accountType: 'cash',
      availability: 'available',
      isDefault: true,
      status: 'active',
      archivedAt: null,
      version: 1n,
    });
    const second = await initializer.ensureForStore({ ...ensureContext, requestId: randomUUID() });
    expect(second).toEqual(first);
    const persisted = await readCashRows(fixture.stores.ensure);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: first.id,
      deviceId: null,
      version: '1',
      name: SYSTEM_CASH_MONEY_ACCOUNT.name,
      normalizedName: SYSTEM_CASH_NORMALIZED_NAME,
      accountType: 'cash',
      availability: 'available',
      isDefault: true,
      status: 'active',
      archivedAt: null,
    });

    const concurrentContext = tenantContext(access.concurrent);
    const concurrent = await Promise.all([
      initializer.ensureForStore(concurrentContext),
      initializer.ensureForStore({ ...concurrentContext, requestId: randomUUID() }),
    ]);
    expect(concurrent[0].id).toBe(concurrent[1].id);
    expect(await readCashRows(fixture.stores.concurrent)).toHaveLength(1);

    const invalidBefore = await readCashRows(fixture.stores.invalid);
    await expect(initializer.ensureForStore(tenantContext(access.invalid))).rejects.toBeInstanceOf(
      SystemCashInvariantError,
    );
    expect(await readCashRows(fixture.stores.invalid)).toEqual(invalidBefore);
  });

  it('never bootstraps Cash from GET or public create and preserves rejected replay', async () => {
    const list = await authorizedGet(access.missing).expect(200);
    expect(responseBody(list).items).toEqual([]);
    expect(await readCashRows(fixture.stores.missing)).toEqual([]);

    const payload = createPayload('Needs Cash');
    const first = await authorizedPost(access.missing).send(payload).expect(409);
    expect(first.body).toMatchObject({ code: 'MONEY_ACCOUNT_NOT_INITIALIZED' });
    expect(await readAccount(payload.id)).toBeNull();
    expect(await readCashRows(fixture.stores.missing)).toEqual([]);
    expect(await readOperation(fixture.stores.missing, payload.operationId)).toMatchObject({
      status: 'rejected',
      responseCode: 409,
      errorCode: 'MONEY_ACCOUNT_NOT_INITIALIZED',
      completed: true,
    });

    await initializer.ensureForStore(tenantContext(access.missing));
    const replay = await authorizedPost(access.missing).send(payload).expect(409);
    expect(withoutTraceFields(replay.body)).toEqual(withoutTraceFields(first.body));
    expect(await readAccount(payload.id)).toBeNull();

    const succeeding = { ...payload, operationId: randomUUID() };
    await authorizedPost(access.missing).send(succeeding).expect(201);
    expect(await readAccount(payload.id)).toMatchObject({
      id: payload.id,
      storeId: fixture.stores.missing,
      accountType: 'transfer',
      availability: 'available',
      isDefault: false,
      status: 'active',
    });
  });

  it('creates only exact public Electronic state and enforces idempotency/device binding', async () => {
    const payload = createPayload('  Main   Bank  ');
    const firstResponse = await authorizedPost(access.ownerA).send(payload).expect(201);
    const first = mutationBody(firstResponse);
    expect(Object.keys(first).sort()).toEqual([
      'accountType',
      'archivedAt',
      'createdAt',
      'id',
      'isDefault',
      'name',
      'operationId',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(first).toMatchObject({
      id: payload.id,
      name: 'Main Bank',
      accountType: 'transfer',
      isDefault: false,
      status: 'active',
      archivedAt: null,
      version: '1',
      operationId: payload.operationId,
    });
    expect(await readAccount(payload.id)).toMatchObject({
      storeId: fixture.stores.ownerA,
      normalizedName: 'main bank',
      accountType: 'transfer',
      availability: 'available',
      isDefault: false,
      status: 'active',
      archivedAt: null,
      deviceId: access.ownerA.deviceId,
      operationId: payload.operationId,
      version: '1',
    });

    const replay = mutationBody(await authorizedPost(access.ownerA).send(payload).expect(201));
    expect(replay).toEqual(first);
    await authorizedPost(access.ownerA)
      .send({ ...payload, name: 'Changed Request' })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    await expect(
      moneyAccountWrites.create(
        {
          membershipRole: 'owner',
          storeId: fixture.stores.ownerA,
          userId: fixture.users.ownerA,
          deviceId: fixture.devices.ownerASecond,
        },
        {
          storeId: fixture.stores.ownerA,
          userId: fixture.users.ownerA,
          deviceId: fixture.devices.ownerASecond,
          requestId: randomUUID(),
        },
        payload,
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
    expect(
      await countRows(
        `select count(*)::integer as count from ledger.money_movements where store_id = $1`,
        [fixture.stores.ownerA],
      ),
    ).toBe(0);
  });

  it('reserves normalized names across lifecycle and scopes concurrent uniqueness by Store', async () => {
    const ownerPayload = createPayload('Shared Wallet');
    const foreignPayload = createPayload('Shared Wallet');
    const ownerCreated = mutationBody(
      await authorizedPost(access.ownerA).send(ownerPayload).expect(201),
    );
    await authorizedPost(access.ownerB).send(foreignPayload).expect(201);
    await authorizedPost(access.ownerA)
      .send(createPayload('  shared   wallet  '))
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_NAME_CONFLICT' }));

    await lifecycle(access.ownerA, ownerPayload.id, 'archive')
      .send({ operationId: randomUUID(), expectedVersion: ownerCreated.version })
      .expect(200);
    await authorizedPost(access.ownerA)
      .send(createPayload('SHARED WALLET'))
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_NAME_CONFLICT' }));

    const concurrentName = 'Concurrent Wallet';
    const concurrentResponses = await Promise.all([
      authorizedPost(access.ownerA).send(createPayload(concurrentName)),
      authorizedPost(access.ownerA).send(createPayload(concurrentName)),
    ]);
    expect(concurrentResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(concurrentResponses.find((response) => response.status === 409)?.body).toMatchObject({
      code: 'MONEY_ACCOUNT_NAME_CONFLICT',
    });
    expect(
      await countRows(
        `select count(*)::integer as count from ledger.money_accounts
         where store_id = $1 and normalized_name = 'concurrent wallet'`,
        [fixture.stores.ownerA],
      ),
    ).toBe(1);
  });

  it('converges concurrent exact retries and preserves explicit processing state', async () => {
    const payload = createPayload('Concurrent Replay');
    const responses = await Promise.all([
      authorizedPost(access.ownerA).send(payload),
      authorizedPost(access.ownerA).send(payload),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(
      await countRows(
        `select count(*)::integer as count from ledger.money_accounts where id = $1`,
        [payload.id],
      ),
    ).toBe(1);
    expect(
      await countRows(
        `select count(*)::integer as count from sync.processed_operations
         where store_id = $1 and operation_id = $2`,
        [fixture.stores.ownerA, payload.operationId],
      ),
    ).toBe(1);

    const processing = createPayload('Processing Account');
    await adminPool.query(
      `insert into sync.processed_operations (
         store_id, operation_id, device_id, aggregate_type, aggregate_id,
         action, request_hash, status
       ) values ($1, $2, $3, 'money_accounts', $4, 'create', $5, 'processing')`,
      [
        fixture.stores.ownerA,
        processing.operationId,
        fixture.devices.ownerA,
        processing.id,
        createFingerprint(processing),
      ],
    );
    await authorizedPost(access.ownerA)
      .send(processing)
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_IN_PROGRESS' }));
    expect(await readAccount(processing.id)).toBeNull();
  });

  it('allows authenticated historical replay in read_only but rejects new writes', async () => {
    const payload = createPayload('Flip Account');
    const created = mutationBody(await authorizedPost(access.flip).send(payload).expect(201));
    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.flip,
    ]);
    try {
      const replay = mutationBody(await authorizedPost(access.flip).send(payload).expect(201));
      expect(replay).toEqual(created);
      await authorizedPost(access.flip)
        .send(createPayload('Denied New Account'))
        .expect(403)
        .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));
    } finally {
      await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
        fixture.stores.flip,
      ]);
    }
  });

  it('archives/restores exactly once, validates version before no-op, and replays history', async () => {
    const payload = createPayload('Lifecycle Account');
    const created = mutationBody(await authorizedPost(access.ownerA).send(payload).expect(201));
    const archivePayload = { operationId: randomUUID(), expectedVersion: created.version };
    const archived = mutationBody(
      await lifecycle(access.ownerA, payload.id, 'archive').send(archivePayload).expect(200),
    );
    expect(archived).toMatchObject({
      id: created.id,
      name: created.name,
      status: 'archived',
      version: '2',
    });
    expect(archived.archivedAt).not.toBeNull();
    const effectsAfterArchive = await readEffects(fixture.stores.ownerA, payload.id);

    const archiveNoOp = mutationBody(
      await lifecycle(access.ownerA, payload.id, 'archive')
        .send({ operationId: randomUUID(), expectedVersion: archived.version })
        .expect(200),
    );
    expect(archiveNoOp.version).toBe(archived.version);
    expect(await readEffects(fixture.stores.ownerA, payload.id)).toEqual(effectsAfterArchive);

    await lifecycle(access.ownerA, payload.id, 'restore')
      .send({ operationId: randomUUID(), expectedVersion: created.version })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_VERSION_CONFLICT' }));
    const beforeRestore = await readAccount(payload.id);
    const restored = mutationBody(
      await lifecycle(access.ownerA, payload.id, 'restore')
        .send({ operationId: randomUUID(), expectedVersion: archived.version })
        .expect(200),
    );
    expect(restored).toMatchObject({ status: 'active', archivedAt: null, version: '3' });
    expect(restored.id).toBe(created.id);
    expect(beforeRestore?.id).toBe(restored.id);
    const effectsAfterRestore = await readEffects(fixture.stores.ownerA, payload.id);

    const restoreNoOp = mutationBody(
      await lifecycle(access.ownerA, payload.id, 'restore')
        .send({ operationId: randomUUID(), expectedVersion: restored.version })
        .expect(200),
    );
    expect(restoreNoOp.version).toBe(restored.version);
    expect(await readEffects(fixture.stores.ownerA, payload.id)).toEqual(effectsAfterRestore);

    const historical = mutationBody(
      await lifecycle(access.ownerA, payload.id, 'archive').send(archivePayload).expect(200),
    );
    expect(historical).toEqual(archived);
    expect((await readAccount(payload.id))?.status).toBe('active');
  });

  it('keeps Cash immutable and hides internal, held, foreign, and absent lifecycle targets', async () => {
    await lifecycle(access.ownerA, fixture.accounts.ownerCash, 'archive')
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_CASH_IMMUTABLE' }));

    const absent = await lifecycle(access.ownerA, randomUUID(), 'archive')
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(404);
    for (const hiddenId of [
      fixture.accounts.external,
      fixture.accounts.held,
      fixture.accounts.foreignTransfer,
    ]) {
      const hidden = await lifecycle(access.ownerA, hiddenId, 'archive')
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(404);
      expect(withoutTraceFields(hidden.body)).toEqual(withoutTraceFields(absent.body));
    }
    expect(absent.body).toMatchObject({ code: 'MONEY_ACCOUNT_NOT_FOUND' });
  });

  it('uses the authoritative balance view and rejects positive or negative balances unchanged', async () => {
    for (const id of [fixture.accounts.positive, fixture.accounts.negative]) {
      const before = await readAccount(id);
      const effects = await readEffects(fixture.stores.balance, id);
      await lifecycle(access.balance, id, 'archive')
        .send({ operationId: randomUUID(), expectedVersion: before?.version })
        .expect(409)
        .expect(({ body }) =>
          expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_NON_ZERO_BALANCE' }),
        );
      expect(await readAccount(id)).toEqual(before);
      expect(await readEffects(fixture.stores.balance, id)).toEqual(effects);
    }
  });

  it('uses least-privileged forced RLS and fails closed without trusted tenant context', async () => {
    if (!environment || !app) {
      throw new Error('The Money Account integration application is unavailable.');
    }
    const state = await runtimePool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      ownsTable: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        current_user as "currentUser", role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        pg_get_userbyid(account_table.relowner) = current_user as "ownsTable",
        account_table.relrowsecurity as "rlsEnabled",
        account_table.relforcerowsecurity as "rlsForced"
      from pg_roles as role_state
      cross join pg_class as account_table
      where role_state.rolname = current_user
        and account_table.oid = 'ledger.money_accounts'::regclass
    `);
    expect(state.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      ownsTable: false,
      rlsEnabled: true,
      rlsForced: true,
    });
    expect(
      (
        await runtimePool.query<{ count: number }>(
          `select count(*)::integer as count from ledger.money_accounts
           where id = any($1::uuid[])`,
          [[fixture.accounts.ownerCash, fixture.accounts.foreignTransfer]],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await runtimePool.query(
          `update ledger.money_accounts set name = 'Forbidden'
           where id = $1 returning id`,
          [fixture.accounts.ownerCash],
        )
      ).rowCount,
    ).toBe(0);

    const database = app.get(DatabaseService);
    const visible = await database.withTenantTransaction(
      tenantContext(access.ownerA),
      (transaction) =>
        transaction.execute<{ id: string }>(sql`
          select id from ledger.money_accounts
          where id = ${fixture.accounts.foreignTransfer}::uuid
        `),
    );
    expect(visible.rows).toEqual([]);
  });

  it('rolls back create and lifecycle state when operation completion fails', async () => {
    const create = createPayload('Rollback Create');
    const createCompletion = jest
      .spyOn(
        repository as unknown as { applyOperation: (...arguments_: unknown[]) => Promise<void> },
        'applyOperation',
      )
      .mockRejectedValueOnce(new Error('Task 8.4 create completion fault'));
    try {
      await authorizedPost(access.ownerA).send(create).expect(500);
    } finally {
      createCompletion.mockRestore();
    }
    expect(await readAccount(create.id)).toBeNull();
    expect(await readOperation(fixture.stores.ownerA, create.operationId)).toBeNull();
    expect(await readEffects(fixture.stores.ownerA, create.id)).toEqual({
      changeEvents: 0,
      auditLogs: 0,
    });

    const lifecycleTarget = createPayload('Rollback Lifecycle');
    await authorizedPost(access.ownerA).send(lifecycleTarget).expect(201);
    const before = await readAccount(lifecycleTarget.id);
    const effects = await readEffects(fixture.stores.ownerA, lifecycleTarget.id);
    const operationId = randomUUID();
    const lifecycleCompletion = jest
      .spyOn(
        repository as unknown as { applyOperation: (...arguments_: unknown[]) => Promise<void> },
        'applyOperation',
      )
      .mockRejectedValueOnce(new Error('Task 8.4 lifecycle completion fault'));
    try {
      await lifecycle(access.ownerA, lifecycleTarget.id, 'archive')
        .send({ operationId, expectedVersion: before?.version })
        .expect(500);
    } finally {
      lifecycleCompletion.mockRestore();
    }
    expect(await readAccount(lifecycleTarget.id)).toEqual(before);
    expect(await readOperation(fixture.stores.ownerA, operationId)).toBeNull();
    expect(await readEffects(fixture.stores.ownerA, lifecycleTarget.id)).toEqual(effects);
  });
});
