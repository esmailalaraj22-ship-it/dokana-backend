import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { AppSettingsReadRepository } from '../src/settings/app-settings-read.repository';
import type { AppSettingsReadModel } from '../src/settings/app-settings.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

const fixture = {
  stores: {
    a: '73000000-0000-4000-8000-000000000001',
    b: '73000000-0000-4000-8000-000000000002',
    readOnly: '73000000-0000-4000-8000-000000000003',
    missing: '73000000-0000-4000-8000-000000000004',
    suspended: '73000000-0000-4000-8000-000000000005',
    archived: '73000000-0000-4000-8000-000000000006',
    invalidTimezone: '73000000-0000-4000-8000-000000000007',
  },
  users: {
    ownerA: '73100000-0000-4000-8000-000000000001',
    ownerB: '73100000-0000-4000-8000-000000000002',
    readOnly: '73100000-0000-4000-8000-000000000003',
    missing: '73100000-0000-4000-8000-000000000004',
    suspended: '73100000-0000-4000-8000-000000000005',
    archived: '73100000-0000-4000-8000-000000000006',
    invalidTimezone: '73100000-0000-4000-8000-000000000007',
    manager: '73100000-0000-4000-8000-000000000008',
    viewer: '73100000-0000-4000-8000-000000000009',
    support: '73100000-0000-4000-8000-000000000010',
  },
  memberships: {
    ownerA: '73200000-0000-4000-8000-000000000001',
    ownerB: '73200000-0000-4000-8000-000000000002',
    readOnly: '73200000-0000-4000-8000-000000000003',
    missing: '73200000-0000-4000-8000-000000000004',
    suspended: '73200000-0000-4000-8000-000000000005',
    archived: '73200000-0000-4000-8000-000000000006',
    invalidTimezone: '73200000-0000-4000-8000-000000000007',
    manager: '73200000-0000-4000-8000-000000000008',
    viewer: '73200000-0000-4000-8000-000000000009',
    support: '73200000-0000-4000-8000-000000000010',
  },
  devices: {
    ownerA: '73300001-0001-4000-8000-000000000001',
    ownerB: '73300002-0002-4000-8000-000000000002',
    readOnly: '73300003-0003-4000-8000-000000000003',
    missing: '73300004-0004-4000-8000-000000000004',
    suspended: '73300005-0005-4000-8000-000000000005',
    archived: '73300006-0006-4000-8000-000000000006',
    invalidTimezone: '73300007-0007-4000-8000-000000000007',
    manager: '73300008-0008-4000-8000-000000000008',
    viewer: '73300009-0009-4000-8000-000000000009',
    support: '73300010-0010-4000-8000-000000000010',
  },
  emails: {
    ownerA: 'task73-owner-a@example.test',
    ownerB: 'task73-owner-b@example.test',
    readOnly: 'task73-read-only@example.test',
    missing: 'task73-missing@example.test',
    suspended: 'task73-suspended@example.test',
    archived: 'task73-archived@example.test',
    invalidTimezone: 'task73-invalid-timezone@example.test',
    manager: 'task73-manager@example.test',
    viewer: 'task73-viewer@example.test',
    support: 'task73-support@example.test',
  },
  password: 'Task-7.3-Test-Password!',
};

type AccessKey = keyof typeof fixture.emails;
type MembershipRole = 'owner' | 'manager' | 'viewer' | 'support';

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface ReadState {
  settingsSnapshot: string;
  storesSnapshot: string;
  processedOperations: number;
  changeEvents: number;
  auditLogs: number;
}

const storeByAccess: Readonly<Record<AccessKey, string>> = {
  ownerA: fixture.stores.a,
  ownerB: fixture.stores.b,
  readOnly: fixture.stores.readOnly,
  missing: fixture.stores.missing,
  suspended: fixture.stores.suspended,
  archived: fixture.stores.archived,
  invalidTimezone: fixture.stores.invalidTimezone,
  manager: fixture.stores.a,
  viewer: fixture.stores.a,
  support: fixture.stores.a,
};

