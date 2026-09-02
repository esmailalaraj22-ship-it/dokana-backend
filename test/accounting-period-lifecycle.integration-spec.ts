import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import {
  AccountingPeriodIntegrityError,
  AccountingPeriodProvisioningService,
} from '../src/accounting-periods/accounting-period-provisioning.service';
import type { AccountingPeriodStatus } from '../src/accounting-periods/accounting-period.types';
import {
  ACCOUNTING_PERIOD_CLOSE_REQUEST_VERSION,
  AccountingPeriodWriteService,
} from '../src/accounting-periods/accounting-period-write.service';
import type { AccountingPeriodMutationResponse } from '../src/accounting-periods/accounting-period-write.types';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    ownerA: '95000000-0000-4000-8000-000000000001',
    ownerB: '95000000-0000-4000-8000-000000000002',
    readOnly: '95000000-0000-4000-8000-000000000003',
    manager: '95000000-0000-4000-8000-000000000004',
    ensure: '95000000-0000-4000-8000-000000000005',
    concurrent: '95000000-0000-4000-8000-000000000006',
    integrity: '95000000-0000-4000-8000-000000000007',
    rollback: '95000000-0000-4000-8000-000000000008',
  },
  users: {
    ownerA: '95100000-0000-4000-8000-000000000001',
    ownerB: '95100000-0000-4000-8000-000000000002',
    readOnly: '95100000-0000-4000-8000-000000000003',
    manager: '95100000-0000-4000-8000-000000000004',
    ensure: '95100000-0000-4000-8000-000000000005',
    concurrent: '95100000-0000-4000-8000-000000000006',
    integrity: '95100000-0000-4000-8000-000000000007',
    rollback: '95100000-0000-4000-8000-000000000008',
  },
  memberships: {
    ownerA: '95200000-0000-4000-8000-000000000001',
    ownerB: '95200000-0000-4000-8000-000000000002',
    readOnly: '95200000-0000-4000-8000-000000000003',
    manager: '95200000-0000-4000-8000-000000000004',
    ensure: '95200000-0000-4000-8000-000000000005',
    concurrent: '95200000-0000-4000-8000-000000000006',
    integrity: '95200000-0000-4000-8000-000000000007',
    rollback: '95200000-0000-4000-8000-000000000008',
  },
  devices: {
    ownerA: '95300000-0000-4000-8000-000000000001',
    ownerASecond: '95300000-0000-4000-8000-000000000101',
    ownerB: '95300000-0000-4000-8000-000000000002',
    readOnly: '95300000-0000-4000-8000-000000000003',
    manager: '95300000-0000-4000-8000-000000000004',
    ensure: '95300000-0000-4000-8000-000000000005',
    concurrent: '95300000-0000-4000-8000-000000000006',
    integrity: '95300000-0000-4000-8000-000000000007',
    rollback: '95300000-0000-4000-8000-000000000008',
  },
  emails: {
    ownerA: 'task94-owner-a@example.test',
    ownerB: 'task94-owner-b@example.test',
    readOnly: 'task94-read-only@example.test',
    manager: 'task94-manager@example.test',
    ensure: 'task94-ensure@example.test',
    concurrent: 'task94-concurrent@example.test',
    integrity: 'task94-integrity@example.test',
    rollback: 'task94-rollback@example.test',
  },
  password: 'Task-9.4-Test-Password!',
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

interface PersistedPeriod {
  id: string;
  storeId: string;
  periodYear: number;
  periodMonth: number;
  startsAt: Date;
  endsAt: Date;
  status: AccountingPeriodStatus;
  closedAt: Date | null;
  deviceId: string | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: string;
}

interface ProcessedOperation {
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

interface PeriodEffects {
  changeEvents: number;
  auditLogs: number;
}

const periodIds = {
  ownerAApril: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 4),
  ownerAMay: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 5),
  ownerAJuly: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 7),
  ownerAAugust: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 8),
  ownerASeptember: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 9),
  ownerAOctober: deriveAccountingPeriodId(fixture.stores.ownerA, 2026, 10),
  ownerBSeptember: deriveAccountingPeriodId(fixture.stores.ownerB, 2026, 9),
  readOnlyJuly: deriveAccountingPeriodId(fixture.stores.readOnly, 2026, 7),
  managerSeptember: deriveAccountingPeriodId(fixture.stores.manager, 2026, 9),
  ensureSeptember: deriveAccountingPeriodId(fixture.stores.ensure, 2026, 9),
  integrityMay: '95500000-0000-4000-8000-000000000099',
};

