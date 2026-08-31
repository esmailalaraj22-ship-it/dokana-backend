import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { moneyAccounts } from '../src/database/schema';
import type { TenantTransactionContext } from '../src/database/database.types';
import { MoneyAccountReadRepository } from '../src/money-accounts/money-account-read.repository';
import type {
  MoneyAccountListResponse,
  MoneyAccountResponse,
} from '../src/money-accounts/money-account-read.types';
import type {
  MoneyAccountPhysicalAvailability,
  MoneyAccountPhysicalType,
  MoneyAccountStatus,
} from '../src/money-accounts/money-account.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    ownerA: '83000000-0000-4000-8000-000000000001',
    ownerB: '83000000-0000-4000-8000-000000000002',
    readOnly: '83000000-0000-4000-8000-000000000003',
    manager: '83000000-0000-4000-8000-000000000004',
    viewer: '83000000-0000-4000-8000-000000000005',
    support: '83000000-0000-4000-8000-000000000006',
  },
  users: {
    ownerA: '83100000-0000-4000-8000-000000000001',
    ownerB: '83100000-0000-4000-8000-000000000002',
    readOnly: '83100000-0000-4000-8000-000000000003',
    manager: '83100000-0000-4000-8000-000000000004',
    viewer: '83100000-0000-4000-8000-000000000005',
    support: '83100000-0000-4000-8000-000000000006',
  },
  memberships: {
    ownerA: '83200000-0000-4000-8000-000000000001',
    ownerB: '83200000-0000-4000-8000-000000000002',
    readOnly: '83200000-0000-4000-8000-000000000003',
    manager: '83200000-0000-4000-8000-000000000004',
    viewer: '83200000-0000-4000-8000-000000000005',
    support: '83200000-0000-4000-8000-000000000006',
  },
  devices: {
    ownerA: '83300000-0000-4000-8000-000000000001',
    ownerB: '83300000-0000-4000-8000-000000000002',
    readOnly: '83300000-0000-4000-8000-000000000003',
    manager: '83300000-0000-4000-8000-000000000004',
    viewer: '83300000-0000-4000-8000-000000000005',
    support: '83300000-0000-4000-8000-000000000006',
  },
  emails: {
    ownerA: 'task83-owner-a@example.test',
    ownerB: 'task83-owner-b@example.test',
    readOnly: 'task83-read-only@example.test',
    manager: 'task83-manager@example.test',
    viewer: 'task83-viewer@example.test',
    support: 'task83-support@example.test',
  },
  password: 'Task-8.3-Test-Password!',
  accounts: {
    cash: '83400000-0000-4000-8000-000000000001',
    alpha: '83400000-0000-4000-8000-000000000002',
    beta: '83400000-0000-4000-8000-000000000003',
    archived: '83400000-0000-4000-8000-000000000004',
    external: '83400000-0000-4000-8000-000000000005',
    held: '83400000-0000-4000-8000-000000000006',
    foreignCash: '83400000-0000-4000-8000-000000000101',
    foreignTransfer: '83400000-0000-4000-8000-000000000102',
    readOnlyTransfer: '83400000-0000-4000-8000-000000000201',
  },
};

type AccessKey = keyof typeof fixture.emails;

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface MoneyAccountFixtureRecord {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  accountType: MoneyAccountPhysicalType;
  availability?: MoneyAccountPhysicalAvailability;
  isDefault?: boolean;
  status?: MoneyAccountStatus;
  version?: string;
}

interface ReadSideEffects {
  processedOperations: number;
  changeEvents: number;
  auditLogs: number;
  moneyMovements: number;
  moneyAccounts: number;
}

interface MoneyAccountState {
  id: string;
  version: string;
  updatedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class SynchronousLogCapture implements DestinationStream {
  private output = '';

  write(message: string): void {
    this.output += message;
  }
}

function readList(response: Response): MoneyAccountListResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Expected a Money Account list response.');
  }
  return body as unknown as MoneyAccountListResponse;
}

function readDetail(response: Response): MoneyAccountResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.id !== 'string') {
    throw new Error('Expected a Money Account detail response.');
  }
  return body as unknown as MoneyAccountResponse;
}

