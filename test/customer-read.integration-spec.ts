import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { Controller, Get, Query, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { normalizeCustomerName } from '../src/customers/customer-normalization';
import { decodeCustomerCursor } from '../src/customers/customer-read-cursor';
import { CustomerReadRepository } from '../src/customers/customer-read.repository';
import type { CustomerListResponse } from '../src/customers/customer-read.types';
import { DatabaseService } from '../src/database/database.service';
import { customers } from '../src/database/schema';
import type { TenantTransactionContext } from '../src/database/database.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: '43000000-0000-4000-8000-000000000001',
    b: '43000000-0000-4000-8000-000000000002',
    readOnly: '43000000-0000-4000-8000-000000000003',
  },
  users: {
    a: '43100000-0000-4000-8000-000000000001',
    b: '43100000-0000-4000-8000-000000000002',
    readOnly: '43100000-0000-4000-8000-000000000003',
  },
  memberships: {
    a: '43200000-0000-4000-8000-000000000001',
    b: '43200000-0000-4000-8000-000000000002',
    readOnly: '43200000-0000-4000-8000-000000000003',
  },
  devices: {
    a: '43500000-0000-4000-8000-000000000001',
    b: '43500000-0000-4000-8000-000000000002',
    readOnly: '43500000-0000-4000-8000-000000000003',
  },
  emails: {
    a: 'task432-a@example.test',
    b: 'task432-b@example.test',
    readOnly: 'task432-read-only@example.test',
  },
  password: 'Task-4.3.2-Test-Password!',
  customers: {
    aAhmad1: '43300000-0000-4000-8000-000000000001',
    aAhmad2: '43300000-0000-4000-8000-000000000002',
    aArchived: '43300000-0000-4000-8000-000000000003',
    aAlice: '43300000-0000-4000-8000-000000000004',
    aPercent: '43300000-0000-4000-8000-000000000005',
    aUnderscore: '43300000-0000-4000-8000-000000000006',
    aPhone: '43300000-0000-4000-8000-000000000007',
    aPhoneName1: '43300000-0000-4000-8000-000000000008',
    aPhoneName2: '43300000-0000-4000-8000-000000000009',
    aPageAlpha1: '43300000-0000-4000-8000-000000000011',
    aPageAlpha2: '43300000-0000-4000-8000-000000000012',
    aPageBeta: '43300000-0000-4000-8000-000000000013',
    aPageDelta: '43300000-0000-4000-8000-000000000014',
    bPhone: '43300000-0000-4000-8000-000000000101',
    bArchived: '43300000-0000-4000-8000-000000000102',
    readOnly: '43300000-0000-4000-8000-000000000201',
  },
};

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface CustomerFixtureRecord {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  phone: string;
  normalizedPhone: string;
  status?: 'active' | 'archived';
  notes?: string;
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

class SynchronousLogCapture implements DestinationStream {
  private output = '';

  write(message: string): void {
    this.output += message;
  }

  clear(): void {
    this.output = '';
  }

  flush(): string {
    return this.output;
  }

  records(): Record<string, unknown>[] {
    return this.output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isRecord);
  }
}

@Controller('privacy-probe')
class PrivacyProbeController {
  @Get('failure')
  fail(@Query('search') search: unknown): never {
    throw new Error(`Synthetic privacy probe failed for ${String(search)}`);
  }
}

function readList(response: Response): CustomerListResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Expected a Customer list response.');
  }
  return body as unknown as CustomerListResponse;
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