const periodRecords: PeriodFixtureRecord[] = [
  {
    id: periodIds.ownerAApril,
    storeId: fixture.stores.ownerA,
    periodYear: 2026,
    periodMonth: 4,
    operationId: '95400000-0000-4000-8000-000000000001',
  },
  {
    id: periodIds.ownerAMay,
    storeId: fixture.stores.ownerA,
    periodYear: 2026,
    periodMonth: 5,
    operationId: '95400000-0000-4000-8000-000000000002',
  },
  {
    id: periodIds.ownerAJuly,
    storeId: fixture.stores.ownerA,
    periodYear: 2026,
    periodMonth: 7,
    operationId: '95400000-0000-4000-8000-000000000003',
  },
  {
    id: periodIds.ownerAAugust,
    storeId: fixture.stores.ownerA,
    periodYear: 2026,
    periodMonth: 8,
    operationId: '95400000-0000-4000-8000-000000000004',
    status: 'closed',
    version: '4',
  },
  {
    id: periodIds.ownerASeptember,
    storeId: fixture.stores.ownerA,
    periodYear: 2026,
    periodMonth: 9,
    operationId: '95400000-0000-4000-8000-000000000005',
  },
  {
    id: periodIds.ownerAOctober,
    storeId: fixture.stores.ownerA,
    periodYear: 2026,
    periodMonth: 10,
    operationId: '95400000-0000-4000-8000-000000000006',
    status: 'closing',
    version: '2',
  },
  {
    id: periodIds.ownerBSeptember,
    storeId: fixture.stores.ownerB,
    periodYear: 2026,
    periodMonth: 9,
    operationId: '95400000-0000-4000-8000-000000000007',
  },
  {
    id: periodIds.readOnlyJuly,
    storeId: fixture.stores.readOnly,
    periodYear: 2026,
    periodMonth: 7,
    operationId: '95400000-0000-4000-8000-000000000008',
  },
  {
    id: periodIds.managerSeptember,
    storeId: fixture.stores.manager,
    periodYear: 2026,
    periodMonth: 9,
    operationId: '95400000-0000-4000-8000-000000000009',
  },
  {
    id: periodIds.ensureSeptember,
    storeId: fixture.stores.ensure,
    periodYear: 2026,
    periodMonth: 9,
    operationId: '95400000-0000-4000-8000-000000000010',
  },
  {
    id: periodIds.integrityMay,
    storeId: fixture.stores.integrity,
    periodYear: 2026,
    periodMonth: 5,
    operationId: '95400000-0000-4000-8000-000000000011',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mutationBody(response: Response): AccountingPeriodMutationResponse {
  if (!isRecord(response.body) || typeof response.body.operationId !== 'string') {
    throw new Error('Expected an Accounting Period mutation response.');
  }
  return response.body as unknown as AccountingPeriodMutationResponse;
}

function errorBody(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) {
    throw new Error('Expected an Accounting Period error response.');
  }
  return response.body;
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

function readAccessToken(response: Response): string {
  if (!isRecord(response.body) || typeof response.body.accessToken !== 'string') {
    throw new Error('Expected an access token.');
  }
  return response.body.accessToken;
}

function closeFingerprint(accountingPeriodId: string, expectedVersion: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: ACCOUNTING_PERIOD_CLOSE_REQUEST_VERSION,
        action: 'accounting_period.close',
        accountingPeriodId,
        expectedVersion,
      }),
      'utf8',
    )
    .digest('hex');
}

class SynchronousLogCapture implements DestinationStream {
  private output = '';

  write(message: string): void {
    this.output += message;
  }
}

