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

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { AccountingPeriodReadRepository } from '../src/accounting-periods/accounting-period-read.repository';
import type {
  AccountingPeriodListResponse,
  AccountingPeriodResponse,
} from '../src/accounting-periods/accounting-period-read.types';
import type { AccountingPeriodStatus } from '../src/accounting-periods/accounting-period.types';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { accountingPeriods } from '../src/database/schema';
import type { TenantTransactionContext } from '../src/database/database.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    ownerA: '93000000-0000-4000-8000-000000000001',
    ownerB: '93000000-0000-4000-8000-000000000002',
    readOnly: '93000000-0000-4000-8000-000000000003',
    empty: '93000000-0000-4000-8000-000000000004',
    manager: '93000000-0000-4000-8000-000000000005',
  },
  users: {
    ownerA: '93100000-0000-4000-8000-000000000001',
    ownerB: '93100000-0000-4000-8000-000000000002',
    readOnly: '93100000-0000-4000-8000-000000000003',
    empty: '93100000-0000-4000-8000-000000000004',
    manager: '93100000-0000-4000-8000-000000000005',
  },
  memberships: {
    ownerA: '93200000-0000-4000-8000-000000000001',
    ownerB: '93200000-0000-4000-8000-000000000002',
    readOnly: '93200000-0000-4000-8000-000000000003',
    empty: '93200000-0000-4000-8000-000000000004',
    manager: '93200000-0000-4000-8000-000000000005',
  },
  devices: {
    ownerA: '93300000-0000-4000-8000-000000000001',
    ownerB: '93300000-0000-4000-8000-000000000002',
    readOnly: '93300000-0000-4000-8000-000000000003',
    empty: '93300000-0000-4000-8000-000000000004',
    manager: '93300000-0000-4000-8000-000000000005',
  },
  emails: {
    ownerA: 'task93-owner-a@example.test',
    ownerB: 'task93-owner-b@example.test',
    readOnly: 'task93-read-only@example.test',
    empty: 'task93-empty@example.test',
    manager: 'task93-manager@example.test',
  },
  password: 'Task-9.3-Test-Password!',
};

const periodIds = {
  ownerAOctoberClosing: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 10),
  ownerASeptember: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 9),
  ownerAAugust: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 8),
  ownerADecember: deriveAccountingPeriodId(fixture.stores.ownerA, 2025, 12),
  ownerBSeptember: deriveAccountingPeriodId(fixture.stores.ownerB, 2026, 9),
  readOnlyJuly: deriveAccountingPeriodId(fixture.stores.readOnly, 2026, 7),
};

type AccessKey = keyof typeof fixture.emails;

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface PeriodFixtureRecord {
  id: string;
  storeId: string;
  periodYear: number;
  periodMonth: number;
  operationId: string;
  status?: AccountingPeriodStatus;
  version?: string;
}

interface ReadSideEffects {
  accountingPeriods: number;
  processedOperations: number;
  changeEvents: number;
  auditLogs: number;
}

interface PeriodState {
  id: string;
  status: AccountingPeriodStatus;
  closedAt: Date | null;
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

function readList(response: Response): AccountingPeriodListResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Expected an Accounting Period list response.');
  }
  return body as unknown as AccountingPeriodListResponse;
}

function readDetail(response: Response): AccountingPeriodResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.id !== 'string') {
    throw new Error('Expected an Accounting Period detail response.');
  }
  return body as unknown as AccountingPeriodResponse;
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