describe('Customer read API with real PostgreSQL', () => {
  const logCapture = new SynchronousLogCapture();
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<'a' | 'b' | 'readOnly', AccessIdentity>;

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const customerIds = Object.values(fixture.customers);

  const customerRecords: CustomerFixtureRecord[] = [
    {
      id: fixture.customers.aPageDelta,
      storeId: fixture.stores.a,
      name: 'Page Delta',
      normalizedName: 'page delta',
      phone: '0599 000 014',
      normalizedPhone: '+970599000014',
    },
    {
      id: fixture.customers.aAhmad2,
      storeId: fixture.stores.a,
      name: 'أحمــد',
      normalizedName: 'احمد',
      phone: '0599 000 002',
      normalizedPhone: '+970599000002',
    },
    {
      id: fixture.customers.aPageBeta,
      storeId: fixture.stores.a,
      name: 'Page Beta',
      normalizedName: 'page beta',
      phone: '0599 000 013',
      normalizedPhone: '+970599000013',
    },
    {
      id: fixture.customers.aPhoneName2,
      storeId: fixture.stores.a,
      name: '+970599123456 Beta',
      normalizedName: '+970599123456 beta',
      phone: '0599 000 009',
      normalizedPhone: '+970599000009',
    },
    {
      id: fixture.customers.aAlice,
      storeId: fixture.stores.a,
      name: 'Alice',
      normalizedName: 'alice',
      phone: '0599 000 004',
      normalizedPhone: '+970599000004',
    },
    {
      id: fixture.customers.aPageAlpha2,
      storeId: fixture.stores.a,
      name: 'Page Alpha Duplicate',
      normalizedName: 'page alpha',
      phone: '0599 000 012',
      normalizedPhone: '+970599000012',
    },
    {
      id: fixture.customers.aArchived,
      storeId: fixture.stores.a,
      name: 'محمد مؤرشف',
      normalizedName: 'محمد مؤرشف',
      phone: '0599 000 003',
      normalizedPhone: '+970599000003',
      status: 'archived',
      notes: 'Historical Customer',
    },
    {
      id: fixture.customers.aPhone,
      storeId: fixture.stores.a,
      name: 'Phone Target',
      normalizedName: 'phone target',
      phone: '0599 123 456',
      normalizedPhone: '+970599123456',
      notes: 'Exact phone Customer',
      version: '9007199254740993',
    },
    {
      id: fixture.customers.aPercent,
      storeId: fixture.stores.a,
      name: 'Ali% Customer',
      normalizedName: 'ali% customer',
      phone: '0599 000 005',
      normalizedPhone: '+970599000005',
    },
    {
      id: fixture.customers.aAhmad1,
      storeId: fixture.stores.a,
      name: 'أحمد',
      normalizedName: 'احمد',
      phone: '0599 000 001',
      normalizedPhone: '+970599000001',
    },
    {
      id: fixture.customers.aUnderscore,
      storeId: fixture.stores.a,
      name: 'Ali_ Customer',
      normalizedName: 'ali_ customer',
      phone: '0599 000 006',
      normalizedPhone: '+970599000006',
    },
    {
      id: fixture.customers.aPhoneName1,
      storeId: fixture.stores.a,
      name: '+970599123456 Alpha',
      normalizedName: '+970599123456 alpha',
      phone: '0599 000 008',
      normalizedPhone: '+970599000008',
    },
    {
      id: fixture.customers.aPageAlpha1,
      storeId: fixture.stores.a,
      name: 'Page Alpha',
      normalizedName: 'page alpha',
      phone: '0599 000 011',
      normalizedPhone: '+970599000011',
    },
    {
      id: fixture.customers.bPhone,
      storeId: fixture.stores.b,
      name: 'أحمد متجر ب',
      normalizedName: 'احمد متجر ب',
      phone: '0599 123 456',
      normalizedPhone: '+970599123456',
    },
    {
      id: fixture.customers.bArchived,
      storeId: fixture.stores.b,
      name: 'محمد مؤرشف ب',
      normalizedName: 'محمد مؤرشف ب',
      phone: '0599 000 102',
      normalizedPhone: '+970599000102',
      status: 'archived',
    },
    {
      id: fixture.customers.readOnly,
      storeId: fixture.stores.readOnly,
      name: 'Read Only Customer',
      normalizedName: 'read only customer',
      phone: '0599 000 201',
      normalizedPhone: '+970599000201',
    },
  ];

  async function removeFixtures(): Promise<void> {
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
    ]);
    await adminPool.query(`delete from ledger.customers where id = any($1::uuid[])`, [customerIds]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function insertCustomer(
    record: CustomerFixtureRecord,
    operationIndex: number,
  ): Promise<void> {
    await adminPool.query(
      `
        insert into ledger.customers (
          id,
          store_id,
          name,
          normalized_name,
          phone,
          normalized_phone,
          notes,
          status,
          archived_at,
          operation_id,
          version
        )
        values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          case when $8 = 'archived' then '2026-08-01T00:00:00Z'::timestamptz else null end,
          $9,
          $10::bigint
        )
      `,
      [
        record.id,
        record.storeId,
        record.name,
        record.normalizedName,
        record.phone,
        record.normalizedPhone,
        record.notes ?? null,
        record.status ?? 'active',
        `43400000-0000-4000-8000-${operationIndex.toString().padStart(12, '0')}`,
        record.version ?? '1',
      ],
    );
  }

  async function login(
    key: 'a' | 'b' | 'readOnly',
    storeId: string,
    userId: string,
    deviceId: string,
    email: string,
  ): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email,
        password: fixture.password,
        storeId,
        deviceId,
        deviceName: `Task 4.3.2 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);

    return { accessToken: readAccessToken(response), storeId, userId, deviceId };
  }

  function authorizedGet(identity: AccessIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
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
      'dokana-task432-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-task432-runtime-inspection',
      1,
    );
    poolsInitialized = true;

    const approvedDatabase = await adminPool.query<{
      databaseName: string;
      isSuperuser: boolean;
    }>(`
      select
        current_database() as "databaseName",
        role_state.rolsuper as "isSuperuser"
      from pg_roles as role_state
      where role_state.rolname = current_user
    `);
    if (
      approvedDatabase.rows[0]?.databaseName !== environment.databaseName ||
      !approvedDatabase.rows[0].isSuperuser
    ) {
      throw new Error('The local Customer fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 4.3.2 Store A', 'active'),
          ($2, 'Task 4.3.2 Store B', 'active'),
          ($3, 'Task 4.3.2 Read Only', 'read_only')
      `,
      [fixture.stores.a, fixture.stores.b, fixture.stores.readOnly],
    );
    await adminPool.query(
      `
        insert into platform.users (
          id,
          email,
          normalized_email,
          password_hash,
          full_name,
          status
        )
        values
          ($1, $2, $2, $7, 'Task 4.3.2 Owner A', 'active'),
          ($3, $4, $4, $7, 'Task 4.3.2 Owner B', 'active'),
          ($5, $6, $6, $7, 'Task 4.3.2 Read Only Owner', 'active')
      `,
      [
        fixture.users.a,
        fixture.emails.a,
        fixture.users.b,
        fixture.emails.b,
        fixture.users.readOnly,
        fixture.emails.readOnly,
        passwordHash,
      ],
    );
    await adminPool.query(
      `
        insert into platform.store_memberships (id, store_id, user_id, role, status)
        values
          ($1, $2, $3, 'owner', 'active'),
          ($4, $5, $6, 'owner', 'active'),
          ($7, $8, $9, 'owner', 'active')
      `,
      [
        fixture.memberships.a,
        fixture.stores.a,
        fixture.users.a,
        fixture.memberships.b,
        fixture.stores.b,
        fixture.users.b,
        fixture.memberships.readOnly,
        fixture.stores.readOnly,
        fixture.users.readOnly,
      ],
    );
    for (const [index, customer] of customerRecords.entries()) {
      await insertCustomer(customer, index + 1);
    }

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PrivacyProbeController],
    })
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
      a: await login('a', fixture.stores.a, fixture.users.a, fixture.devices.a, fixture.emails.a),
      b: await login('b', fixture.stores.b, fixture.users.b, fixture.devices.b, fixture.emails.b),
      readOnly: await login(
        'readOnly',
        fixture.stores.readOnly,
        fixture.users.readOnly,
        fixture.devices.readOnly,
        fixture.emails.readOnly,
      ),
    };
  }, 60_000);

  beforeEach(() => {
    logCapture.clear();
  });

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
          + (select count(*) from ledger.customers where id = any($4::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds, customerIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  }, 30_000);

  it('requires live authentication and validates list queries and detail UUIDs strictly', async () => {
    await request(server).get('/v1/customers').expect(401);

    for (const query of [
      { status: 'all' },
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { cursor: 'not-valid' },
      { unexpected: 'value' },
      { storeId: fixture.stores.b },
    ]) {
      const response = await authorizedGet(access.a, '/v1/customers').query(query).expect(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    }

    await authorizedGet(access.a, '/v1/customers/not-a-uuid')
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'VALIDATION_ERROR' });
      });
  });

  it('distinguishes an omitted cursor from every supplied invalid cursor form', async () => {
    const firstPage = readList(
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: 'Page', limit: 2 })
        .expect(200),
    );
    if (!firstPage.nextCursor) {
      throw new Error('Expected a valid Customer continuation cursor.');
    }

    for (const path of [
      '/v1/customers?cursor',
      '/v1/customers?cursor=',
      '/v1/customers?cursor=%20',
      '/v1/customers?cursor=not-valid',
    ]) {
      await authorizedGet(access.a, path)
        .expect(400)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            code: 'VALIDATION_ERROR',
            details: [{ field: 'cursor', constraints: ['customerCursor'] }],
          });
        });
    }

    await authorizedGet(access.a, '/v1/customers')
      .query({ search: 'Page', limit: 2, cursor: firstPage.nextCursor })
      .expect(200);
    await authorizedGet(access.a, '/v1/customers')
      .query({ status: 'archived', search: 'Page', limit: 2, cursor: firstPage.nextCursor })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'VALIDATION_ERROR',
          details: [{ field: 'cursor', constraints: ['customerCursorScope'] }],
        });
      });
  });

  it('rejects different and identical duplicate scalar query parameters', async () => {
    const firstPage = readList(
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: 'Page', limit: 2 })
        .expect(200),
    );
    if (!firstPage.nextCursor) {
      throw new Error('Expected a valid Customer continuation cursor.');
    }
    const cursor = encodeURIComponent(firstPage.nextCursor);
    const duplicateQueries = [
      '/v1/customers?search=Page&search=Alice',
      '/v1/customers?search=Page&search=Page',
      '/v1/customers?status=active&status=archived',
      '/v1/customers?status=active&status=active',
      '/v1/customers?limit=10&limit=100',
      '/v1/customers?limit=10&limit=10',
      `/v1/customers?cursor=${cursor}&cursor=not-valid`,
      `/v1/customers?cursor=${cursor}&cursor=${cursor}`,
    ];

    for (const path of duplicateQueries) {
      await authorizedGet(access.a, path)
        .expect(400)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    }
  });

  it('lists only the trusted tenant and selected active or archived status', async () => {
    const aDefault = readList(await authorizedGet(access.a, '/v1/customers').expect(200));
    const bDefault = readList(await authorizedGet(access.b, '/v1/customers').expect(200));
    const aArchived = readList(
      await authorizedGet(access.a, '/v1/customers').query({ status: 'archived' }).expect(200),
    );

    expect(aDefault.items.length).toBe(12);
    expect(aDefault.items.map((item) => item.id)).not.toContain(fixture.customers.aArchived);
    expect(aDefault.items.map((item) => item.id)).not.toContain(fixture.customers.bPhone);
    for (const item of aDefault.items) {
      expect(Object.keys(item).sort()).toEqual([
        'archivedAt',
        'id',
        'name',
        'phone',
        'status',
        'updatedAt',
      ]);
    }
    expect(bDefault.items.map((item) => item.id)).toEqual([fixture.customers.bPhone]);
    expect(aArchived.items.map((item) => item.id)).toEqual([fixture.customers.aArchived]);
    expect(aArchived.items.map((item) => item.id)).not.toContain(fixture.customers.bArchived);
  });

  it('integrates normalization-v1 name and exact-phone search without crossing status or tenant', async () => {
    for (const search of ['  أَحْــمَد  ', 'أحمد', 'AHMAD']) {
      const response = readList(
        await authorizedGet(access.a, '/v1/customers').query({ search }).expect(200),
      );
      if (search === 'AHMAD') {
        expect(response.items).toEqual([]);
      } else {
        expect(response.items.map((item) => item.id)).toEqual([
          fixture.customers.aAhmad1,
          fixture.customers.aAhmad2,
        ]);
      }
    }

    const latin = readList(
      await authorizedGet(access.a, '/v1/customers').query({ search: 'ALIce' }).expect(200),
    );
    expect(latin.items.map((item) => item.id)).toEqual([fixture.customers.aAlice]);

    for (const search of ['0599 123 456', '+970599123456', '٠٥٩٩ ١٢٣ ٤٥٦', '۰۵۹۹ ۱۲۳ ۴۵۶']) {
      const phone = readList(
        await authorizedGet(access.a, '/v1/customers').query({ search }).expect(200),
      );
      expect(phone.items.map((item) => item.id)).toEqual([
        fixture.customers.aPhoneName1,
        fixture.customers.aPhoneName2,
        fixture.customers.aPhone,
      ]);
      expect(phone.items.map((item) => item.id)).not.toContain(fixture.customers.bPhone);
    }

    const archivedPhone = readList(
      await authorizedGet(access.b, '/v1/customers')
        .query({ status: 'archived', search: '0599 000 102' })
        .expect(200),
    );
    expect(archivedPhone.items.map((item) => item.id)).toEqual([fixture.customers.bArchived]);
  });

  it('treats percent, underscore, and backslash as literal name-prefix input', async () => {
    const percent = readList(
      await authorizedGet(access.a, '/v1/customers').query({ search: 'Ali%' }).expect(200),
    );
    const underscore = readList(
      await authorizedGet(access.a, '/v1/customers').query({ search: 'Ali_' }).expect(200),
    );
    const backslash = readList(
      await authorizedGet(access.a, '/v1/customers').query({ search: 'Ali\\' }).expect(200),
    );

    expect(percent.items.map((item) => item.id)).toEqual([fixture.customers.aPercent]);
    expect(underscore.items.map((item) => item.id)).toEqual([fixture.customers.aUnderscore]);
    expect(backslash.items).toEqual([]);
  });

  it('uses deterministic keyset pages, limit plus one, and canonical scope binding', async () => {
    const first = readList(
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: 'Page', limit: 2 })
        .expect(200),
    );
    expect(first.items.map((item) => item.id)).toEqual([
      fixture.customers.aPageAlpha1,
      fixture.customers.aPageAlpha2,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = readList(
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: 'PAGE', limit: 2, cursor: first.nextCursor })
        .expect(200),
    );
    expect(second.items.map((item) => item.id)).toEqual([
      fixture.customers.aPageBeta,
      fixture.customers.aPageDelta,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);

    const crossTenantCursor = readList(
      await authorizedGet(access.b, '/v1/customers')
        .query({ search: 'Page', limit: 2, cursor: first.nextCursor })
        .expect(200),
    );
    expect(crossTenantCursor.items).toEqual([]);

    await authorizedGet(access.a, '/v1/customers')
      .query({ status: 'archived', search: 'Page', limit: 2, cursor: first.nextCursor })
      .expect(400);
    await authorizedGet(access.a, '/v1/customers')
      .query({ search: 'Other', limit: 2, cursor: first.nextCursor })
      .expect(400);

    const phoneFirst = readList(
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: '0599 123 456', limit: 1 })
        .expect(200),
    );
    const phoneSecond = readList(
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: '٠٥٩٩١٢٣٤٥٦', limit: 1, cursor: phoneFirst.nextCursor })
        .expect(200),
    );
    expect(phoneFirst.items[0]?.id).toBe(fixture.customers.aPhoneName1);
    expect(phoneSecond.items[0]?.id).toBe(fixture.customers.aPhoneName2);

    await authorizedGet(access.a, '/v1/customers').query({ limit: 1 }).expect(200);
    await authorizedGet(access.a, '/v1/customers').query({ limit: 100 }).expect(200);
  });

  it('omits sensitive Customer query state from the synchronous production logging pipeline', async () => {
    const nameSearch = 'CUSTOMER_SEARCH_SECRET_S44H1';
    const normalizedNameSearch = normalizeCustomerName(nameSearch);
    const invalidPhoneSearch = 'CUSTOMER_PHONE_FALLBACK_SECRET_S44H1';
    const normalizedInvalidPhoneSearch = normalizeCustomerName(invalidPhoneSearch);
    const unicodeSearch = '\u062e\u0635\u0648\u0635\u064a\u0629 CUSTOMER_UNICODE_SECRET_S44H1';
    const encodedUnicodeSearch = encodeURIComponent(unicodeSearch);
    const normalizedUnicodeSearch = normalizeCustomerName(unicodeSearch);
    const phoneSearch = '0599 123 456';
    const canonicalPhone = '+970599123456';
    const duplicateSearches = [
      'CUSTOMER_DUPLICATE_SEARCH_SECRET_A',
      'CUSTOMER_DUPLICATE_SEARCH_SECRET_B',
    ] as const;
    const overBudgetSearch = '\ufdfa'.repeat(21) + 'a'.repeat(7);
    const normalizedOverBudgetSearch = normalizeCustomerName(overBudgetSearch);
    const malformedCursor = 'CUSTOMER_CURSOR_SECRET_MALFORMED_S44H1';
    const privacyCustomerIds = [randomUUID(), randomUUID()];

    try {
      await insertCustomer(
        {
          id: privacyCustomerIds[0] ?? '',
          storeId: fixture.stores.a,
          name: `${nameSearch} Alpha`,
          normalizedName: `${normalizedNameSearch} alpha`,
          phone: '0599 440 301',
          normalizedPhone: '+970599440301',
        },
        9_001,
      );
      await insertCustomer(
        {
          id: privacyCustomerIds[1] ?? '',
          storeId: fixture.stores.a,
          name: `${nameSearch} Beta`,
          normalizedName: `${normalizedNameSearch} beta`,
          phone: '0599 440 302',
          normalizedPhone: '+970599440302',
        },
        9_002,
      );

      const firstPage = readList(
        await authorizedGet(access.a, '/v1/customers')
          .query({ search: nameSearch, limit: 1 })
          .expect(200),
      );
      if (!firstPage.nextCursor) {
        throw new Error('Expected a privacy-test Customer continuation cursor.');
      }
      const decodedCursor = decodeCustomerCursor(firstPage.nextCursor);
      const secondPage = readList(
        await authorizedGet(access.a, '/v1/customers')
          .query({ search: nameSearch, limit: 1, cursor: firstPage.nextCursor })
          .expect(200),
      );
      expect([...firstPage.items, ...secondPage.items]).toHaveLength(2);
      expect(secondPage.nextCursor).toBeNull();

      await authorizedGet(access.a, '/v1/customers').query({ search: phoneSearch }).expect(200);
      await authorizedGet(access.a, '/v1/customers')
        .query({ search: invalidPhoneSearch })
        .expect(200);
      await authorizedGet(access.a, `/v1/customers?search=${encodedUnicodeSearch}`).expect(200);

      const duplicateSearchResponse = await authorizedGet(
        access.a,
        `/v1/customers?search=${encodeURIComponent(duplicateSearches[0])}&search=${encodeURIComponent(duplicateSearches[1])}`,
      ).expect(400);
      expect(duplicateSearchResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });
      const identicalSearchResponse = await authorizedGet(
        access.a,
        `/v1/customers?search=${encodeURIComponent(duplicateSearches[0])}&search=${encodeURIComponent(duplicateSearches[0])}`,
      ).expect(400);
      expect(identicalSearchResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });
      await authorizedGet(access.a, '/v1/customers?search=').expect(200);

      const overBudgetResponse = await authorizedGet(
        access.a,
        `/v1/customers?search=${encodeURIComponent(overBudgetSearch)}`,
      ).expect(400);
      expect(overBudgetResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });

      const malformedCursorResponse = await authorizedGet(
        access.a,
        `/v1/customers?cursor=${encodeURIComponent(malformedCursor)}`,
      ).expect(400);
      expect(malformedCursorResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });
      const emptyCursorResponse = await authorizedGet(access.a, '/v1/customers?cursor=').expect(
        400,
      );
      expect(emptyCursorResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });

      const encodedCursor = encodeURIComponent(firstPage.nextCursor);
      const duplicateCursorResponse = await authorizedGet(
        access.a,
        `/v1/customers?search=${encodeURIComponent(nameSearch)}&cursor=${encodedCursor}&cursor=${encodedCursor}`,
      ).expect(400);
      expect(duplicateCursorResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });
      const differentCursorResponse = await authorizedGet(
        access.a,
        `/v1/customers?search=${encodeURIComponent(nameSearch)}&cursor=${encodedCursor}&cursor=${encodeURIComponent(malformedCursor)}`,
      ).expect(400);
      expect(differentCursorResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });
      const scopeMismatchResponse = await authorizedGet(
        access.a,
        `/v1/customers?status=archived&search=${encodeURIComponent(nameSearch)}&cursor=${encodedCursor}`,
      ).expect(400);
      expect(scopeMismatchResponse.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        path: '/v1/customers',
      });

      const capturedOutput = logCapture.flush();
      const sensitiveRepresentations = new Set([
        nameSearch,
        encodeURIComponent(nameSearch),
        normalizedNameSearch,
        phoneSearch,
        encodeURIComponent(phoneSearch),
        canonicalPhone,
        invalidPhoneSearch,
        normalizedInvalidPhoneSearch,
        unicodeSearch,
        encodedUnicodeSearch,
        normalizedUnicodeSearch,
        ...duplicateSearches,
        ...duplicateSearches.map(encodeURIComponent),
        overBudgetSearch,
        encodeURIComponent(overBudgetSearch),
        normalizedOverBudgetSearch,
        malformedCursor,
        encodeURIComponent(malformedCursor),
        firstPage.nextCursor,
        encodedCursor,
        decodedCursor.search?.normalizedNamePrefix ?? '',
        decodedCursor.search?.canonicalPhone ?? '',
        decodedCursor.position.normalizedName,
        decodedCursor.position.id,
      ]);
      for (const sensitiveValue of sensitiveRepresentations) {
        if (sensitiveValue.length > 0) {
          expect(capturedOutput).not.toContain(sensitiveValue);
        }
      }

      const requestRecords = logCapture.records().filter((record) => {
        const loggedRequest = record.req;
        return isRecord(loggedRequest) && loggedRequest.url === '/v1/customers';
      });
      expect(requestRecords.length).toBeGreaterThanOrEqual(14);
      for (const record of requestRecords) {
        const loggedRequest = record.req;
        if (!isRecord(loggedRequest)) {
          throw new Error('Expected a structured Customer request log.');
        }
        expect(loggedRequest).toMatchObject({ method: 'GET', url: '/v1/customers' });
        expect(String(loggedRequest.url)).not.toContain('?');
        expect(typeof record.requestId).toBe('string');
        expect(typeof record.responseTime).toBe('number');
        if (!isRecord(record.res)) {
          throw new Error('Expected a structured Customer response log.');
        }
        expect(typeof record.res.statusCode).toBe('number');
      }
      expect(
        requestRecords.some((record) => isRecord(record.res) && record.res.statusCode === 200),
      ).toBe(true);
      expect(
        requestRecords.some((record) => isRecord(record.res) && record.res.statusCode === 400),
      ).toBe(true);
    } finally {
      await adminPool.query(`delete from ledger.customers where id = any($1::uuid[])`, [
        privacyCustomerIds,
      ]);
    }
  });

  it('keeps 5xx exception observability query-free without suppressing safe metadata', async () => {
    const canary = 'CUSTOMER_EXCEPTION_QUERY_SECRET_S44H1';
    const response = await request(server)
      .get(`/v1/privacy-probe/failure?search=${encodeURIComponent(canary)}`)
      .expect(500);

    expect(response.body).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      path: '/v1/privacy-probe/failure',
    });
    const capturedOutput = logCapture.flush();
    expect(capturedOutput).not.toContain(canary);
    expect(capturedOutput).not.toContain(encodeURIComponent(canary));

    const failureRecord = logCapture.records().find((record) => record.event === 'request_failed');
    expect(failureRecord).toMatchObject({
      path: '/v1/privacy-probe/failure',
      method: 'GET',
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      errorType: 'Error',
    });
    const accessRecord = logCapture.records().find((record) => {
      const loggedRequest = record.req;
      return isRecord(loggedRequest) && loggedRequest.url === '/v1/privacy-probe/failure';
    });
    if (!accessRecord) {
      throw new Error('Expected a structured privacy-probe access log.');
    }
    expect(accessRecord).toMatchObject({
      req: { method: 'GET', url: '/v1/privacy-probe/failure' },
      res: { statusCode: 500 },
    });
    expect(typeof accessRecord.requestId).toBe('string');
    expect(typeof accessRecord.responseTime).toBe('number');
  });

  it('preserves non-Customer access metadata while omitting its query string globally', async () => {
    const canary = 'NON_CUSTOMER_QUERY_SECRET_S44H1';
    await request(server)
      .get(`/health/live?probe=${encodeURIComponent(canary)}`)
      .expect(200);

    const capturedOutput = logCapture.flush();
    expect(capturedOutput).not.toContain(canary);
    const accessRecord = logCapture.records().find((record) => {
      const loggedRequest = record.req;
      return isRecord(loggedRequest) && loggedRequest.url === '/health/live';
    });
    if (!accessRecord) {
      throw new Error('Expected a structured liveness access log.');
    }
    expect(accessRecord).toMatchObject({
      req: { method: 'GET', url: '/health/live' },
      res: { statusCode: 200 },
    });
    expect(typeof accessRecord.requestId).toBe('string');
    expect(typeof accessRecord.responseTime).toBe('number');
  });

  it('returns active and archived same-store detail with minimized lossless fields', async () => {
    const active = await authorizedGet(
      access.a,
      `/v1/customers/${fixture.customers.aPhone}`,
    ).expect(200);
    const archived = await authorizedGet(
      access.a,
      `/v1/customers/${fixture.customers.aArchived}`,
    ).expect(200);

    expect(active.body).toMatchObject({
      id: fixture.customers.aPhone,
      status: 'active',
      notes: 'Exact phone Customer',
      version: '9007199254740993',
    });
    expect(archived.body).toMatchObject({
      id: fixture.customers.aArchived,
      status: 'archived',
      notes: 'Historical Customer',
    });
    for (const body of [active.body, archived.body]) {
      expect(body).not.toHaveProperty('storeId');
      expect(body).not.toHaveProperty('normalizedName');
      expect(body).not.toHaveProperty('normalizedPhone');
      expect(body).not.toHaveProperty('deviceId');
      expect(body).not.toHaveProperty('operationId');
      expect(body).not.toHaveProperty('creditLimitMinor');
    }
  });

  it('makes nonexistent and cross-store Customer detail externally indistinguishable', async () => {
    const nonexistent = await authorizedGet(access.a, `/v1/customers/${randomUUID()}`).expect(404);
    const crossStore = await authorizedGet(
      access.a,
      `/v1/customers/${fixture.customers.bPhone}`,
    ).expect(404);

    expect(withoutTraceFields(crossStore.body)).toEqual(withoutTraceFields(nonexistent.body));
    expect(Object.keys(crossStore.body as Record<string, unknown>).sort()).toEqual(
      Object.keys(nonexistent.body as Record<string, unknown>).sort(),
    );
  });

  it('ignores forged tenant headers, rejects tenant query input, and permits read-only reads', async () => {
    const forged = readList(
      await authorizedGet(access.a, '/v1/customers')
        .set('x-store-id', fixture.stores.b)
        .query({ search: '0599 123 456' })
        .expect(200),
    );
    expect(forged.items.map((item) => item.id)).not.toContain(fixture.customers.bPhone);

    await authorizedGet(access.a, '/v1/customers').query({ storeId: fixture.stores.b }).expect(400);

    const readOnly = readList(await authorizedGet(access.readOnly, '/v1/customers').expect(200));
    expect(readOnly.items.map((item) => item.id)).toEqual([fixture.customers.readOnly]);
  });

  it('executes reads as the least-privileged runtime role with RLS and fails closed without context', async () => {
    if (!app || !environment) {
      throw new Error('The Customer integration application is unavailable.');
    }

    const runtimeState = await runtimeInspectionPool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      rowSecurityEnabled: boolean;
      runtimeMember: boolean;
      ownsCustomers: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "runtimeMember",
        pg_get_userbyid(customer_table.relowner) = current_user as "ownsCustomers"
      from pg_roles as role_state
      cross join pg_class as customer_table
      where role_state.rolname = current_user
        and customer_table.oid = 'ledger.customers'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      rowSecurityEnabled: true,
      runtimeMember: true,
      ownsCustomers: false,
    });

    const noContextRows = await runtimeInspectionPool.query(
      `select id from ledger.customers where id = any($1::uuid[])`,
      [customerIds],
    );
    expect(noContextRows.rows).toEqual([]);

    const database = app.get(DatabaseService);
    const context: TenantTransactionContext = {
      storeId: access.a.storeId,
      userId: access.a.userId,
      deviceId: access.a.deviceId,
      requestId: randomUUID(),
    };
    const rlsVisible = await database.withTenantTransaction(context, (transaction) =>
      transaction
        .select({ id: customers.id, storeId: customers.storeId })
        .from(customers)
        .where(eq(customers.normalizedPhone, '+970599123456')),
    );
    expect(rlsVisible).toEqual([{ id: fixture.customers.aPhone, storeId: fixture.stores.a }]);

    const repository = app.get(CustomerReadRepository);
    await expect(
      repository.list(undefined as unknown as TenantTransactionContext, {
        status: 'active',
        search: null,
        position: null,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