const roleByAccess: Readonly<Record<AccessKey, MembershipRole>> = {
  ownerA: 'owner',
  ownerB: 'owner',
  readOnly: 'owner',
  missing: 'owner',
  suspended: 'owner',
  archived: 'owner',
  invalidTimezone: 'owner',
  manager: 'manager',
  viewer: 'viewer',
  support: 'support',
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

function readSettings(response: Response): AppSettingsReadModel {
  const body: unknown = response.body;
  if (!isRecord(body) || body.timezoneName !== 'Asia/Hebron') {
    throw new Error('Expected an app settings response.');
  }
  return body as unknown as AppSettingsReadModel;
}

class NullLogDestination implements DestinationStream {
  write(): void {
    return;
  }
}

describe('App settings read API with real PostgreSQL', () => {
  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const nullLogs = new NullLogDestination();
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimePool: Pool;
  let poolsInitialized = false;
  let access: Record<AccessKey, AccessIdentity>;
  let stateAfterSetup: ReadState;

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      `delete from platform.refresh_tokens
       where session_id in (
         select id from platform.auth_sessions where user_id = any($1::uuid[])
       )`,
      [userIds],
    );
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

  async function insertSettings(
    storeId: string,
    input: {
      reportMinutes: number;
      policy: 'allow' | 'warn' | 'block';
      creditLimit: string | null;
      version: string;
      timezone?: string;
    },
  ): Promise<void> {
    await adminPool.query(
      `
        insert into ledger.app_settings (
          store_id,
          daily_report_time_minutes,
          default_credit_policy,
          default_credit_limit_minor,
          allow_negative_stock,
          low_stock_alert_enabled,
          debt_age_alert_days,
          backup_enabled,
          backup_interval_hours,
          export_directory_uri,
          attachments_directory_uri,
          created_at,
          updated_at,
          version,
          timezone_name,
          business_day_start_minutes,
          business_day_end_minutes,
          business_day_mode
        )
        values (
          $1, $2, $3, $4::bigint, false, true, 45, true, 12, null, null,
          '2026-08-01T10:00:00Z'::timestamptz,
          '2026-08-20T12:30:00Z'::timestamptz,
          $5::bigint, $6, 720, 720, 'fixed_24h'
        )
      `,
      [
        storeId,
        input.reportMinutes,
        input.policy,
        input.creditLimit,
        input.version,
        input.timezone ?? 'Asia/Hebron',
      ],
    );
  }

  async function login(key: AccessKey): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId: storeByAccess[key],
        deviceId: fixture.devices[key],
        deviceName: `Task 7.3 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);

    return {
      accessToken: readAccessToken(response),
      storeId: storeByAccess[key],
      userId: fixture.users[key],
      deviceId: fixture.devices[key],
    };
  }

  function authorizedGet(identity: AccessIdentity, path = '/v1/settings') {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  async function readState(): Promise<ReadState> {
    const result = await adminPool.query<ReadState>(
      `
        select
          coalesce(
            (select jsonb_agg(to_jsonb(settings_state) order by settings_state.store_id)::text
             from ledger.app_settings as settings_state
             where settings_state.store_id = any($1::uuid[])),
            '[]'
          ) as "settingsSnapshot",
          coalesce(
            (select jsonb_agg(to_jsonb(store_state) order by store_state.id)::text
             from ledger.stores as store_state
             where store_state.id = any($1::uuid[])),
            '[]'
          ) as "storesSnapshot",
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
      throw new Error('Expected settings read-side state.');
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

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task73-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimePool = createTestPool(environment.runtimeUrl, 'dokana-task73-runtime', 1);
    poolsInitialized = true;

    const approvedDatabase = await adminPool.query<{ databaseName: string; isSuperuser: boolean }>(`
      select current_database() as "databaseName", role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state where role_state.rolname = current_user
    `);
    if (
      approvedDatabase.rows[0]?.databaseName !== environment.databaseName ||
      !approvedDatabase.rows[0].isSuperuser
    ) {
      throw new Error('The local settings fixture database is not approved.');
    }

    await removeFixtures();
    for (const [key, storeId] of Object.entries(fixture.stores)) {
      await adminPool.query(
        `insert into ledger.stores (id, name, status) values ($1, $2, 'active')`,
        [storeId, `Task 7.3 ${key} Store`],
      );
    }

    const passwordHash = await new PasswordService().hash(fixture.password);
    for (const key of accessKeys) {
      await adminPool.query(
        `insert into platform.users (
           id, email, normalized_email, password_hash, full_name, status
         ) values ($1, $2, $2, $3, $4, 'active')`,
        [fixture.users[key], fixture.emails[key], passwordHash, `Task 7.3 ${key}`],
      );
      await adminPool.query(
        `insert into platform.store_memberships (id, store_id, user_id, role, status)
         values ($1, $2, $3, $4, 'active')`,
        [fixture.memberships[key], storeByAccess[key], fixture.users[key], roleByAccess[key]],
      );
    }

    await insertSettings(fixture.stores.a, {
      reportMinutes: 1170,
      policy: 'allow',
      creditLimit: '9007199254740993',
      version: '9007199254740995',
    });
    await insertSettings(fixture.stores.b, {
      reportMinutes: 300,
      policy: 'warn',
      creditLimit: null,
      version: '2',
    });
    await insertSettings(fixture.stores.readOnly, {
      reportMinutes: 600,
      policy: 'block',
      creditLimit: null,
      version: '3',
    });
    await insertSettings(fixture.stores.suspended, {
      reportMinutes: 700,
      policy: 'warn',
      creditLimit: null,
      version: '4',
    });
    await insertSettings(fixture.stores.archived, {
      reportMinutes: 800,
      policy: 'warn',
      creditLimit: null,
      version: '5',
    });
    await insertSettings(fixture.stores.invalidTimezone, {
      reportMinutes: 900,
      policy: 'warn',
      creditLimit: null,
      version: '6',
      timezone: 'UTC',
    });

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
    for (const key of accessKeys) {
      access[key] = await login(key);
    }

    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.readOnly,
    ]);
    await adminPool.query(`update ledger.stores set status = 'suspended' where id = $1`, [
      fixture.stores.suspended,
    ]);
    await adminPool.query(`update ledger.stores set status = 'archived' where id = $1`, [
      fixture.stores.archived,
    ]);
    stateAfterSetup = await readState();
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
          (select count(*) from platform.refresh_tokens
           where session_id in (
             select id from platform.auth_sessions where user_id = any($2::uuid[])
           ))
          + (select count(*) from platform.auth_sessions where user_id = any($2::uuid[]))
          + (select count(*) from ledger.app_settings where store_id = any($1::uuid[]))
          + (select count(*) from ledger.devices where store_id = any($1::uuid[]))
          + (select count(*) from platform.store_memberships where id = any($3::uuid[]))
          + (select count(*) from platform.users where id = any($2::uuid[]))
          + (select count(*) from ledger.stores where id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimePool.end(), adminPool.end()]);
  }, 30_000);

  it('requires authentication and owner authority while allowing active and read_only owners', async () => {
    await request(server).get('/v1/settings').expect(401);

    for (const role of ['manager', 'viewer', 'support'] as const) {
      await authorizedGet(access[role])
        .expect(403)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'SETTINGS_READ_NOT_ALLOWED' });
        });
    }

    await authorizedGet(access.ownerA).expect(200);
    const readOnly = readSettings(await authorizedGet(access.readOnly).expect(200));
    expect(readOnly).toMatchObject({
      dailyReportTimeMinutes: 600,
      defaultCreditPolicy: 'block',
      timezoneName: 'Asia/Hebron',
    });

    await authorizedGet(access.suspended).expect(401);
    await authorizedGet(access.archived).expect(401);
  });

  it('returns the exact tenant projection with lossless values and no physical-field leakage', async () => {
    const ownerA = readSettings(await authorizedGet(access.ownerA).expect(200));
    expect(Object.keys(ownerA).sort()).toEqual(
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
      ].sort(),
    );
    expect(ownerA).toEqual({
      dailyReportTimeMinutes: 1170,
      defaultCreditPolicy: 'allow',
      defaultCreditLimitMinor: '9007199254740993',
      allowNegativeStock: false,
      lowStockAlertEnabled: true,
      debtAgeAlertDays: 45,
      backupEnabled: true,
      backupIntervalHours: 12,
      timezoneName: 'Asia/Hebron',
      version: '9007199254740995',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-20T12:30:00.000Z',
    });

    const ownerB = readSettings(await authorizedGet(access.ownerB).expect(200));
    expect(ownerB).toMatchObject({
      dailyReportTimeMinutes: 300,
      defaultCreditPolicy: 'warn',
      defaultCreditLimitMinor: null,
      version: '2',
    });
  });

  it('does not allow header or query tenant input to redirect the current Store read', async () => {
    const forged = readSettings(
      await authorizedGet(access.ownerA, `/v1/settings?storeId=${fixture.stores.b}`)
        .set('x-store-id', fixture.stores.b)
        .expect(200),
    );
    expect(forged.dailyReportTimeMinutes).toBe(1170);
    expect(forged.defaultCreditLimitMinor).toBe('9007199254740993');
  });

  it('returns stable errors for a missing singleton and invalid physical timezone without writes', async () => {
    await authorizedGet(access.missing)
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'SETTINGS_NOT_INITIALIZED' });
      });
    const missingCount = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.app_settings where store_id = $1`,
      [fixture.stores.missing],
    );
    expect(missingCount.rows[0]?.count).toBe(0);

    await authorizedGet(access.invalidTimezone)
      .expect(503)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'SETTINGS_TIMEZONE_UNSUPPORTED' });
      });
  });

  it('uses forced RLS and transaction-local context for cross-tenant repository reads', async () => {
    if (!app || !environment) {
      throw new Error('The settings integration application is unavailable.');
    }
    const runtimeState = await runtimePool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      ownsSettings: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        pg_get_userbyid(settings_table.relowner) = current_user as "ownsSettings",
        settings_table.relrowsecurity as "rlsEnabled",
        settings_table.relforcerowsecurity as "rlsForced"
      from pg_roles as role_state
      cross join pg_class as settings_table
      where role_state.rolname = current_user
        and settings_table.oid = 'ledger.app_settings'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      ownsSettings: false,
      rlsEnabled: true,
      rlsForced: true,
    });
    const noContext = await runtimePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.app_settings
       where store_id = any($1::uuid[])`,
      [storeIds],
    );
    expect(noContext.rows[0]?.count).toBe(0);

    const repository = app.get(AppSettingsReadRepository);
    const [settingsA, settingsB] = await Promise.all([
      repository.findForCurrentStore({
        storeId: access.ownerA.storeId,
        userId: access.ownerA.userId,
        deviceId: access.ownerA.deviceId,
        requestId: randomUUID(),
      }),
      repository.findForCurrentStore({
        storeId: access.ownerB.storeId,
        userId: access.ownerB.userId,
        deviceId: access.ownerB.deviceId,
        requestId: randomUUID(),
      }),
    ]);
    expect(settingsA?.dailyReportTimeMinutes).toBe(1170);
    expect(settingsB?.dailyReportTimeMinutes).toBe(300);

    await expect(
      repository.findForCurrentStore(
        undefined as unknown as Parameters<AppSettingsReadRepository['findForCurrentStore']>[0],
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('creates no settings, Store, operation, event, or audit side effects', async () => {
    expect(await readState()).toEqual(stateAfterSetup);
  });
});