describe('Accounting Period provisioning and lifecycle with real PostgreSQL', () => {
  jest.setTimeout(120_000);

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const access = {} as Record<AccessKey, AccessIdentity>;
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimePool: Pool;
  let database: DatabaseService;
  let provisioning: AccountingPeriodProvisioningService;
  let periodWrites: AccountingPeriodWriteService;
  let poolsInitialized = false;
  let successfulCloseOperationId: string;
  let successfulCloseResponse: AccountingPeriodMutationResponse;

  function tenantContext(identity: AccessIdentity): TenantTransactionContext {
    return {
      storeId: identity.storeId,
      userId: identity.userId,
      deviceId: identity.deviceId,
      requestId: randomUUID(),
    };
  }

  function authorizedPost(identity: AccessIdentity, path: string, body: object) {
    return request(server)
      .post(path)
      .set('authorization', `Bearer ${identity.accessToken}`)
      .send(body);
  }

  async function login(key: AccessKey, deviceId = fixture.devices[key]): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: fixture.stores[key],
        deviceId,
        deviceName: `Task 9.4 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    return {
      accessToken: readAccessToken(response),
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId,
    };
  }

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      'delete from ledger.inventory_movements where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from ledger.sales where store_id = any($1::uuid[])', [storeIds]);
    await adminPool.query('delete from sync.conflicts where store_id = any($1::uuid[])', [
      storeIds,
    ]);
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
    await adminPool.query(
      'delete from ledger.accounting_periods where store_id = any($1::uuid[])',
      [storeIds],
    );
    await adminPool.query('delete from ledger.devices where store_id = any($1::uuid[])', [
      storeIds,
    ]);
    await adminPool.query('delete from platform.store_memberships where id = any($1::uuid[])', [
      membershipIds,
    ]);
    await adminPool.query('delete from platform.users where id = any($1::uuid[])', [userIds]);
    await adminPool.query('delete from ledger.stores where id = any($1::uuid[])', [storeIds]);
  }

  async function insertPeriod(record: PeriodFixtureRecord): Promise<void> {
    const boundaries = resolveAccountingPeriodBoundaries(record.periodYear, record.periodMonth);
    const status = record.status ?? 'open';
    await adminPool.query(
      `insert into ledger.accounting_periods (
         id, store_id, period_year, period_month, starts_at, ends_at, status,
         closed_at, operation_id, created_at, updated_at, version
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         case when $7 = 'closed' then '2026-09-01T10:00:00Z'::timestamptz else null end,
         $8, '2026-01-01T08:00:00Z'::timestamptz,
         '2026-01-01T08:00:00Z'::timestamptz, $9::bigint
       )`,
      [
        record.id,
        record.storeId,
        record.periodYear,
        record.periodMonth,
        boundaries.startsAt,
        boundaries.endsAt,
        status,
        record.operationId,
        record.version ?? '1',
      ],
    );
  }

  async function readPeriod(storeId: string, periodId: string): Promise<PersistedPeriod | null> {
    const result = await adminPool.query<PersistedPeriod>(
      `select id::text, store_id::text as "storeId", period_year as "periodYear",
         period_month as "periodMonth", starts_at as "startsAt", ends_at as "endsAt",
         status, closed_at as "closedAt", device_id::text as "deviceId",
         operation_id::text as "operationId", created_at as "createdAt",
         updated_at as "updatedAt", version::text
       from ledger.accounting_periods where store_id = $1 and id = $2`,
      [storeId, periodId],
    );
    return result.rows[0] ?? null;
  }

  async function readOperation(
    storeId: string,
    operationId: string,
  ): Promise<ProcessedOperation | null> {
    const result = await adminPool.query<ProcessedOperation>(
      `select device_id::text as "deviceId", aggregate_type as "aggregateType",
         aggregate_id::text as "aggregateId", action, request_hash as "requestHash",
         status, response_code as "responseCode", response_body as "responseBody",
         error_code as "errorCode", completed_at is not null as completed
       from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [storeId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async function readEffects(storeId: string, periodId: string): Promise<PeriodEffects> {
    const result = await adminPool.query<PeriodEffects>(
      `select
         (select count(*)::integer from sync.change_events
          where store_id = $1 and entity_type = 'accounting_periods' and entity_id = $2) as "changeEvents",
         (select count(*)::integer from audit.central_audit_logs
          where store_id = $1 and entity_type = 'ledger.accounting_periods' and entity_id = $2) as "auditLogs"`,
      [storeId, periodId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Expected Accounting Period effects.');
    }
    return row;
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
      'dokana-task94-admin',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task94-runtime', 2);
    poolsInitialized = true;

    const approval = await adminPool.query<{
      databaseName: string;
      isSuperuser: boolean;
      users: number;
      stores: number;
      accountingRows: number;
    }>(`
      select current_database() as "databaseName", role_state.rolsuper as "isSuperuser",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        ((select count(*) from ledger.accounting_periods)
          + (select count(*) from ledger.sales)
          + (select count(*) from ledger.purchase_invoices)
          + (select count(*) from ledger.customer_payments)
          + (select count(*) from ledger.supplier_payments)
          + (select count(*) from ledger.expenses)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.inventory_movements)
          + (select count(*) from ledger.stock_balances)
          + (select count(*) from ledger.stock_counts))::integer as "accountingRows"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    const state = approval.rows[0];
    if (
      state?.databaseName !== environment.databaseName ||
      !state.isSuperuser ||
      state.users !== 0 ||
      state.stores !== 0 ||
      state.accountingRows !== 0
    ) {
      throw new Error('The local Accounting Period mutation fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    for (const key of Object.keys(fixture.stores) as AccessKey[]) {
      const status = key === 'readOnly' ? 'read_only' : 'active';
      await adminPool.query('insert into ledger.stores (id, name, status) values ($1, $2, $3)', [
        fixture.stores[key],
        `Task 9.4 ${key} store`,
        status,
      ]);
      await adminPool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1, $2, $2, $3, $4, 'active')`,
        [fixture.users[key], fixture.emails[key], passwordHash, `Task 9.4 ${key}`],
      );
      await adminPool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, $4, 'active')`,
        [
          fixture.memberships[key],
          fixture.stores[key],
          fixture.users[key],
          key === 'manager' ? 'manager' : 'owner',
        ],
      );
    }
    for (const record of periodRecords) {
      await insertPeriod(record);
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) =>
          createLoggingParams(config, new SynchronousLogCapture()),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();
    database = nestApp.get(DatabaseService);
    provisioning = nestApp.get(AccountingPeriodProvisioningService);
    periodWrites = nestApp.get(AccountingPeriodWriteService);

    for (const key of Object.keys(fixture.emails) as AccessKey[]) {
      access[key] = await login(key);
    }
    await adminPool.query(
      `insert into ledger.devices (
         id, store_id, device_name, platform, installation_id, device_prefix, status
       ) values ($1, $2, 'Task 9.4 trusted second device', 'android', $3, 't94b', 'active')`,
      [fixture.devices.ownerASecond, fixture.stores.ownerA, randomUUID()],
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (!poolsInitialized) {
      return;
    }
    await removeFixtures();
    const residue = await adminPool.query<{ count: number }>(
      `select (
        (select count(*) from ledger.inventory_movements where store_id = any($1::uuid[]))
        + (select count(*) from ledger.sales where store_id = any($1::uuid[]))
        + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
        + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
        + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
        + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        + (select count(*) from ledger.accounting_periods where store_id = any($1::uuid[]))
        + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
        + (select count(*) from platform.store_memberships where id = any($2::uuid[]))
        + (select count(*) from platform.users where id = any($3::uuid[]))
        + (select count(*) from ledger.stores where id = any($1::uuid[]))
      )::integer as count`,
      [storeIds, membershipIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end()]);
  }, 30_000);

  it('keeps reads side-effect free and provisions one canonical open month in the caller transaction', async () => {
    await request(server)
      .get('/v1/accounting-periods')
      .set('authorization', `Bearer ${access.concurrent.accessToken}`)
      .expect(200)
      .expect({ items: [] });

    const context = tenantContext(access.ensure);
    const operationId = randomUUID();
    const expectedId = deriveAccountingPeriodId(context.storeId, 2026, 10);
    const boundaries = resolveAccountingPeriodBoundaries(2026, 10);
    const created = await database.withTenantTransaction(context, (transaction) =>
      provisioning.ensureMonthlyAccountingPeriod(transaction, context, {
        periodYear: 2026,
        periodMonth: 10,
        operationId,
      }),
    );

    expect(created).toMatchObject({
      id: expectedId,
      storeId: context.storeId,
      periodYear: 2026,
      periodMonth: 10,
      status: 'open',
      closedAt: null,
      deviceId: context.deviceId,
      operationId,
      version: 1n,
    });
    expect(created.startsAt).toEqual(boundaries.startsAt);
    expect(created.endsAt).toEqual(boundaries.endsAt);
    expect(await readEffects(context.storeId, expectedId)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });

    const prior = await readPeriod(context.storeId, periodIds.ensureSeptember);
    expect(prior).toMatchObject({ status: 'open', closedAt: null, version: '1' });
    const repeated = await database.withTenantTransaction(
      { ...context, requestId: randomUUID() },
      (transaction) =>
        provisioning.ensureMonthlyAccountingPeriod(transaction, context, {
          periodYear: 2026,
          periodMonth: 10,
          operationId: randomUUID(),
        }),
    );
    expect(repeated.id).toBe(created.id);
    expect(repeated.operationId).toBe(created.operationId);
    expect(await readEffects(context.storeId, expectedId)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
  });

  it('preserves existing open, closed, and closing rows and fails closed on inconsistent identity', async () => {
    const ownerContext = tenantContext(access.ownerA);
    for (const [periodMonth, expectedStatus] of [
      [9, 'open'],
      [8, 'closed'],
      [10, 'closing'],
    ] as const) {
      const row = await database.withTenantTransaction(
        { ...ownerContext, requestId: randomUUID() },
        (transaction) =>
          provisioning.ensureMonthlyAccountingPeriod(transaction, ownerContext, {
            periodYear: 2026,
            periodMonth,
            operationId: randomUUID(),
          }),
      );
      expect(row.status).toBe(expectedStatus);
    }

    const integrityContext = tenantContext(access.integrity);
    await expect(
      database.withTenantTransaction(integrityContext, (transaction) =>
        provisioning.ensureMonthlyAccountingPeriod(transaction, integrityContext, {
          periodYear: 2026,
          periodMonth: 5,
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(AccountingPeriodIntegrityError);
    expect((await readPeriod(fixture.stores.integrity, periodIds.integrityMay))?.id).toBe(
      periodIds.integrityMay,
    );
  });

  it('does not create for read-only, mismatched-tenant, missing-context, or rolled-back writes', async () => {
    const readOnlyContext = tenantContext(access.readOnly);
    const readOnlyId = deriveAccountingPeriodId(readOnlyContext.storeId, 2026, 8);
    await expect(
      database.withTenantTransaction(readOnlyContext, (transaction) =>
        provisioning.ensureMonthlyAccountingPeriod(transaction, readOnlyContext, {
          periodYear: 2026,
          periodMonth: 8,
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
    expect(await readPeriod(readOnlyContext.storeId, readOnlyId)).toBeNull();

    const ownerAContext = tenantContext(access.ownerA);
    const ownerBContext = tenantContext(access.ownerB);
    const crossTenantId = deriveAccountingPeriodId(ownerAContext.storeId, 2027, 1);
    await expect(
      database.withTenantTransaction(ownerBContext, (transaction) =>
        provisioning.ensureMonthlyAccountingPeriod(transaction, ownerAContext, {
          periodYear: 2027,
          periodMonth: 1,
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
    expect(await readPeriod(ownerAContext.storeId, crossTenantId)).toBeNull();

    const rollbackContext = tenantContext(access.rollback);
    const rollbackId = deriveAccountingPeriodId(rollbackContext.storeId, 2026, 12);
    await expect(
      database.withTenantTransaction(rollbackContext, async (transaction) => {
        await provisioning.ensureMonthlyAccountingPeriod(transaction, rollbackContext, {
          periodYear: 2026,
          periodMonth: 12,
          operationId: randomUUID(),
        });
        throw new Error('rollback probe');
      }),
    ).rejects.toThrow('rollback probe');
    expect(await readPeriod(rollbackContext.storeId, rollbackId)).toBeNull();
    expect(await readEffects(rollbackContext.storeId, rollbackId)).toEqual({
      changeEvents: 0,
      auditLogs: 0,
    });

    const client = await runtimePool.connect();
    const missingContextId = deriveAccountingPeriodId(ownerBContext.storeId, 2027, 2);
    const missingBoundaries = resolveAccountingPeriodBoundaries(2027, 2);
    try {
      await client.query('begin');
      await expect(
        client.query(
          `insert into ledger.accounting_periods (
             id, store_id, period_year, period_month, starts_at, ends_at, operation_id
           ) values ($1, $2, 2027, 2, $3, $4, $5)`,
          [
            missingContextId,
            ownerBContext.storeId,
            missingBoundaries.startsAt,
            missingBoundaries.endsAt,
            randomUUID(),
          ],
        ),
      ).rejects.toBeDefined();
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(await readPeriod(ownerBContext.storeId, missingContextId)).toBeNull();

    const closeClient = await runtimePool.connect();
    try {
      await closeClient.query('begin');
      const hiddenClose = await closeClient.query(
        `update ledger.accounting_periods set status = 'closed'
         where store_id = $1 and id = $2`,
        [ownerBContext.storeId, periodIds.ownerBSeptember],
      );
      expect(hiddenClose.rowCount).toBe(0);
    } finally {
      await closeClient.query('rollback');
      closeClient.release();
    }
    expect((await readPeriod(ownerBContext.storeId, periodIds.ownerBSeptember))?.status).toBe(
      'open',
    );
  });

  it('converges concurrent first-use on one UUID and one create effect', async () => {
    const firstContext = tenantContext(access.concurrent);
    const secondContext = { ...firstContext, requestId: randomUUID() };
    const expectedId = deriveAccountingPeriodId(firstContext.storeId, 2026, 11);
    const [first, second] = await Promise.all([
      database.withTenantTransaction(firstContext, (transaction) =>
        provisioning.ensureMonthlyAccountingPeriod(transaction, firstContext, {
          periodYear: 2026,
          periodMonth: 11,
          operationId: randomUUID(),
        }),
      ),
      database.withTenantTransaction(secondContext, (transaction) =>
        provisioning.ensureMonthlyAccountingPeriod(transaction, secondContext, {
          periodYear: 2026,
          periodMonth: 11,
          operationId: randomUUID(),
        }),
      ),
    ]);

    expect(first.id).toBe(expectedId);
    expect(second.id).toBe(expectedId);
    const count = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.accounting_periods
       where store_id = $1 and period_year = 2026 and period_month = 11`,
      [firstContext.storeId],
    );
    expect(count.rows[0]?.count).toBe(1);
    expect(await readEffects(firstContext.storeId, expectedId)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
  });

  it('closes an open period atomically and exact replay returns the stored snapshot in read-only mode', async () => {
    successfulCloseOperationId = randomUUID();
    const before = await readPeriod(fixture.stores.ownerA, periodIds.ownerASeptember);
    const response = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerASeptember}/close`,
      { operationId: successfulCloseOperationId, expectedVersion: '1' },
    ).expect(200);
    successfulCloseResponse = mutationBody(response);
    expect(successfulCloseResponse).toMatchObject({
      id: periodIds.ownerASeptember,
      status: 'closed',
      version: '2',
      operationId: successfulCloseOperationId,
    });
    expect(successfulCloseResponse.closedAt).not.toBeNull();
    const after = await readPeriod(fixture.stores.ownerA, periodIds.ownerASeptember);
    expect(after).toMatchObject({
      status: 'closed',
      version: '2',
      deviceId: fixture.devices.ownerA,
      operationId: successfulCloseOperationId,
    });
    expect(after?.closedAt).not.toBeNull();
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    expect(await readEffects(fixture.stores.ownerA, periodIds.ownerASeptember)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
    expect(await readOperation(fixture.stores.ownerA, successfulCloseOperationId)).toMatchObject({
      deviceId: fixture.devices.ownerA,
      aggregateType: 'accounting_periods',
      aggregateId: periodIds.ownerASeptember,
      action: 'close',
      requestHash: closeFingerprint(periodIds.ownerASeptember, '1'),
      status: 'applied',
      responseCode: 200,
      responseBody: successfulCloseResponse,
      completed: true,
    });

    await adminPool.query("update ledger.stores set status = 'read_only' where id = $1", [
      fixture.stores.ownerA,
    ]);
    try {
      const replay = await authorizedPost(
        access.ownerA,
        `/v1/accounting-periods/${periodIds.ownerASeptember}/close`,
        { operationId: successfulCloseOperationId, expectedVersion: '1' },
      ).expect(200);
      expect(mutationBody(replay)).toEqual(successfulCloseResponse);
    } finally {
      await adminPool.query("update ledger.stores set status = 'active' where id = $1", [
        fixture.stores.ownerA,
      ]);
    }
    expect(await readEffects(fixture.stores.ownerA, periodIds.ownerASeptember)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
  });

  it('keeps a new same-state close as a version-checked no-op and stores stale rejection replay', async () => {
    const sameStateOperation = randomUUID();
    const before = await readPeriod(fixture.stores.ownerA, periodIds.ownerAAugust);
    const sameState = mutationBody(
      await authorizedPost(
        access.ownerA,
        `/v1/accounting-periods/${periodIds.ownerAAugust}/close`,
        { operationId: sameStateOperation, expectedVersion: '4' },
      ).expect(200),
    );
    const after = await readPeriod(fixture.stores.ownerA, periodIds.ownerAAugust);
    expect(sameState).toMatchObject({
      status: 'closed',
      version: '4',
      operationId: sameStateOperation,
    });
    expect(after).toEqual(before);
    expect(await readEffects(fixture.stores.ownerA, periodIds.ownerAAugust)).toEqual({
      changeEvents: 0,
      auditLogs: 0,
    });

    const staleOperation = randomUUID();
    const payload = { operationId: staleOperation, expectedVersion: '3' };
    const first = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerAAugust}/close`,
      payload,
    ).expect(409);
    const replay = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerAAugust}/close`,
      payload,
    ).expect(409);
    expect(withoutTraceFields(replay.body)).toEqual(withoutTraceFields(first.body));
    expect(errorBody(first)).toMatchObject({ code: 'ACCOUNTING_PERIOD_VERSION_CONFLICT' });
    expect(await readOperation(fixture.stores.ownerA, staleOperation)).toMatchObject({
      status: 'rejected',
      responseCode: 409,
      errorCode: 'ACCOUNTING_PERIOD_VERSION_CONFLICT',
      completed: true,
    });
    expect(await readPeriod(fixture.stores.ownerA, periodIds.ownerAAugust)).toEqual(before);
  });

  it('fails closed for closing, unknown, foreign-tenant, read-only, and non-owner requests', async () => {
    await authorizedPost(access.ownerA, `/v1/accounting-periods/${periodIds.ownerAOctober}/close`, {
      operationId: randomUUID(),
      expectedVersion: '2',
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSING' }));

    const foreign = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerBSeptember}/close`,
      { operationId: randomUUID(), expectedVersion: '1' },
    ).expect(404);
    const unknown = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${randomUUID()}/close`,
      { operationId: randomUUID(), expectedVersion: '1' },
    ).expect(404);
    expect(errorBody(foreign)).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_FOUND' });
    expect(withoutTraceFields(unknown.body)).toEqual(withoutTraceFields(foreign.body));
    expect((await readPeriod(fixture.stores.ownerB, periodIds.ownerBSeptember))?.status).toBe(
      'open',
    );

    const readOnlyOperation = randomUUID();
    await authorizedPost(
      access.readOnly,
      `/v1/accounting-periods/${periodIds.readOnlyJuly}/close`,
      { operationId: readOnlyOperation, expectedVersion: '1' },
    )
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));
    expect(await readOperation(fixture.stores.readOnly, readOnlyOperation)).toBeNull();

    const managerOperation = randomUUID();
    await authorizedPost(
      access.manager,
      `/v1/accounting-periods/${periodIds.managerSeptember}/close`,
      { operationId: managerOperation, expectedVersion: '1' },
    )
      .expect(403)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_WRITE_NOT_ALLOWED' }),
      );
    expect(await readOperation(fixture.stores.manager, managerOperation)).toBeNull();

    const integrityOperation = randomUUID();
    await authorizedPost(
      access.integrity,
      `/v1/accounting-periods/${periodIds.integrityMay}/close`,
      { operationId: integrityOperation, expectedVersion: '1' },
    )
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT' }),
      );
    expect(await readOperation(fixture.stores.integrity, integrityOperation)).toMatchObject({
      status: 'rejected',
      errorCode: 'ACCOUNTING_PERIOD_INTEGRITY_CONFLICT',
      completed: true,
    });
  });

  it('enforces changed-request, device-binding, and operation-in-progress outcomes without duplicate close effects', async () => {
    await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerASeptember}/close`,
      { operationId: successfulCloseOperationId, expectedVersion: '2' },
    )
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));

    await expect(
      periodWrites.close(
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
        periodIds.ownerASeptember,
        { operationId: successfulCloseOperationId, expectedVersion: '1' },
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
    expect(await readEffects(fixture.stores.ownerA, periodIds.ownerASeptember)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });

    const processingOperation = randomUUID();
    await adminPool.query(
      `insert into sync.processed_operations (
         store_id, operation_id, device_id, aggregate_type, aggregate_id,
         action, request_hash, status
       ) values ($1, $2, $3, 'accounting_periods', $4, 'close', $5, 'processing')`,
      [
        fixture.stores.ownerB,
        processingOperation,
        fixture.devices.ownerB,
        periodIds.ownerBSeptember,
        closeFingerprint(periodIds.ownerBSeptember, '1'),
      ],
    );
    await authorizedPost(
      access.ownerB,
      `/v1/accounting-periods/${periodIds.ownerBSeptember}/close`,
      { operationId: processingOperation, expectedVersion: '1' },
    )
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_IN_PROGRESS' }));
    expect((await readPeriod(fixture.stores.ownerB, periodIds.ownerBSeptember))?.status).toBe(
      'open',
    );
  });

  it('rejects currently evaluable pending-cost and draft blockers and replays the stored rejection', async () => {
    const pendingSaleId = randomUUID();
    await adminPool.query(
      `insert into ledger.sales (
         id, store_id, accounting_period_id, display_number, sale_at,
         pending_cost_line_count, status, operation_id
       ) values ($1, $2, $3, 'S9.4-PENDING', '2026-07-10T10:00:00Z', 1, 'posted', $4)`,
      [pendingSaleId, fixture.stores.ownerA, periodIds.ownerAJuly, randomUUID()],
    );
    const pendingOperation = randomUUID();
    const pendingPayload = { operationId: pendingOperation, expectedVersion: '1' };
    const pending = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerAJuly}/close`,
      pendingPayload,
    ).expect(409);
    expect(errorBody(pending)).toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSE_BLOCKED' });
    await adminPool.query('delete from ledger.sales where id = $1', [pendingSaleId]);
    const replay = await authorizedPost(
      access.ownerA,
      `/v1/accounting-periods/${periodIds.ownerAJuly}/close`,
      pendingPayload,
    ).expect(409);
    expect(withoutTraceFields(replay.body)).toEqual(withoutTraceFields(pending.body));
    expect((await readPeriod(fixture.stores.ownerA, periodIds.ownerAJuly))?.status).toBe('open');

    const draftSaleId = randomUUID();
    await adminPool.query(
      `insert into ledger.sales (
         id, store_id, accounting_period_id, display_number, sale_at, status, operation_id
       ) values ($1, $2, $3, 'S9.4-DRAFT', '2026-05-10T10:00:00Z', 'draft', $4)`,
      [draftSaleId, fixture.stores.ownerA, periodIds.ownerAMay, randomUUID()],
    );
    await authorizedPost(access.ownerA, `/v1/accounting-periods/${periodIds.ownerAMay}/close`, {
      operationId: randomUUID(),
      expectedVersion: '1',
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSE_BLOCKED' }),
      );
    expect((await readPeriod(fixture.stores.ownerA, periodIds.ownerAMay))?.status).toBe('open');

    const inventoryMovementId = randomUUID();
    await adminPool.query(
      `insert into ledger.inventory_movements (
         id, store_id, product_id, accounting_period_id, movement_type,
         quantity_before_milli, quantity_delta_milli, quantity_after_milli,
         inventory_value_before_minor, value_delta_minor, inventory_value_after_minor,
         average_unit_cost_after_minor, cost_status, has_pending_cost_after,
         reference_type, reference_id, transaction_group_id, occurred_at, operation_id
       ) values (
         $1, $2, $3, $4, 'adjustment_in', 0, 1000, 1000,
         0, 0, 0, 0, 'pending', true,
         's9_4_test', $5, $6, '2026-04-10T10:00:00Z', $7
       )`,
      [
        inventoryMovementId,
        fixture.stores.ownerA,
        randomUUID(),
        periodIds.ownerAApril,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await authorizedPost(access.ownerA, `/v1/accounting-periods/${periodIds.ownerAApril}/close`, {
      operationId: randomUUID(),
      expectedVersion: '1',
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_CLOSE_BLOCKED' }),
      );
    expect((await readPeriod(fixture.stores.ownerA, periodIds.ownerAApril))?.status).toBe('open');
  });

  it('rejects unknown request fields before claiming an operation', async () => {
    const operationId = randomUUID();
    await authorizedPost(
      access.ownerB,
      `/v1/accounting-periods/${periodIds.ownerBSeptember}/close`,
      { operationId, expectedVersion: '1', storeId: fixture.stores.ownerA },
    ).expect(400);
    expect(await readOperation(fixture.stores.ownerB, operationId)).toBeNull();
  });
});
