import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import type { TenantTransactionContext } from '../src/database/database.types';
import { AppSettingsInitializationService } from '../src/settings/app-settings-initialization.service';
import type { UpdateAppSettingsDto } from '../src/settings/dto/update-app-settings.dto';
import { AppSettingsWriteRepository } from '../src/settings/app-settings-write.repository';
import {
  APP_SETTINGS_WRITE_REQUEST_VERSION,
  AppSettingsWriteService,
} from '../src/settings/app-settings-write.service';
import type { AppSettingsInitializationValues } from '../src/settings/app-settings.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(90_000);

const fixture = {
  stores: {
    a: '76000000-0000-4000-8000-000000000001',
    b: '76000000-0000-4000-8000-000000000002',
    viewer: '76000000-0000-4000-8000-000000000003',
    flip: '76000000-0000-4000-8000-000000000004',
    missing: '76000000-0000-4000-8000-000000000005',
    initialize: '76000000-0000-4000-8000-000000000006',
    readOnlyInitialize: '76000000-0000-4000-8000-000000000007',
  },
  users: {
    a: '76100000-0000-4000-8000-000000000001',
    b: '76100000-0000-4000-8000-000000000002',
    viewer: '76100000-0000-4000-8000-000000000003',
    flip: '76100000-0000-4000-8000-000000000004',
    missing: '76100000-0000-4000-8000-000000000005',
    initialize: '76100000-0000-4000-8000-000000000006',
    readOnlyInitialize: '76100000-0000-4000-8000-000000000007',
  },
  memberships: {
    a: '76200000-0000-4000-8000-000000000001',
    b: '76200000-0000-4000-8000-000000000002',
    viewer: '76200000-0000-4000-8000-000000000003',
    flip: '76200000-0000-4000-8000-000000000004',
    missing: '76200000-0000-4000-8000-000000000005',
    initialize: '76200000-0000-4000-8000-000000000006',
    readOnlyInitialize: '76200000-0000-4000-8000-000000000007',
  },
  devices: {
    a: '76300000-0000-4000-8000-000000000001',
    aSecond: '76300000-0000-4000-8000-000000000101',
    b: '76300000-0000-4000-8000-000000000002',
    viewer: '76300000-0000-4000-8000-000000000003',
    flip: '76300000-0000-4000-8000-000000000004',
    missing: '76300000-0000-4000-8000-000000000005',
    initialize: '76300000-0000-4000-8000-000000000006',
    readOnlyInitialize: '76300000-0000-4000-8000-000000000007',
  },
  emails: {
    a: 'task74-a@example.test',
    b: 'task74-b@example.test',
    viewer: 'task74-viewer@example.test',
    flip: 'task74-flip@example.test',
    missing: 'task74-missing@example.test',
    initialize: 'task74-initialize@example.test',
    readOnlyInitialize: 'task74-read-only-initialize@example.test',
  },
  password: 'Task-7.4-Test-Password!',
};

type AccessKey = keyof typeof fixture.emails;
type MembershipRole = 'owner' | 'viewer';

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface SettingsState {
  dailyReportTimeMinutes: number;
  defaultCreditPolicy: 'allow' | 'warn' | 'block';
  defaultCreditLimitMinor: string | null;
  allowNegativeStock: boolean;
  lowStockAlertEnabled: boolean;
  debtAgeAlertDays: number;
  backupEnabled: boolean;
  backupIntervalHours: number;
  exportDirectoryUri: string | null;
  attachmentsDirectoryUri: string | null;
  version: string;
  timezoneName: string;
  businessDayStartMinutes: number;
  businessDayEndMinutes: number;
  businessDayMode: string;
  createdAt: Date;
  updatedAt: Date;
}