describe('Accounting Period read API with real PostgreSQL', () => {
  const logCapture = new SynchronousLogCapture();
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<AccessKey, AccessIdentity>;
  let sideEffectsAfterLogin: ReadSideEffects;
  let periodStateAfterLogin: PeriodState[];

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const allPeriodIds = Object.values(periodIds);
  const periodRecords: PeriodFixtureRecord[] = [
    {
      id: periodIds.ownerAOctoberClosing,
      storeId: fixture.stores.ownerA,
      periodYear: 2026,
      periodMonth: 10,
      operationId: '93400000-0000-4000-8000-000000000006',
      status: 'closing',
    },
    {
      id: periodIds.ownerASeptember,
      storeId: fixture.stores.ownerA,
      periodYear: 2026,
      periodMonth: 9,
      operationId: '93400000-0000-4000-8000-000000000001',
      version: '9007199254740993',
    },
    {
      id: periodIds.ownerAAugust,
      storeId: fixture.stores.ownerA,
      periodYear: 2026,
      periodMonth: 8,
      operationId: '93400000-0000-4000-8000-000000000002',
      status: 'closed',
      version: '4',
    },
    {
      id: periodIds.ownerADecember,
      storeId: fixture.stores.ownerA,
      periodYear: 2025,
      periodMonth: 12,
      operationId: '93400000-0000-4000-8000-000000000003',
    },
    {
      id: periodIds.ownerBSeptember,
      storeId: fixture.stores.ownerB,
      periodYear: 2026,
      periodMonth: 9,
      operationId: '93400000-0000-4000-8000-000000000004',
    },
    {
      id: periodIds.readOnlyJuly,
      storeId: fixture.stores.readOnly,
      periodYear: 2026,
      periodMonth: 7,
      operationId: '93400000-0000-4000-8000-000000000005',
    },
  ];

  async function removeFixtures(): Promise<void> {
    await adminPool.query('delete from platform.auth_sessions where user_id = any($1::uuid[])', [
      userIds,
    ]);
    await adminPool.query(
      'delete from sync.processed_operations where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from sync.change_events where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from audit.central_audit_logs where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from ledger.accounting_periods where id = any($1::uuid[])', [
      allPeriodIds,
    ]);
    await adminPool.query('delete from ledger.devices where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from platform.store_memberships where id = any($1::uuid[])', [
      membershipIds,
    ]);
    await adminPool.query('delete from platform.users where id = any($1::uuid[])', [userIds]);
    await adminPool.query('delete from ledger.stores where id = any($1::uuid[])', [storeIds]);
  }

  async function insertPeriod(record: PeriodFixtureRecord, index: number): Promise<void> {
    const boundaries = resolveAccountingPeriodBoundaries(record.periodYear, record.periodMonth);
    const status = record.status ?? 'open';
    await adminPool.query(
      `
        insert into ledger.accounting_periods (
          id, store_id, period_year, period_month, starts_at, ends_at, status,
          closed_at, operation_id, created_at, updated_at, version
        ) values (
          $1, $2, $3, $4, $5, $6, $7,
          case when $7 = 'closed' then '2026-09-01T10:00:00Z'::timestamptz else null end,
          $8, '2026-08-01T08:00:00Z'::timestamptz,
          ('2026-08-25T09:30:00Z'::timestamptz + ($9::integer * interval '1 second')),
          $10::bigint
        )
      `,
      [
        record.id,
        record.storeId,
        record.periodYear,
        record.periodMonth,
        boundaries.startsAt,
        boundaries.endsAt,
        status,
        record.operationId,
        index,
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
        deviceName: `Task 9.3 ${key} device`,
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
          (select count(*)::integer from ledger.accounting_periods
            where store_id = any($1::uuid[])) as "accountingPeriods",
          (select count(*)::integer from sync.processed_operations
            where store_id = any($1::uuid[])) as "processedOperations",
          (select count(*)::integer from sync.change_events
            where store_id = any($1::uuid[])) as "changeEvents",
          (select count(*)::integer from audit.central_audit_logs
            where store_id = any($1::uuid[])) as "auditLogs"
      `,
      [storeIds],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Expected Accounting Period read side-effect counts.');
    }
    return row;
  }

  async function readPeriodState(): Promise<PeriodState[]> {
    const result = await adminPool.query<PeriodState>(
      `
        select id::text, status, closed_at as "closedAt", version::text,
          updated_at as "updatedAt"
        from ledger.accounting_periods
        where id = any($1::uuid[])
        order by id
      `,
      [allPeriodIds],
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
      'dokana-task93-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-task93-runtime-inspection',
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
      throw new Error('The local Accounting Period fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 9.3 Store A', 'active'),
          ($2, 'Task 9.3 Store B', 'active'),
          ($3, 'Task 9.3 Read Only', 'read_only'),
          ($4, 'Task 9.3 Empty', 'active'),
          ($5, 'Task 9.3 Manager', 'active')
      `,
      storeIds,
    );
    await adminPool.query(
      `
        insert into platform.users (
          id, email, normalized_email, password_hash, full_name, status
        ) values
          ($1, $2, $2, $11, 'Task 9.3 Owner A', 'active'),
          ($3, $4, $4, $11, 'Task 9.3 Owner B', 'active'),
          ($5, $6, $6, $11, 'Task 9.3 Read Only Owner', 'active'),
          ($7, $8, $8, $11, 'Task 9.3 Empty Owner', 'active'),
          ($9, $10, $10, $11, 'Task 9.3 Manager', 'active')
      `,
      [
        fixture.users.ownerA,
        fixture.emails.ownerA,
        fixture.users.ownerB,
        fixture.emails.ownerB,
        fixture.users.readOnly,
        fixture.emails.readOnly,
        fixture.users.empty,
        fixture.emails.empty,
        fixture.users.manager,
        fixture.emails.manager,
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
          ($10, $11, $12, 'owner', 'active'),
          ($13, $14, $15, 'manager', 'active')
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
        fixture.memberships.empty,
        fixture.stores.empty,
        fixture.users.empty,
        fixture.memberships.manager,
        fixture.stores.manager,
        fixture.users.manager,
      ],
    );
    for (const [index, period] of periodRecords.entries()) {
      await insertPeriod(period, index + 1);
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
      empty: await login('empty'),
      manager: await login('manager'),
    };
    sideEffectsAfterLogin = await readSideEffects();
    periodStateAfterLogin = await readPeriodState();
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
          + (select count(*) from ledger.accounting_periods where id = any($4::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds, allPeriodIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  }, 30_000);

  it('requires authentication and owner authority while allowing active and read-only reads', async () => {
    await request(server).get('/v1/accounting-periods').expect(401);
    await authorizedGet(access.manager, '/v1/accounting-periods')
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_READ_NOT_ALLOWED' });
      });

    const readOnly = readList(
      await authorizedGet(access.readOnly, '/v1/accounting-periods').expect(200),
    );
    expect(readOnly.items.map((item) => item.id)).toEqual([periodIds.readOnlyJuly]);
    await authorizedGet(access.readOnly, `/v1/accounting-periods/${periodIds.readOnlyJuly}`).expect(
      200,
    );

    expect(
      readList(await authorizedGet(access.empty, '/v1/accounting-periods').expect(200)),
    ).toEqual({ items: [] });
  });

  it('lists only the current Store in deterministic reverse chronological order', async () => {
    const response = readList(
      await authorizedGet(access.ownerA, '/v1/accounting-periods').expect(200),
    );

    expect(response.items.map((item) => item.id)).toEqual([
      periodIds.ownerASeptember,
      periodIds.ownerAAugust,
      periodIds.ownerADecember,
    ]);
    expect(response.items[0]).toEqual({
      id: periodIds.ownerASeptember,
      periodYear: 2026,
      periodMonth: 9,
      startsAt: '2026-08-31T21:00:00.000Z',
      endsAt: '2026-09-30T21:00:00.000Z',
      status: 'open',
      closedAt: null,
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-08-25T09:30:02.000Z',
      version: '9007199254740993',
    });
    for (const item of response.items) {
      expect(Object.keys(item).sort()).toEqual([
        'closedAt',
        'createdAt',
        'endsAt',
        'id',
        'periodMonth',
        'periodYear',
        'startsAt',
        'status',
        'updatedAt',
        'version',
      ]);
      expect(item).not.toHaveProperty('storeId');
      expect(item).not.toHaveProperty('deviceId');
      expect(item).not.toHaveProperty('operationId');
    }
  });

  it('returns own detail with UTC/lossless values and validates UUID input', async () => {
    const detail = readDetail(
      await authorizedGet(
        access.ownerA,
        `/v1/accounting-periods/${periodIds.ownerAAugust.toUpperCase()}`,
      ).expect(200),
    );
    expect(detail).toMatchObject({
      id: periodIds.ownerAAugust,
      periodYear: 2026,
      periodMonth: 8,
      status: 'closed',
      closedAt: '2026-09-01T10:00:00.000Z',
      version: '4',
    });
    await authorizedGet(access.ownerA, '/v1/accounting-periods/not-a-uuid').expect(400);
  });

  it('makes foreign and absent detail indistinguishable and ignores forged Store input', async () => {
    const absent = await authorizedGet(
      access.ownerA,
      `/v1/accounting-periods/${randomUUID()}`,
    ).expect(404);
    const foreign = await authorizedGet(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerBSeptember}`,
    ).expect(404);
    const internalClosing = await authorizedGet(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerAOctoberClosing}`,
    ).expect(404);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(absent.body));
    expect(withoutTraceFields(internalClosing.body)).toEqual(withoutTraceFields(absent.body));
    expect(absent.body).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_FOUND' });

    const forged = readList(
      await authorizedGet(access.ownerA, `/v1/accounting-periods?storeId=${fixture.stores.ownerB}`)
        .set('x-store-id', fixture.stores.ownerB)
        .expect(200),
    );
    expect(forged.items.map((item) => item.id)).toEqual([
      periodIds.ownerASeptember,
      periodIds.ownerAAugust,
      periodIds.ownerADecember,
    ]);
  });

  it('uses least-privileged forced RLS and fails closed without trusted context', async () => {
    if (!app || !environment) {
      throw new Error('The Accounting Period integration application is unavailable.');
    }
    const runtimeState = await runtimeInspectionPool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      rowSecurityEnabled: boolean;
      runtimeMember: boolean;
      ownsAccountingPeriods: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "runtimeMember",
        pg_get_userbyid(period_table.relowner) = current_user as "ownsAccountingPeriods",
        period_table.relrowsecurity as "rlsEnabled",
        period_table.relforcerowsecurity as "rlsForced"
      from pg_roles as role_state
      cross join pg_class as period_table
      where role_state.rolname = current_user
        and period_table.oid = 'ledger.accounting_periods'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      rowSecurityEnabled: true,
      runtimeMember: true,
      ownsAccountingPeriods: false,
      rlsEnabled: true,
      rlsForced: true,
    });

    const noContext = () =>
      runtimeInspectionPool.query<{ count: number }>(
        'select count(*)::integer as count from ledger.accounting_periods where id = any($1::uuid[])',
        [allPeriodIds],
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
          .select({ id: accountingPeriods.id })
          .from(accountingPeriods)
          .where(
            inArray(accountingPeriods.id, [periodIds.ownerASeptember, periodIds.ownerBSeptember]),
          ),
      );
    const [visibleA, visibleB] = await Promise.all([visible(contextA), visible(contextB)]);
    expect(visibleA).toEqual([{ id: periodIds.ownerASeptember }]);
    expect(visibleB).toEqual([{ id: periodIds.ownerBSeptember }]);
    expect((await noContext()).rows[0]?.count).toBe(0);

    const repository = app.get(AccountingPeriodReadRepository);
    await expect(
      repository.list(undefined as unknown as TenantTransactionContext),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('creates no period, operation, change, audit, version, status, or timestamp effect', async () => {
    expect(await readSideEffects()).toEqual(sideEffectsAfterLogin);
    expect(await readPeriodState()).toEqual(periodStateAfterLogin);
    const emptyStorePeriods = await adminPool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.accounting_periods where store_id = $1',
      [fixture.stores.empty],
    );
    expect(emptyStorePeriods.rows[0]?.count).toBe(0);
  });
});