function readAccessToken(response: Response): string {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.accessToken !== 'string') {
    throw new Error('Expected an access token.');
  }
  return body.accessToken;
}

function withoutTraceFields(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  const stable = { ...body };
  delete stable.requestId;
  delete stable.timestamp;
  delete stable.path;
  return stable;
}

describe('Money Account read API with real PostgreSQL', () => {
  const logCapture = new SynchronousLogCapture();
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<AccessKey, AccessIdentity>;
  let sideEffectsAfterLogin: ReadSideEffects;
  let accountStateAfterLogin: MoneyAccountState[];

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const accountIds = Object.values(fixture.accounts);

  const accountRecords: MoneyAccountFixtureRecord[] = [
    {
      id: fixture.accounts.cash,
      storeId: fixture.stores.ownerA,
      name: 'الصندوق',
      normalizedName: 'الصندوق',
      accountType: 'cash',
      isDefault: true,
    },
    {
      id: fixture.accounts.alpha,
      storeId: fixture.stores.ownerA,
      name: 'Alpha Wallet',
      normalizedName: 'alpha wallet',
      accountType: 'transfer',
      version: '9007199254740993',
    },
    {
      id: fixture.accounts.beta,
      storeId: fixture.stores.ownerA,
      name: 'Beta Bank',
      normalizedName: 'beta bank',
      accountType: 'transfer',
    },
    {
      id: fixture.accounts.archived,
      storeId: fixture.stores.ownerA,
      name: 'Archived Wallet',
      normalizedName: 'archived wallet',
      accountType: 'transfer',
      status: 'archived',
    },
    {
      id: fixture.accounts.external,
      storeId: fixture.stores.ownerA,
      name: 'Internal External Party',
      normalizedName: 'internal external party',
      accountType: 'external_party',
    },
    {
      id: fixture.accounts.held,
      storeId: fixture.stores.ownerA,
      name: 'Held Transfer',
      normalizedName: 'held transfer',
      accountType: 'transfer',
      availability: 'held_by_external_party',
    },
    {
      id: fixture.accounts.foreignCash,
      storeId: fixture.stores.ownerB,
      name: 'الصندوق',
      normalizedName: 'الصندوق',
      accountType: 'cash',
      isDefault: true,
    },
    {
      id: fixture.accounts.foreignTransfer,
      storeId: fixture.stores.ownerB,
      name: 'Foreign Wallet',
      normalizedName: 'foreign wallet',
      accountType: 'transfer',
    },
    {
      id: fixture.accounts.readOnlyTransfer,
      storeId: fixture.stores.readOnly,
      name: 'Read Only Wallet',
      normalizedName: 'read only wallet',
      accountType: 'transfer',
    },
  ];

  async function removeFixtures(): Promise<void> {
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
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
    await adminPool.query(`delete from ledger.money_accounts where id = any($1::uuid[])`, [
      accountIds,
    ]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function insertMoneyAccount(
    record: MoneyAccountFixtureRecord,
    index: number,
  ): Promise<void> {
    await adminPool.query(
      `
        insert into ledger.money_accounts (
          id, store_id, name, normalized_name, account_type, availability,
          is_default, status, archived_at, operation_id, created_at, updated_at, version
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          case when $8 = 'archived' then '2026-08-20T10:00:00Z'::timestamptz else null end,
          $9, '2026-08-01T08:00:00Z'::timestamptz,
          '2026-08-25T09:30:00Z'::timestamptz, $10::bigint
        )
      `,
      [
        record.id,
        record.storeId,
        record.name,
        record.normalizedName,
        record.accountType,
        record.availability ?? 'available',
        record.isDefault ?? false,
        record.status ?? 'active',
        `83500000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        record.version ?? '1',
      ],
    );
  }

  async function login(key: AccessKey): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: fixture.stores[key],
        deviceId: fixture.devices[key],
        deviceName: `Task 8.3 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    return {
      accessToken: readAccessToken(response),
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function authorizedGet(identity: AccessIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  async function readSideEffects(): Promise<ReadSideEffects> {
    const result = await adminPool.query<ReadSideEffects>(
      `
        select
          (select count(*)::integer from sync.processed_operations
            where store_id = any($1::uuid[])) as "processedOperations",
          (select count(*)::integer from sync.change_events
            where store_id = any($1::uuid[])) as "changeEvents",
          (select count(*)::integer from audit.central_audit_logs
            where store_id = any($1::uuid[])) as "auditLogs",
          (select count(*)::integer from ledger.money_movements
            where store_id = any($1::uuid[])) as "moneyMovements",
          (select count(*)::integer from ledger.money_accounts
            where store_id = any($1::uuid[])) as "moneyAccounts"
      `,
      [storeIds],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Expected Money Account read side-effect counts.');
    }
    return row;
  }

  async function readAccountState(): Promise<MoneyAccountState[]> {
    const result = await adminPool.query<MoneyAccountState>(
      `
        select id::text, version::text, updated_at as "updatedAt"
        from ledger.money_accounts
        where id = any($1::uuid[])
        order by id
      `,
      [accountIds],
    );
    return result.rows;
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task83-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-task83-runtime-inspection',
      1,
    );
    poolsInitialized = true;

    const approvedDatabase = await adminPool.query<{ databaseName: string; isSuperuser: boolean }>(`
      select current_database() as "databaseName", role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    if (
      approvedDatabase.rows[0]?.databaseName !== environment.databaseName ||
      !approvedDatabase.rows[0].isSuperuser
    ) {
      throw new Error('The local Money Account fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 8.3 Store A', 'active'),
          ($2, 'Task 8.3 Store B', 'active'),
          ($3, 'Task 8.3 Read Only', 'read_only'),
          ($4, 'Task 8.3 Manager', 'active'),
          ($5, 'Task 8.3 Viewer', 'active'),
          ($6, 'Task 8.3 Support', 'active')
      `,
      storeIds,
    );
    await adminPool.query(
      `
        insert into platform.users (
          id, email, normalized_email, password_hash, full_name, status
        )
        values
          ($1, $2, $2, $13, 'Task 8.3 Owner A', 'active'),
          ($3, $4, $4, $13, 'Task 8.3 Owner B', 'active'),
          ($5, $6, $6, $13, 'Task 8.3 Read Only Owner', 'active'),
          ($7, $8, $8, $13, 'Task 8.3 Manager', 'active'),
          ($9, $10, $10, $13, 'Task 8.3 Viewer', 'active'),
          ($11, $12, $12, $13, 'Task 8.3 Support', 'active')
      `,
      [
        fixture.users.ownerA,
        fixture.emails.ownerA,
        fixture.users.ownerB,
        fixture.emails.ownerB,
        fixture.users.readOnly,
        fixture.emails.readOnly,
        fixture.users.manager,
        fixture.emails.manager,
        fixture.users.viewer,
        fixture.emails.viewer,
        fixture.users.support,
        fixture.emails.support,
        passwordHash,
      ],
    );
    await adminPool.query(
      `
        insert into platform.store_memberships (id, store_id, user_id, role, status)
        values
          ($1, $2, $3, 'owner', 'active'),
          ($4, $5, $6, 'owner', 'active'),
          ($7, $8, $9, 'owner', 'active'),
          ($10, $11, $12, 'manager', 'active'),
          ($13, $14, $15, 'viewer', 'active'),
          ($16, $17, $18, 'support', 'active')
      `,
      [
        fixture.memberships.ownerA,
        fixture.stores.ownerA,
        fixture.users.ownerA,
        fixture.memberships.ownerB,
        fixture.stores.ownerB,
        fixture.users.ownerB,
        fixture.memberships.readOnly,
        fixture.stores.readOnly,
        fixture.users.readOnly,
        fixture.memberships.manager,
        fixture.stores.manager,
        fixture.users.manager,
        fixture.memberships.viewer,
        fixture.stores.viewer,
        fixture.users.viewer,
        fixture.memberships.support,
        fixture.stores.support,
        fixture.users.support,
      ],
    );
    for (const [index, account] of accountRecords.entries()) {
      await insertMoneyAccount(account, index + 1);
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config, logCapture),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();

    access = {
      ownerA: await login('ownerA'),
      ownerB: await login('ownerB'),
      readOnly: await login('readOnly'),
      manager: await login('manager'),
      viewer: await login('viewer'),
      support: await login('support'),
    };
    sideEffectsAfterLogin = await readSideEffects();
    accountStateAfterLogin = await readAccountState();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) {
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `
        select (
          (select count(*) from ledger.stores where id = any($1::uuid[]))
          + (select count(*) from platform.users where id = any($2::uuid[]))
          + (select count(*) from platform.store_memberships where id = any($3::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_accounts where id = any($4::uuid[]))
          + (select count(*) from ledger.money_movements where store_id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds, accountIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  }, 30_000);

  it('requires authentication and owner authority while allowing read-only owner reads', async () => {
    await request(server).get('/v1/money-accounts').expect(401);
    for (const role of ['manager', 'viewer', 'support'] as const) {
      await authorizedGet(access[role], '/v1/money-accounts')
        .expect(403)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'MONEY_ACCOUNT_READ_NOT_ALLOWED' });
        });
      await authorizedGet(access[role], `/v1/money-accounts/${fixture.accounts.cash}`).expect(403);
    }

    const readOnly = readList(
      await authorizedGet(access.readOnly, '/v1/money-accounts').expect(200),
    );
    expect(readOnly.items.map((item) => item.id)).toEqual([fixture.accounts.readOnlyTransfer]);
  });

  it('validates the exact status-only query grammar and Money Account UUID', async () => {
    for (const query of [
      { status: 'all' },
      { status: '' },
      { includeArchived: 'true' },
      { search: 'wallet' },
      { limit: '10' },
      { storeId: fixture.stores.ownerB },
      { unexpected: 'value' },
    ]) {
      await authorizedGet(access.ownerA, '/v1/money-accounts').query(query).expect(400);
    }
    await authorizedGet(access.ownerA, '/v1/money-accounts?status=active&status=active').expect(
      400,
    );
    await authorizedGet(access.ownerA, '/v1/money-accounts/not-a-uuid').expect(400);
  });

  it('lists visible accounts by Cash, normalized name, and UUID with a minimal projection', async () => {
    const active = readList(await authorizedGet(access.ownerA, '/v1/money-accounts').expect(200));
    expect(active.items.map((item) => item.id)).toEqual([
      fixture.accounts.cash,
      fixture.accounts.alpha,
      fixture.accounts.beta,
    ]);
    expect(active.items.find((item) => item.id === fixture.accounts.alpha)?.version).toBe(
      '9007199254740993',
    );
    for (const item of active.items) {
      expect(Object.keys(item).sort()).toEqual([
        'accountType',
        'archivedAt',
        'createdAt',
        'id',
        'isDefault',
        'name',
        'status',
        'updatedAt',
        'version',
      ]);
      expect(item).not.toHaveProperty('balance');
      expect(item).not.toHaveProperty('movements');
      expect(item).not.toHaveProperty('normalizedName');
      expect(item).not.toHaveProperty('storeId');
      expect(item).not.toHaveProperty('deviceId');
      expect(item).not.toHaveProperty('operationId');
    }

    const explicitActive = readList(
      await authorizedGet(access.ownerA, '/v1/money-accounts')
        .query({ status: 'active' })
        .expect(200),
    );
    expect(explicitActive).toEqual(active);

    const archived = readList(
      await authorizedGet(access.ownerA, '/v1/money-accounts')
        .query({ status: 'archived' })
        .expect(200),
    );
    expect(archived.items.map((item) => item.id)).toEqual([fixture.accounts.archived]);
  });

  it('returns supported active and archived detail with UTC/lossless values', async () => {
    const cash = readDetail(
      await authorizedGet(access.ownerA, `/v1/money-accounts/${fixture.accounts.cash}`).expect(200),
    );
    expect(cash).toEqual({
      id: fixture.accounts.cash,
      name: 'الصندوق',
      accountType: 'cash',
      isDefault: true,
      status: 'active',
      archivedAt: null,
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-08-25T09:30:00.000Z',
      version: '1',
    });

    const archived = readDetail(
      await authorizedGet(
        access.ownerA,
        `/v1/money-accounts/${fixture.accounts.archived.toUpperCase()}`,
      ).expect(200),
    );
    expect(archived).toMatchObject({
      id: fixture.accounts.archived,
      accountType: 'transfer',
      status: 'archived',
      archivedAt: '2026-08-20T10:00:00.000Z',
    });
  });

  it('makes foreign, absent, external-party, and held detail indistinguishable', async () => {
    const absent = await authorizedGet(access.ownerA, `/v1/money-accounts/${randomUUID()}`).expect(
      404,
    );
    for (const hiddenId of [
      fixture.accounts.foreignTransfer,
      fixture.accounts.external,
      fixture.accounts.held,
    ]) {
      const hidden = await authorizedGet(access.ownerA, `/v1/money-accounts/${hiddenId}`).expect(
        404,
      );
      expect(withoutTraceFields(hidden.body)).toEqual(withoutTraceFields(absent.body));
    }
    expect(absent.body).toMatchObject({ code: 'MONEY_ACCOUNT_NOT_FOUND' });

    const forged = readList(
      await authorizedGet(access.ownerA, '/v1/money-accounts')
        .set('x-store-id', fixture.stores.ownerB)
        .expect(200),
    );
    expect(forged.items.map((item) => item.id)).toEqual([
      fixture.accounts.cash,
      fixture.accounts.alpha,
      fixture.accounts.beta,
    ]);
  });

  it('uses least-privileged forced RLS and fails closed without trusted context', async () => {
    if (!app || !environment) {
      throw new Error('The Money Account integration application is unavailable.');
    }
    const runtimeState = await runtimeInspectionPool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      rowSecurityEnabled: boolean;
      runtimeMember: boolean;
      ownsMoneyAccounts: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "runtimeMember",
        pg_get_userbyid(account_table.relowner) = current_user as "ownsMoneyAccounts",
        account_table.relrowsecurity as "rlsEnabled",
        account_table.relforcerowsecurity as "rlsForced"
      from pg_roles as role_state
      cross join pg_class as account_table
      where role_state.rolname = current_user
        and account_table.oid = 'ledger.money_accounts'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      rowSecurityEnabled: true,
      runtimeMember: true,
      ownsMoneyAccounts: false,
      rlsEnabled: true,
      rlsForced: true,
    });
    const noContext = () =>
      runtimeInspectionPool.query<{ count: number }>(
        `select count(*)::integer as count from ledger.money_accounts where id = any($1::uuid[])`,
        [accountIds],
      );
    expect((await noContext()).rows[0]?.count).toBe(0);

    const database = app.get(DatabaseService);
    const contextA: TenantTransactionContext = {
      storeId: access.ownerA.storeId,
      userId: access.ownerA.userId,
      deviceId: access.ownerA.deviceId,
      requestId: randomUUID(),
    };
    const contextB: TenantTransactionContext = {
      storeId: access.ownerB.storeId,
      userId: access.ownerB.userId,
      deviceId: access.ownerB.deviceId,
      requestId: randomUUID(),
    };
    const visible = (context: TenantTransactionContext) =>
      database.withTenantTransaction(context, (transaction) =>
        transaction
          .select({ id: moneyAccounts.id })
          .from(moneyAccounts)
          .where(
            inArray(moneyAccounts.id, [fixture.accounts.alpha, fixture.accounts.foreignTransfer]),
          ),
      );
    const [visibleA, visibleB] = await Promise.all([visible(contextA), visible(contextB)]);
    expect(visibleA).toEqual([{ id: fixture.accounts.alpha }]);
    expect(visibleB).toEqual([{ id: fixture.accounts.foreignTransfer }]);
    expect((await noContext()).rows[0]?.count).toBe(0);

    const repository = app.get(MoneyAccountReadRepository);
    await expect(
      repository.list(undefined as unknown as TenantTransactionContext, { status: 'active' }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('creates no Cash, row mutation, movement, idempotency, sync, or audit side effect', async () => {
    expect(await readSideEffects()).toEqual(sideEffectsAfterLogin);
    expect(await readAccountState()).toEqual(accountStateAfterLogin);
    const readOnlyCash = await adminPool.query<{ count: number }>(
      `
        select count(*)::integer as count
        from ledger.money_accounts
        where store_id = $1 and account_type = 'cash'
      `,
      [fixture.stores.readOnly],
    );
    expect(readOnlyCash.rows[0]?.count).toBe(0);
  });
});