interface OperationState {
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

const storeIds = Object.values(fixture.stores);
const userIds = Object.values(fixture.users);
const membershipIds = Object.values(fixture.memberships);
const mutableFields = [
  'dailyReportTimeMinutes',
  'defaultCreditPolicy',
  'defaultCreditLimitMinor',
  'allowNegativeStock',
  'lowStockAlertEnabled',
  'debtAgeAlertDays',
  'backupEnabled',
  'backupIntervalHours',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function body(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) {
    throw new Error('Expected an object response body.');
  }
  return response.body;
}

function storedErrorBody(responseBody: Record<string, unknown>): Record<string, unknown> {
  return {
    code: responseBody.code,
    message: responseBody.message,
  };
}

function fingerprint(payload: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {
    v: APP_SETTINGS_WRITE_REQUEST_VERSION,
    action: 'settings.update',
    expectedVersion: payload.expectedVersion,
  };
  for (const field of mutableFields) {
    if (payload[field] !== undefined) {
      canonical[field] = payload[field];
    }
  }
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

describe('App settings write API with real PostgreSQL', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let settingsWrites: AppSettingsWriteService;
  let settingsRepository: AppSettingsWriteRepository;
  let initializer: AppSettingsInitializationService;
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
    await adminPool.query(`delete from ledger.app_settings where store_id = any($1::uuid[])`, [
      storeIds,
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

  async function login(key: AccessKey, deviceId = fixture.devices[key]): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: fixture.stores[key],
        deviceId,
        deviceName: `Task 7.4 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    const accessToken = body(response).accessToken;
    if (typeof accessToken !== 'string') {
      throw new Error('Login did not return an access token.');
    }
    return {
      accessToken,
      storeId: fixture.stores[key],
      userId: fixture.users[key],
      deviceId,
    };
  }

  function patch(identity: AccessIdentity) {
    return request(server)
      .patch('/v1/settings')
      .set('authorization', `Bearer ${identity.accessToken}`);
  }

  function get(identity: AccessIdentity) {
    return request(server)
      .get('/v1/settings')
      .set('authorization', `Bearer ${identity.accessToken}`);
  }

  function tenantContext(identity: AccessIdentity): TenantTransactionContext {
    return {
      storeId: identity.storeId,
      userId: identity.userId,
      deviceId: identity.deviceId,
      requestId: randomUUID(),
    };
  }

  async function readSettings(storeId: string): Promise<SettingsState | null> {
    const result = await adminPool.query<SettingsState>(
      `select
        daily_report_time_minutes as "dailyReportTimeMinutes",
        default_credit_policy as "defaultCreditPolicy",
        default_credit_limit_minor::text as "defaultCreditLimitMinor",
        allow_negative_stock as "allowNegativeStock",
        low_stock_alert_enabled as "lowStockAlertEnabled",
        debt_age_alert_days as "debtAgeAlertDays",
        backup_enabled as "backupEnabled",
        backup_interval_hours as "backupIntervalHours",
        export_directory_uri as "exportDirectoryUri",
        attachments_directory_uri as "attachmentsDirectoryUri",
        version::text as version,
        timezone_name as "timezoneName",
        business_day_start_minutes as "businessDayStartMinutes",
        business_day_end_minutes as "businessDayEndMinutes",
        business_day_mode as "businessDayMode",
        created_at as "createdAt",
        updated_at as "updatedAt"
       from ledger.app_settings where store_id = $1`,
      [storeId],
    );
    return result.rows[0] ?? null;
  }

  async function readOperation(
    storeId: string,
    operationId: string,
  ): Promise<OperationState | null> {
    const result = await adminPool.query<OperationState>(
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

  async function settingsEventCount(storeId: string): Promise<number> {
    const result = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from sync.change_events
       where store_id = $1 and entity_type = 'app_settings' and entity_id = $1`,
      [storeId],
    );
    return result.rows[0]?.count ?? -1;
  }

  async function expectRejectedReplay(
    identity: AccessIdentity,
    payload: Record<string, unknown>,
    statusCode: number,
    errorCode: string,
  ): Promise<void> {
    const first = body(await patch(identity).send(payload).expect(statusCode));
    const replay = body(await patch(identity).send(payload).expect(statusCode));
    expect(storedErrorBody(replay)).toEqual(storedErrorBody(first));
    expect(first.code).toBe(errorCode);
    expect(await readOperation(identity.storeId, payload.operationId as string)).toMatchObject({
      status: 'rejected',
      responseCode: statusCode,
      responseBody: storedErrorBody(first),
      errorCode,
      completed: true,
    });
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }
    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'info';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;
    process.env.DB_POOL_MAX = '10';

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task74-admin',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task74-rls', 2);
    poolsInitialized = true;

    const approval = await adminPool.query<{
      databaseName: string;
      isSuperuser: boolean;
      users: number;
      stores: number;
      settings: number;
      uriRows: number;
      businessRows: number;
    }>(`
      select
        current_database() as "databaseName",
        role_state.rolsuper as "isSuperuser",
        (select count(*)::integer from platform.users) as users,
        (select count(*)::integer from ledger.stores) as stores,
        (select count(*)::integer from ledger.app_settings) as settings,
        (select count(*)::integer from ledger.app_settings
          where export_directory_uri is not null or attachments_directory_uri is not null) as "uriRows",
        ((select count(*) from ledger.sales)
          + (select count(*) from ledger.purchase_invoices)
          + (select count(*) from ledger.supplier_payments)
          + (select count(*) from ledger.customer_payments)
          + (select count(*) from ledger.expenses)
          + (select count(*) from ledger.money_movements)
          + (select count(*) from ledger.inventory_movements)
          + (select count(*) from ledger.stock_balances)
          + (select count(*) from ledger.stock_counts))::integer as "businessRows"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    const state = approval.rows[0];
    if (
      state?.databaseName !== environment.databaseName ||
      !state.isSuperuser ||
      state.users !== 0 ||
      state.stores !== 0 ||
      state.settings !== 0 ||
      state.uriRows !== 0 ||
      state.businessRows !== 0
    ) {
      throw new Error('The local Settings mutation fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `insert into ledger.stores (id, name, status) values
        ($1, 'Task 7.4 Store A', 'active'),
        ($2, 'Task 7.4 Store B', 'active'),
        ($3, 'Task 7.4 Viewer Store', 'active'),
        ($4, 'Task 7.4 Flip Store', 'active'),
        ($5, 'Task 7.4 Missing Store', 'active'),
        ($6, 'Task 7.4 Initialize Store', 'active'),
        ($7, 'Task 7.4 Read Only Initialize Store', 'read_only')`,
      storeIds,
    );
    await adminPool.query(
      `insert into platform.users (id, email, normalized_email, password_hash, full_name, status)
       values
        ($1, $2, $2, $15, 'Task 7.4 Owner A', 'active'),
        ($3, $4, $4, $15, 'Task 7.4 Owner B', 'active'),
        ($5, $6, $6, $15, 'Task 7.4 Viewer', 'active'),
        ($7, $8, $8, $15, 'Task 7.4 Flip Owner', 'active'),
        ($9, $10, $10, $15, 'Task 7.4 Missing Owner', 'active'),
        ($11, $12, $12, $15, 'Task 7.4 Initialize Owner', 'active'),
        ($13, $14, $14, $15, 'Task 7.4 Read Only Initialize Owner', 'active')`,
      [
        fixture.users.a,
        fixture.emails.a,
        fixture.users.b,
        fixture.emails.b,
        fixture.users.viewer,
        fixture.emails.viewer,
        fixture.users.flip,
        fixture.emails.flip,
        fixture.users.missing,
        fixture.emails.missing,
        fixture.users.initialize,
        fixture.emails.initialize,
        fixture.users.readOnlyInitialize,
        fixture.emails.readOnlyInitialize,
        passwordHash,
      ],
    );
    const roles: MembershipRole[] = [
      'owner',
      'owner',
      'viewer',
      'owner',
      'owner',
      'owner',
      'owner',
    ];
    for (let index = 0; index < storeIds.length; index += 1) {
      await adminPool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, $4, 'active')`,
        [membershipIds[index], storeIds[index], userIds[index], roles[index]],
      );
    }

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) => createLoggingParams(config),
        inject: [AppConfigService],
      })
      .compile();
    const nestApp = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nestApp.useLogger(nestApp.get(Logger));
    configureApplication(nestApp, nestApp.get(AppConfigService));
    await nestApp.init();
    app = nestApp;
    server = nestApp.getHttpServer();
    settingsWrites = nestApp.get(AppSettingsWriteService);
    settingsRepository = nestApp.get(AppSettingsWriteRepository);
    initializer = nestApp.get(AppSettingsInitializationService);

    for (const key of Object.keys(fixture.emails) as AccessKey[]) {
      access[key] = await login(key);
    }
    await adminPool.query(
      `insert into ledger.devices (
        id, store_id, device_name, platform, installation_id, device_prefix, status
       ) values ($1, $2, 'Task 7.4 trusted second device', 'android', $3, 't74b', 'active')`,
      [fixture.devices.aSecond, fixture.stores.a, randomUUID()],
    );

    await adminPool.query(
      `insert into ledger.app_settings (
        store_id, daily_report_time_minutes, default_credit_policy,
        default_credit_limit_minor, allow_negative_stock, low_stock_alert_enabled,
        debt_age_alert_days, backup_enabled, backup_interval_hours,
        export_directory_uri, attachments_directory_uri, version,
        timezone_name, business_day_start_minutes, business_day_end_minutes, business_day_mode
       ) values
        ($1, 1200, 'allow', null, false, true, 90, true, 24, null, null,
          9007199254740993, 'Asia/Hebron', 720, 720, 'fixed_24h'),
        ($2, 1000, 'warn', 5000, false, true, 60, true, 12, null, null,
          1, 'Asia/Hebron', 720, 720, 'fixed_24h'),
        ($3, 1100, 'warn', null, false, true, 30, true, 24, null, null,
          1, 'Asia/Hebron', 720, 720, 'fixed_24h'),
        ($4, 1150, 'block', 10000, false, true, 45, true, 24, null, null,
          1, 'Asia/Hebron', 720, 720, 'fixed_24h')`,
      [fixture.stores.a, fixture.stores.b, fixture.stores.viewer, fixture.stores.flip],
    );
  });

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
        + (select count(*) from ledger.app_settings where store_id = any($1::uuid[]))
        + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
        + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
        + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
        + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
      )::integer as count`,
      [storeIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end()]);
  });

  it('enforces authentication, owner authority, strict DTOs, and mutable-field presence pre-claim', async () => {
    await request(server)
      .patch('/v1/settings')
      .send({ operationId: randomUUID(), expectedVersion: '1', backupEnabled: false })
      .expect(401);

    const viewerOperation = randomUUID();
    expect(
      body(
        await patch(access.viewer)
          .send({ operationId: viewerOperation, expectedVersion: '1', backupEnabled: false })
          .expect(403),
      ).code,
    ).toBe('SETTINGS_WRITE_NOT_ALLOWED');
    expect(await readOperation(fixture.stores.viewer, viewerOperation)).toBeNull();

    await patch(access.a).send({}).expect(400);
    const emptyOperation = randomUUID();
    await patch(access.a)
      .send({ operationId: emptyOperation, expectedVersion: '9007199254740993' })
      .expect(400);
    expect(await readOperation(fixture.stores.a, emptyOperation)).toBeNull();

    const forbiddenFields: Record<string, unknown> = {
      storeId: fixture.stores.b,
      tenantId: fixture.stores.b,
      userId: fixture.users.b,
      role: 'owner',
      deviceId: fixture.devices.b,
      version: '1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      timezoneName: 'UTC',
      businessDayStartMinutes: 0,
      businessDayEndMinutes: 0,
      businessDayMode: 'custom',
      exportDirectoryUri: 'file:///private',
      attachmentsDirectoryUri: 'file:///private',
      requestId: randomUUID(),
      status: 'applied',
    };
    for (const [field, value] of Object.entries(forbiddenFields)) {
      const operationId = randomUUID();
      const response = await patch(access.a)
        .send({
          operationId,
          expectedVersion: '9007199254740993',
          backupEnabled: false,
          [field]: value,
        })
        .expect(400);
      expect(body(response).code).toBe('VALIDATION_ERROR');
      expect(await readOperation(fixture.stores.a, operationId)).toBeNull();
    }

    const invalidValues: Record<string, unknown>[] = [
      { dailyReportTimeMinutes: -1 },
      { dailyReportTimeMinutes: 1440 },
      { dailyReportTimeMinutes: 1.5 },
      { defaultCreditPolicy: 'allow' },
      { defaultCreditPolicy: null },
      { defaultCreditLimitMinor: 1 },
      { defaultCreditLimitMinor: '-1' },
      { defaultCreditLimitMinor: '01' },
      { defaultCreditLimitMinor: '9223372036854775808' },
      { allowNegativeStock: null },
      { lowStockAlertEnabled: 'true' },
      { debtAgeAlertDays: -1 },
      { debtAgeAlertDays: 2_147_483_648 },
      { backupEnabled: null },
      { backupIntervalHours: 0 },
      { backupIntervalHours: 2_147_483_648 },
    ];
    for (const invalid of invalidValues) {
      const operationId = randomUUID();
      await patch(access.a)
        .send({ operationId, expectedVersion: '9007199254740993', ...invalid })
        .expect(400);
      expect(await readOperation(fixture.stores.a, operationId)).toBeNull();
    }

    for (const expectedVersion of ['0', '01', '1.0', '9223372036854775808', 1]) {
      const operationId = randomUUID();
      await patch(access.a)
        .send({ operationId, expectedVersion, backupEnabled: false })
        .expect(400);
      expect(await readOperation(fixture.stores.a, operationId)).toBeNull();
    }
  });

  it('preserves legacy allow, writes bigint losslessly, accepts warn/block, and clears only the limit', async () => {
    const operationId = randomUUID();
    const first = body(
      await patch(access.a)
        .send({
          operationId,
          expectedVersion: '9007199254740993',
          dailyReportTimeMinutes: 900,
          defaultCreditLimitMinor: '9007199254740995',
        })
        .expect(200),
    );
    expect(first).toMatchObject({
      operationId,
      defaultCreditPolicy: 'allow',
      defaultCreditLimitMinor: '9007199254740995',
      version: '9007199254740994',
      timezoneName: 'Asia/Hebron',
    });
    expect(Object.keys(first).sort()).toEqual(
      [
        'dailyReportTimeMinutes',
        'defaultCreditPolicy',
        'defaultCreditLimitMinor',
        'allowNegativeStock',
        'lowStockAlertEnabled',
        'debtAgeAlertDays',
        'backupEnabled',
        'backupIntervalHours',
        'timezoneName',
        'version',
        'createdAt',
        'updatedAt',
        'operationId',
      ].sort(),
    );
    expect(await readSettings(fixture.stores.a)).toMatchObject({
      defaultCreditPolicy: 'allow',
      defaultCreditLimitMinor: '9007199254740995',
      version: '9007199254740994',
      exportDirectoryUri: null,
      attachmentsDirectoryUri: null,
    });

    const warn = body(
      await patch(access.a)
        .send({
          operationId: randomUUID(),
          expectedVersion: '9007199254740994',
          defaultCreditPolicy: 'warn',
          defaultCreditLimitMinor: null,
        })
        .expect(200),
    );
    expect(warn).toMatchObject({
      defaultCreditPolicy: 'warn',
      defaultCreditLimitMinor: null,
      version: '9007199254740995',
    });
    const block = body(
      await patch(access.a)
        .send({
          operationId: randomUUID(),
          expectedVersion: '9007199254740995',
          defaultCreditPolicy: 'block',
        })
        .expect(200),
    );
    expect(block).toMatchObject({ defaultCreditPolicy: 'block', version: '9007199254740996' });
  });

  it('completes a canonical no-op without row, timestamp, version, or change-event mutation', async () => {
    const before = await readSettings(fixture.stores.a);
    if (!before) throw new Error('Expected Settings fixture.');
    const eventsBefore = await settingsEventCount(fixture.stores.a);
    const operationId = randomUUID();
    const result = body(
      await patch(access.a)
        .send({
          operationId,
          expectedVersion: before.version,
          dailyReportTimeMinutes: before.dailyReportTimeMinutes,
          defaultCreditPolicy: before.defaultCreditPolicy,
          defaultCreditLimitMinor: before.defaultCreditLimitMinor,
          allowNegativeStock: before.allowNegativeStock,
          lowStockAlertEnabled: before.lowStockAlertEnabled,
          debtAgeAlertDays: before.debtAgeAlertDays,
          backupEnabled: before.backupEnabled,
          backupIntervalHours: before.backupIntervalHours,
        })
        .expect(200),
    );
    expect(result).toMatchObject({ operationId, version: before.version });
    expect(await readSettings(fixture.stores.a)).toEqual(before);
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore);
    expect(await readOperation(fixture.stores.a, operationId)).toMatchObject({
      status: 'applied',
      responseCode: 200,
      completed: true,
    });
  });

  it('stores and exactly replays missing and stale deterministic rejections', async () => {
    const missingPayload = {
      operationId: randomUUID(),
      expectedVersion: '1',
      backupEnabled: false,
    };
    await get(access.missing).expect(404);
    await expectRejectedReplay(access.missing, missingPayload, 404, 'SETTINGS_NOT_INITIALIZED');
    expect(await readSettings(fixture.stores.missing)).toBeNull();
    await initializer.ensureForStore(tenantContext(access.missing), {
      dailyReportTimeMinutes: 1200,
      defaultCreditPolicy: 'warn',
      defaultCreditLimitMinor: null,
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 90,
      backupEnabled: true,
      backupIntervalHours: 24,
      timezoneName: 'Asia/Hebron',
      businessDayMode: 'fixed_24h',
    });
    expect(
      storedErrorBody(body(await patch(access.missing).send(missingPayload).expect(404))),
    ).toEqual({
      code: 'SETTINGS_NOT_INITIALIZED',
      message: 'Store settings are not initialized.',
    });

    const current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    await expectRejectedReplay(
      access.a,
      {
        operationId: randomUUID(),
        expectedVersion: (BigInt(current.version) - 1n).toString(),
        backupEnabled: current.backupEnabled,
      },
      409,
      'SETTINGS_VERSION_CONFLICT',
    );
  });

  it('exact-replays the original snapshot after later mutation and while read_only', async () => {
    const current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    const operationId = randomUUID();
    const originalPayload = {
      operationId,
      expectedVersion: current.version,
      backupEnabled: !current.backupEnabled,
    };
    const original = body(await patch(access.a).send(originalPayload).expect(200));
    const later = body(
      await patch(access.a)
        .send({
          operationId: randomUUID(),
          expectedVersion: original.version,
          debtAgeAlertDays: current.debtAgeAlertDays + 1,
        })
        .expect(200),
    );
    expect(later.version).not.toBe(original.version);
    expect(body(await patch(access.a).send(originalPayload).expect(200))).toEqual(original);
    const rejectedPayload = {
      operationId: randomUUID(),
      expectedVersion: original.version,
      debtAgeAlertDays: current.debtAgeAlertDays + 2,
    };
    const rejected = storedErrorBody(body(await patch(access.a).send(rejectedPayload).expect(409)));

    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.a,
    ]);
    try {
      expect(body(await patch(access.a).send(originalPayload).expect(200))).toEqual(original);
      expect(
        storedErrorBody(body(await patch(access.a).send(rejectedPayload).expect(409))),
      ).toEqual(rejected);
      const unseenOperation = randomUUID();
      expect(
        body(
          await patch(access.a)
            .send({
              operationId: unseenOperation,
              expectedVersion: later.version,
              backupEnabled: current.backupEnabled,
            })
            .expect(403),
        ).code,
      ).toBe('BUSINESS_WRITE_NOT_ALLOWED');
      expect(await readOperation(fixture.stores.a, unseenOperation)).toBeNull();
      expect(
        body(
          await patch(access.a)
            .send({ ...originalPayload, backupEnabled: current.backupEnabled })
            .expect(409),
        ).code,
      ).toBe('OPERATION_ID_CONFLICT');
    } finally {
      await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
        fixture.stores.a,
      ]);
    }
  });

  it('rejects device rebinding and returns OPERATION_IN_PROGRESS without another effect', async () => {
    const current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    const payload = {
      operationId: randomUUID(),
      expectedVersion: current.version,
      lowStockAlertEnabled: !current.lowStockAlertEnabled,
    };
    await patch(access.a).send(payload).expect(200);
    await expect(
      settingsWrites.update(
        {
          membershipRole: 'owner',
          storeId: fixture.stores.a,
          userId: fixture.users.a,
          deviceId: fixture.devices.aSecond,
        },
        {
          storeId: fixture.stores.a,
          userId: fixture.users.a,
          deviceId: fixture.devices.aSecond,
          requestId: randomUUID(),
        },
        payload as UpdateAppSettingsDto,
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });

    const after = await readSettings(fixture.stores.a);
    if (!after) throw new Error('Expected Settings fixture.');
    const processing = {
      operationId: randomUUID(),
      expectedVersion: after.version,
      backupIntervalHours: after.backupIntervalHours + 1,
    };
    await adminPool.query(
      `insert into sync.processed_operations (
        store_id, operation_id, device_id, aggregate_type, aggregate_id,
        action, request_hash, status
       ) values ($1, $2, $3, 'app_settings', $1, 'update', $4, 'processing')`,
      [fixture.stores.a, processing.operationId, fixture.devices.a, fingerprint(processing)],
    );
    const eventsBefore = await settingsEventCount(fixture.stores.a);
    expect(body(await patch(access.a).send(processing).expect(409)).code).toBe(
      'OPERATION_IN_PROGRESS',
    );
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore);
  });

  it('keeps operation namespaces and Settings rows tenant-safe under forced RLS', async () => {
    const a = await readSettings(fixture.stores.a);
    const b = await readSettings(fixture.stores.b);
    if (!a || !b) throw new Error('Expected Settings fixtures.');
    const sharedOperationId = randomUUID();
    await patch(access.a)
      .send({
        operationId: sharedOperationId,
        expectedVersion: a.version,
        dailyReportTimeMinutes: a.dailyReportTimeMinutes === 800 ? 801 : 800,
      })
      .expect(200);
    await patch(access.b)
      .send({
        operationId: sharedOperationId,
        expectedVersion: b.version,
        dailyReportTimeMinutes: b.dailyReportTimeMinutes === 800 ? 801 : 800,
      })
      .expect(200);

    const noContext = await runtimePool.query<{ count: string }>(
      `select count(*)::text as count from ledger.app_settings where store_id = $1`,
      [fixture.stores.a],
    );
    expect(noContext.rows[0]?.count).toBe('0');

    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.store_id', $1, true)`, [fixture.stores.a]);
      await client.query(`select set_config('app.user_id', $1, true)`, [fixture.users.a]);
      await client.query(`select set_config('app.device_id', $1, true)`, [fixture.devices.a]);
      await client.query(`select set_config('app.request_id', $1, true)`, [randomUUID()]);
      const own = await client.query<{ count: string }>(
        `select count(*)::text as count from ledger.app_settings where store_id = $1`,
        [fixture.stores.a],
      );
      const foreign = await client.query<{ count: string }>(
        `select count(*)::text as count from ledger.app_settings where store_id = $1`,
        [fixture.stores.b],
      );
      const foreignUpdate = await client.query(
        `update ledger.app_settings set backup_enabled = not backup_enabled where store_id = $1 returning store_id`,
        [fixture.stores.b],
      );
      expect(own.rows[0]?.count).toBe('1');
      expect(foreign.rows[0]?.count).toBe('0');
      expect(foreignUpdate.rowCount).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('serializes real mutation races so only one consumes a settings version', async () => {
    const current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    const eventsBefore = await settingsEventCount(fixture.stores.a);
    const values = [
      current.dailyReportTimeMinutes === 600 ? 601 : 600,
      current.dailyReportTimeMinutes === 602 ? 603 : 602,
    ];
    const responses = await Promise.all(
      values.map((dailyReportTimeMinutes) =>
        patch(access.a).send({
          operationId: randomUUID(),
          expectedVersion: current.version,
          dailyReportTimeMinutes,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.some((response) => body(response).code === 'SETTINGS_VERSION_CONFLICT')).toBe(
      true,
    );
    const after = await readSettings(fixture.stores.a);
    expect(after?.version).toBe((BigInt(current.version) + 1n).toString());
    expect(values).toContain(after?.dailyReportTimeMinutes);
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore + 1);
  });

  it('preserves no-op versus real-mutation concurrency invariants', async () => {
    const current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    const eventsBefore = await settingsEventCount(fixture.stores.a);
    const responses = await Promise.all([
      patch(access.a).send({
        operationId: randomUUID(),
        expectedVersion: current.version,
        allowNegativeStock: current.allowNegativeStock,
      }),
      patch(access.a).send({
        operationId: randomUUID(),
        expectedVersion: current.version,
        allowNegativeStock: !current.allowNegativeStock,
      }),
    ]);
    expect(responses.filter((response) => response.status === 200).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(responses.every((response) => response.status === 200 || response.status === 409)).toBe(
      true,
    );
    const after = await readSettings(fixture.stores.a);
    expect(after).toMatchObject({
      allowNegativeStock: !current.allowNegativeStock,
      version: (BigInt(current.version) + 1n).toString(),
    });
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore + 1);
  });

  it('handles concurrent identical, conflicting, and distinct operation identities deterministically', async () => {
    let current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    let eventsBefore = await settingsEventCount(fixture.stores.a);
    const identical = {
      operationId: randomUUID(),
      expectedVersion: current.version,
      backupEnabled: !current.backupEnabled,
    };
    const identicalResponses = await Promise.all([
      patch(access.a).send(identical),
      patch(access.a).send(identical),
    ]);
    expect(identicalResponses.map((response) => response.status)).toEqual([200, 200]);
    expect(body(identicalResponses[0])).toEqual(body(identicalResponses[1]));
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore + 1);

    current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    eventsBefore = await settingsEventCount(fixture.stores.a);
    const conflictingOperationId = randomUUID();
    const conflicts = await Promise.all([
      patch(access.a).send({
        operationId: conflictingOperationId,
        expectedVersion: current.version,
        debtAgeAlertDays: current.debtAgeAlertDays + 1,
      }),
      patch(access.a).send({
        operationId: conflictingOperationId,
        expectedVersion: current.version,
        debtAgeAlertDays: current.debtAgeAlertDays + 2,
      }),
    ]);
    expect(conflicts.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(conflicts.some((response) => body(response).code === 'OPERATION_ID_CONFLICT')).toBe(
      true,
    );
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore + 1);

    current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    eventsBefore = await settingsEventCount(fixture.stores.a);
    const intendedValue = current.lowStockAlertEnabled;
    const targetValue = !intendedValue;
    const distinct = await Promise.all([
      patch(access.a).send({
        operationId: randomUUID(),
        expectedVersion: current.version,
        lowStockAlertEnabled: targetValue,
      }),
      patch(access.a).send({
        operationId: randomUUID(),
        expectedVersion: current.version,
        lowStockAlertEnabled: targetValue,
      }),
    ]);
    expect(distinct.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore + 1);
  });

  it('initializes a deterministic singleton concurrently without reset, GET/PATCH upsert, or read_only bypass', async () => {
    await get(access.initialize).expect(404);
    expect(await readSettings(fixture.stores.initialize)).toBeNull();
    const values: AppSettingsInitializationValues = {
      dailyReportTimeMinutes: 1110,
      defaultCreditPolicy: 'block',
      defaultCreditLimitMinor: 9_007_199_254_740_993n,
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 45,
      backupEnabled: true,
      backupIntervalHours: 12,
      timezoneName: 'Asia/Hebron',
      businessDayMode: 'fixed_24h',
    };
    const context = tenantContext(access.initialize);
    await Promise.all([
      initializer.ensureForStore(context, values),
      initializer.ensureForStore({ ...context, requestId: randomUUID() }, values),
    ]);
    const initialized = await readSettings(fixture.stores.initialize);
    expect(initialized).toMatchObject({
      dailyReportTimeMinutes: 1110,
      defaultCreditPolicy: 'block',
      defaultCreditLimitMinor: '9007199254740993',
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 45,
      backupEnabled: true,
      backupIntervalHours: 12,
      exportDirectoryUri: null,
      attachmentsDirectoryUri: null,
      version: '1',
      timezoneName: 'Asia/Hebron',
      businessDayStartMinutes: 720,
      businessDayEndMinutes: 720,
      businessDayMode: 'fixed_24h',
    });
    expect(await settingsEventCount(fixture.stores.initialize)).toBe(1);

    await initializer.ensureForStore(context, { ...values, dailyReportTimeMinutes: 1 });
    expect(await readSettings(fixture.stores.initialize)).toEqual(initialized);
    await expect(
      initializer.ensureForStore(tenantContext(access.readOnlyInitialize), values),
    ).rejects.toMatchObject({ response: { code: 'BUSINESS_WRITE_NOT_ALLOWED' } });
    expect(await readSettings(fixture.stores.readOnlyInitialize)).toBeNull();
  });

  it('rolls back claim, Settings update, trigger event, and completion after a test-only fault', async () => {
    const current = await readSettings(fixture.stores.a);
    if (!current) throw new Error('Expected Settings fixture.');
    const eventsBefore = await settingsEventCount(fixture.stores.a);
    const operationId = randomUUID();
    interface FaultTarget {
      applyOperation: (...arguments_: unknown[]) => Promise<void>;
    }
    const target = settingsRepository as unknown as FaultTarget;
    const original = target.applyOperation;
    target.applyOperation = async () => {
      throw new Error('Task 7.4 test-only completion fault');
    };
    try {
      await expect(
        settingsWrites.update(
          {
            membershipRole: 'owner',
            storeId: access.a.storeId,
            userId: access.a.userId,
            deviceId: access.a.deviceId,
          },
          tenantContext(access.a),
          {
            operationId,
            expectedVersion: current.version,
            backupIntervalHours: current.backupIntervalHours + 1,
          },
        ),
      ).rejects.toThrow('Task 7.4 test-only completion fault');
    } finally {
      target.applyOperation = original;
    }
    expect(await readSettings(fixture.stores.a)).toEqual(current);
    expect(await readOperation(fixture.stores.a, operationId)).toBeNull();
    expect(await settingsEventCount(fixture.stores.a)).toBe(eventsBefore);
  });

  it('does not allow completed replay through suspended or archived authentication state', async () => {
    const current = await readSettings(fixture.stores.flip);
    if (!current) throw new Error('Expected Settings fixture.');
    const payload = {
      operationId: randomUUID(),
      expectedVersion: current.version,
      backupEnabled: !current.backupEnabled,
    };
    await patch(access.flip).send(payload).expect(200);
    await adminPool.query(`update ledger.stores set status = 'suspended' where id = $1`, [
      fixture.stores.flip,
    ]);
    await patch(access.flip).send(payload).expect(401);
    await adminPool.query(`update ledger.stores set status = 'archived' where id = $1`, [
      fixture.stores.flip,
    ]);
    await patch(access.flip).send(payload).expect(401);
    await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
      fixture.stores.flip,
    ]);
  });

  it('creates no accounting, inventory, central-audit, or non-null central URI effect', async () => {
    const result = await adminPool.query<{
      accountingInventory: number;
      auditLogs: number;
      uriRows: number;
    }>(
      `select
        ((select count(*) from ledger.sales where store_id = any($1::uuid[]))
          + (select count(*) from ledger.purchase_invoices where store_id = any($1::uuid[]))
          + (select count(*) from ledger.supplier_payments where store_id = any($1::uuid[]))
          + (select count(*) from ledger.customer_payments where store_id = any($1::uuid[]))
          + (select count(*) from ledger.expenses where store_id = any($1::uuid[]))
          + (select count(*) from ledger.money_movements where store_id = any($1::uuid[]))
          + (select count(*) from ledger.inventory_movements where store_id = any($1::uuid[]))
          + (select count(*) from ledger.stock_balances where store_id = any($1::uuid[])))::integer
            as "accountingInventory",
        (select count(*)::integer from audit.central_audit_logs where store_id = any($1::uuid[]))
          as "auditLogs",
        (select count(*)::integer from ledger.app_settings
          where store_id = any($1::uuid[])
            and (export_directory_uri is not null or attachments_directory_uri is not null))
          as "uriRows"`,
      [storeIds],
    );
    expect(result.rows[0]).toEqual({ accountingInventory: 0, auditLogs: 0, uriRows: 0 });
  });
});
