import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { inArray, sql } from 'drizzle-orm';
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
import { suppliers } from '../src/database/schema';
import type { TenantTransactionContext } from '../src/database/database.types';
import {
  encodeSupplierCursor,
  supplierCursorScopeHash,
} from '../src/suppliers/supplier-read-cursor';
import { prepareSupplierSearchScope } from '../src/suppliers/supplier-read-query';
import { SupplierReadRepository } from '../src/suppliers/supplier-read.repository';
import type {
  SupplierDetailResponse,
  SupplierListResponse,
  SupplierStatus,
} from '../src/suppliers/supplier-read.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: '65000000-0000-4000-8000-000000000001',
    b: '65000000-0000-4000-8000-000000000002',
    readOnly: '65000000-0000-4000-8000-000000000003',
    manager: '65000000-0000-4000-8000-000000000004',
    viewer: '65000000-0000-4000-8000-000000000005',
    support: '65000000-0000-4000-8000-000000000006',
  },
  users: {
    ownerA: '65100000-0000-4000-8000-000000000001',
    ownerB: '65100000-0000-4000-8000-000000000002',
    readOnly: '65100000-0000-4000-8000-000000000003',
    manager: '65100000-0000-4000-8000-000000000004',
    viewer: '65100000-0000-4000-8000-000000000005',
    support: '65100000-0000-4000-8000-000000000006',
  },
  memberships: {
    ownerA: '65200000-0000-4000-8000-000000000001',
    ownerB: '65200000-0000-4000-8000-000000000002',
    readOnly: '65200000-0000-4000-8000-000000000003',
    manager: '65200000-0000-4000-8000-000000000004',
    viewer: '65200000-0000-4000-8000-000000000005',
    support: '65200000-0000-4000-8000-000000000006',
  },
  devices: {
    ownerA: '65300000-0000-4000-8000-000000000001',
    ownerB: '65300000-0000-4000-8000-000000000002',
    readOnly: '65300000-0000-4000-8000-000000000003',
    manager: '65300000-0000-4000-8000-000000000004',
    viewer: '65300000-0000-4000-8000-000000000005',
    support: '65300000-0000-4000-8000-000000000006',
  },
  emails: {
    ownerA: 'task63-owner-a@example.test',
    ownerB: 'task63-owner-b@example.test',
    readOnly: 'task63-read-only@example.test',
    manager: 'task63-manager@example.test',
    viewer: 'task63-viewer@example.test',
    support: 'task63-support@example.test',
  },
  password: 'Task-6.3-Test-Password!',
  suppliers: {
    same1: '65400000-0000-4000-8000-000000000001',
    same2: '65400000-0000-4000-8000-000000000002',
    arabic: '65400000-0000-4000-8000-000000000003',
    percent: '65400000-0000-4000-8000-000000000004',
    underscore: '65400000-0000-4000-8000-000000000005',
    backslash: '65400000-0000-4000-8000-000000000006',
    phone970: '65400000-0000-4000-8000-000000000007',
    phone972: '65400000-0000-4000-8000-000000000008',
    legacyNull: '65400000-0000-4000-8000-000000000009',
    note: '65400000-0000-4000-8000-000000000010',
    archived: '65400000-0000-4000-8000-000000000011',
    foreign: '65400000-0000-4000-8000-000000000101',
    readOnly: '65400000-0000-4000-8000-000000000201',
  },
};

type AccessKey = keyof typeof fixture.emails;

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface SupplierFixtureRecord {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  phone?: string | null;
  normalizedPhone?: string | null;
  notes?: string | null;
  status?: SupplierStatus;
  version?: string;
}

interface ReadSideEffects {
  processedOperations: number;
  changeEvents: number;
  auditLogs: number;
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
}

function readList(response: Response): SupplierListResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Expected a Supplier list response.');
  }
  return body as unknown as SupplierListResponse;
}

function readDetail(response: Response): SupplierDetailResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.id !== 'string') {
    throw new Error('Expected a Supplier detail response.');
  }
  return body as unknown as SupplierDetailResponse;
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

describe('Supplier read API with real PostgreSQL', () => {
  const logCapture = new SynchronousLogCapture();
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<AccessKey, AccessIdentity>;
  let sideEffectsAfterLogin: ReadSideEffects;

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const supplierIds = Object.values(fixture.suppliers);

  const supplierRecords: SupplierFixtureRecord[] = [
    {
      id: fixture.suppliers.same1,
      storeId: fixture.stores.a,
      name: 'Same Supplier One',
      normalizedName: 'same supplier',
      phone: '+970 598 000 001',
      normalizedPhone: '+970598000001',
    },
    {
      id: fixture.suppliers.same2,
      storeId: fixture.stores.a,
      name: 'Same Supplier Two',
      normalizedName: 'same supplier',
      phone: '+970 598 000 002',
      normalizedPhone: '+970598000002',
    },
    {
      id: fixture.suppliers.arabic,
      storeId: fixture.stores.a,
      name: '\u0623\u064e\u0631\u0632 \u0645\u0640\u0640\u0645\u062a\u0627\u0632',
      normalizedName: '\u0627\u0631\u0632 \u0645\u0645\u062a\u0627\u0632',
      phone: '+970 598 000 003',
      normalizedPhone: '+970598000003',
    },
    {
      id: fixture.suppliers.percent,
      storeId: fixture.stores.a,
      name: 'Supply% Special',
      normalizedName: 'supply% special',
      phone: '+970 598 000 004',
      normalizedPhone: '+970598000004',
    },
    {
      id: fixture.suppliers.underscore,
      storeId: fixture.stores.a,
      name: 'Supply_ Special',
      normalizedName: 'supply_ special',
      phone: '+970 598 000 005',
      normalizedPhone: '+970598000005',
    },
    {
      id: fixture.suppliers.backslash,
      storeId: fixture.stores.a,
      name: 'Supply\\ Special',
      normalizedName: 'supply\\ special',
      phone: '+970 598 000 006',
      normalizedPhone: '+970598000006',
    },
    {
      id: fixture.suppliers.phone970,
      storeId: fixture.stores.a,
      name: 'Levant Supply',
      normalizedName: 'levant supply',
      phone: '+970 599 123 456',
      normalizedPhone: '+970599123456',
    },
    {
      id: fixture.suppliers.phone972,
      storeId: fixture.stores.a,
      name: 'Other Network Supply',
      normalizedName: 'other network supply',
      phone: '+972 50 234 5678',
      normalizedPhone: '+972502345678',
    },
    {
      id: fixture.suppliers.legacyNull,
      storeId: fixture.stores.a,
      name: 'Legacy Supplier',
      normalizedName: 'legacy supplier',
      phone: null,
      normalizedPhone: null,
      version: '9007199254740993',
    },
    {
      id: fixture.suppliers.note,
      storeId: fixture.stores.a,
      name: 'Notes Holder',
      normalizedName: 'notes holder',
      phone: '+970 598 000 010',
      normalizedPhone: '+970598000010',
      notes: 'PRIVATE-SUPPLIER-NOTE-63',
    },
    {
      id: fixture.suppliers.archived,
      storeId: fixture.stores.a,
      name: 'Archived Supplier',
      normalizedName: 'archived supplier',
      phone: '+970 598 000 011',
      normalizedPhone: '+970598000011',
      notes: 'Historical note',
      status: 'archived',
    },
    {
      id: fixture.suppliers.foreign,
      storeId: fixture.stores.b,
      name: 'Same Supplier Foreign',
      normalizedName: 'same supplier',
      phone: '+970 599 123 456',
      normalizedPhone: '+970599123456',
      notes: 'Foreign private note',
    },
    {
      id: fixture.suppliers.readOnly,
      storeId: fixture.stores.readOnly,
      name: 'Read Only Supplier',
      normalizedName: 'read only supplier',
      phone: null,
      normalizedPhone: null,
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
    await adminPool.query(`delete from ledger.suppliers where id = any($1::uuid[])`, [supplierIds]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from platform.store_memberships where id = any($1::uuid[])`, [
      membershipIds,
    ]);
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function insertSupplier(record: SupplierFixtureRecord, index: number): Promise<void> {
    await adminPool.query(
      `
        insert into ledger.suppliers (
          id, store_id, name, normalized_name, phone, normalized_phone, notes,
          status, archived_at, operation_id, version
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          case when $8 = 'archived' then '2026-08-01T00:00:00Z'::timestamptz else null end,
          $9, $10::bigint
        )
      `,
      [
        record.id,
        record.storeId,
        record.name,
        record.normalizedName,
        record.phone ?? null,
        record.normalizedPhone ?? null,
        record.notes ?? null,
        record.status ?? 'active',
        `65500000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        record.version ?? '1',
      ],
    );
  }

  async function login(key: AccessKey, storeId: string): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId,
        deviceId: fixture.devices[key],
        deviceName: `Task 6.3 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    return {
      accessToken: readAccessToken(response),
      storeId,
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
            where store_id = any($1::uuid[])) as "auditLogs"
      `,
      [storeIds],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Expected Supplier read side-effect counts.');
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
      'dokana-task63-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-task63-runtime-inspection',
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
      throw new Error('The local Supplier fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 6.3 Store A', 'active'),
          ($2, 'Task 6.3 Store B', 'active'),
          ($3, 'Task 6.3 Read Only', 'read_only'),
          ($4, 'Task 6.3 Manager', 'active'),
          ($5, 'Task 6.3 Viewer', 'active'),
          ($6, 'Task 6.3 Support', 'active')
      `,
      storeIds,
    );
    await adminPool.query(
      `
        insert into platform.users (
          id, email, normalized_email, password_hash, full_name, status
        )
        values
          ($1, $2, $2, $13, 'Task 6.3 Owner A', 'active'),
          ($3, $4, $4, $13, 'Task 6.3 Owner B', 'active'),
          ($5, $6, $6, $13, 'Task 6.3 Read Only Owner', 'active'),
          ($7, $8, $8, $13, 'Task 6.3 Manager', 'active'),
          ($9, $10, $10, $13, 'Task 6.3 Viewer', 'active'),
          ($11, $12, $12, $13, 'Task 6.3 Support', 'active')
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
        fixture.stores.a,
        fixture.users.ownerA,
        fixture.memberships.ownerB,
        fixture.stores.b,
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
    for (const [index, supplier] of supplierRecords.entries()) {
      await insertSupplier(supplier, index + 1);
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
      ownerA: await login('ownerA', fixture.stores.a),
      ownerB: await login('ownerB', fixture.stores.b),
      readOnly: await login('readOnly', fixture.stores.readOnly),
      manager: await login('manager', fixture.stores.manager),
      viewer: await login('viewer', fixture.stores.viewer),
      support: await login('support', fixture.stores.support),
    };
    sideEffectsAfterLogin = await readSideEffects();
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
          + (select count(*) from ledger.suppliers where id = any($4::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds, supplierIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  }, 30_000);

  it('requires authentication and owner authority while allowing read-only owner reads', async () => {
    await request(server).get('/v1/suppliers').expect(401);
    for (const role of ['manager', 'viewer', 'support'] as const) {
      await authorizedGet(access[role], '/v1/suppliers')
        .expect(403)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'SUPPLIER_READ_NOT_ALLOWED' });
        });
      await authorizedGet(access[role], `/v1/suppliers/${fixture.suppliers.same1}`).expect(403);
    }

    const readOnly = readList(await authorizedGet(access.readOnly, '/v1/suppliers').expect(200));
    expect(readOnly.items.map((item) => item.id)).toEqual([fixture.suppliers.readOnly]);
  });

  it('validates scalar query grammar, duplicate parameters, and Supplier UUIDs strictly', async () => {
    for (const query of [
      { status: 'all' },
      { limit: '0' },
      { limit: '101' },
      { limit: '01' },
      { limit: '+10' },
      { limit: '10.0' },
      { limit: '1e2' },
      { limit: ' 10 ' },
      { unexpected: 'value' },
      { storeId: fixture.stores.b },
    ]) {
      await authorizedGet(access.ownerA, '/v1/suppliers').query(query).expect(400);
    }
    for (const path of [
      '/v1/suppliers?search=a&search=a',
      '/v1/suppliers?status=active&status=active',
      '/v1/suppliers?limit=10&limit=10',
      '/v1/suppliers?cursor=x&cursor=x',
    ]) {
      await authorizedGet(access.ownerA, path).expect(400);
    }
    for (const search of ['', ' \u00a0 ', '\u0640\u064b']) {
      await authorizedGet(access.ownerA, '/v1/suppliers').query({ search }).expect(400);
    }
    await authorizedGet(access.ownerA, '/v1/suppliers').query({ limit: '1' }).expect(200);
    await authorizedGet(access.ownerA, '/v1/suppliers').query({ limit: '100' }).expect(200);
    await authorizedGet(access.ownerA, '/v1/suppliers/not-a-uuid').expect(400);
  });

  it('returns exact tenant-scoped active, archived, list, and detail projections', async () => {
    const active = readList(await authorizedGet(access.ownerA, '/v1/suppliers').expect(200));
    expect(active.items.map((item) => item.id)).not.toContain(fixture.suppliers.archived);
    expect(active.items.map((item) => item.id)).not.toContain(fixture.suppliers.foreign);
    expect(
      active.items.filter((item) => item.name.startsWith('Same Supplier')).map((item) => item.id),
    ).toEqual([fixture.suppliers.same1, fixture.suppliers.same2]);
    for (const item of active.items) {
      expect(Object.keys(item).sort()).toEqual([
        'archivedAt',
        'id',
        'name',
        'phone',
        'status',
        'updatedAt',
        'version',
      ]);
    }
    expect(active.items.find((item) => item.id === fixture.suppliers.legacyNull)).toMatchObject({
      phone: null,
      version: '9007199254740993',
    });

    const archived = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers').query({ status: 'archived' }).expect(200),
    );
    expect(archived.items.map((item) => item.id)).toEqual([fixture.suppliers.archived]);

    const detail = readDetail(
      await authorizedGet(access.ownerA, `/v1/suppliers/${fixture.suppliers.archived}`).expect(200),
    );
    expect(Object.keys(detail).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'id',
      'name',
      'notes',
      'phone',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(detail).toMatchObject({
      id: fixture.suppliers.archived,
      notes: 'Historical note',
      status: 'archived',
    });
    expect(detail.archivedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(detail.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(detail.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const legacyDetail = readDetail(
      await authorizedGet(
        access.ownerA,
        `/v1/suppliers/${fixture.suppliers.legacyNull.toUpperCase()}`,
      ).expect(200),
    );
    expect(legacyDetail).toMatchObject({
      id: fixture.suppliers.legacyNull,
      phone: null,
      version: '9007199254740993',
    });
  });

  it('implements normalized literal name prefix and exact canonical phone search only', async () => {
    for (const search of ['  \u0623\u064e\u0631\u0632  ', '\u0627\u0631\u0632']) {
      const result = readList(
        await authorizedGet(access.ownerA, '/v1/suppliers').query({ search }).expect(200),
      );
      expect(result.items.map((item) => item.id)).toEqual([fixture.suppliers.arabic]);
    }

    const phone970 = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: '+970 599 123 456' })
        .expect(200),
    );
    const phone972 = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: '+972 50 234 5678' })
        .expect(200),
    );
    const partialPhone = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers').query({ search: '0599' }).expect(200),
    );
    const nationalPhone = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: '0599 123 456' })
        .expect(200),
    );
    const arabicDigitPhone = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: '\u0660\u0665\u0669\u0669 \u0661\u0662\u0663 \u0664\u0665\u0666' })
        .expect(200),
    );
    expect(phone970.items.map((item) => item.id)).toEqual([fixture.suppliers.phone970]);
    expect(phone972.items.map((item) => item.id)).toEqual([fixture.suppliers.phone972]);
    expect(nationalPhone.items.map((item) => item.id)).toEqual([fixture.suppliers.phone970]);
    expect(arabicDigitPhone.items.map((item) => item.id)).toEqual([fixture.suppliers.phone970]);
    expect(partialPhone.items).toEqual([]);

    const namePrefix = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers').query({ search: ' SAME ' }).expect(200),
    );
    const nameSubstring = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: 'Supplier One' })
        .expect(200),
    );
    expect(namePrefix.items.map((item) => item.id)).toEqual([
      fixture.suppliers.same1,
      fixture.suppliers.same2,
    ]);
    expect(nameSubstring.items).toEqual([]);

    for (const [search, expected] of [
      ['Supply%', fixture.suppliers.percent],
      ['Supply_', fixture.suppliers.underscore],
      ['Supply\\', fixture.suppliers.backslash],
    ] as const) {
      const result = readList(
        await authorizedGet(access.ownerA, '/v1/suppliers').query({ search }).expect(200),
      );
      expect(result.items.map((item) => item.id)).toEqual([expected]);
    }

    const notesSearch = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: 'PRIVATE-SUPPLIER-NOTE-63' })
        .expect(200),
    );
    expect(notesSearch.items).toEqual([]);
    const archivedSearch = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ status: 'archived', search: 'Archived' })
        .expect(200),
    );
    expect(archivedSearch.items.map((item) => item.id)).toEqual([fixture.suppliers.archived]);
    const archivedPhoneDefault = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ search: '+970 598 000 011' })
        .expect(200),
    );
    const archivedPhoneExplicit = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .query({ status: 'archived', search: '+970 598 000 011' })
        .expect(200),
    );
    expect(archivedPhoneDefault.items).toEqual([]);
    expect(archivedPhoneExplicit.items.map((item) => item.id)).toEqual([
      fixture.suppliers.archived,
    ]);
  });

  it('paginates the exact total order and rejects scope or anchor changes', async () => {
    const complete = readList(await authorizedGet(access.ownerA, '/v1/suppliers').expect(200));
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = readList(
        await authorizedGet(access.ownerA, '/v1/suppliers')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200),
      );
      pagedIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pagedIds).toEqual(complete.items.map((item) => item.id));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);

    const first = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers').query({ limit: 1 }).expect(200),
    );
    if (!first.nextCursor) {
      throw new Error('Expected a Supplier continuation cursor.');
    }
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ status: 'archived', limit: 1, cursor: first.nextCursor })
      .expect(400);
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ search: 'Same', limit: 1, cursor: first.nextCursor })
      .expect(400);
    const phoneSearch = prepareSupplierSearchScope('+970 599 123 456');
    if (!phoneSearch) {
      throw new Error('Expected a Supplier phone search scope.');
    }
    const phoneCursor = encodeSupplierCursor({
      scopeHash: supplierCursorScopeHash('active', phoneSearch),
      anchor: { id: fixture.suppliers.phone970, version: 1n },
    });
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ search: '+972 50 234 5678', cursor: phoneCursor })
      .expect(400);
    for (const path of [
      '/v1/suppliers?cursor',
      '/v1/suppliers?cursor=',
      '/v1/suppliers?cursor=%20',
      '/v1/suppliers?cursor=not-valid',
    ]) {
      await authorizedGet(access.ownerA, path).expect(400);
    }

    const scopeHash = supplierCursorScopeHash('active', null);
    const missingCursor = encodeSupplierCursor({
      scopeHash,
      anchor: { id: randomUUID(), version: 1n },
    });
    const foreignCursor = encodeSupplierCursor({
      scopeHash,
      anchor: { id: fixture.suppliers.foreign, version: 1n },
    });
    const missing = await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ cursor: missingCursor })
      .expect(400);
    const foreign = await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ cursor: foreignCursor })
      .expect(400);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(missing.body));

    const changedCursor = encodeSupplierCursor({
      scopeHash,
      anchor: { id: fixture.suppliers.same1, version: 1n },
    });
    await adminPool.query(`update ledger.suppliers set version = 2 where id = $1`, [
      fixture.suppliers.same1,
    ]);
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ cursor: changedCursor })
      .expect(400);
    await adminPool.query(`update ledger.suppliers set version = 1 where id = $1`, [
      fixture.suppliers.same1,
    ]);

    const sameSearch = prepareSupplierSearchScope('Same');
    if (!sameSearch) {
      throw new Error('Expected a Same Supplier search scope.');
    }
    const outOfScopeCursor = encodeSupplierCursor({
      scopeHash: supplierCursorScopeHash('active', sameSearch),
      anchor: { id: fixture.suppliers.same1, version: 1n },
    });
    await adminPool.query(
      `update ledger.suppliers set name = 'Moved', normalized_name = 'moved' where id = $1`,
      [fixture.suppliers.same1],
    );
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ search: 'Same', cursor: outOfScopeCursor })
      .expect(400);
    await adminPool.query(
      `update ledger.suppliers
       set name = 'Same Supplier One', normalized_name = 'same supplier' where id = $1`,
      [fixture.suppliers.same1],
    );
  });

  it('makes foreign detail indistinguishable from absence and ignores forged tenant input', async () => {
    const nonexistent = await authorizedGet(access.ownerA, `/v1/suppliers/${randomUUID()}`).expect(
      404,
    );
    const foreign = await authorizedGet(
      access.ownerA,
      `/v1/suppliers/${fixture.suppliers.foreign}`,
    ).expect(404);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(nonexistent.body));

    const forged = readList(
      await authorizedGet(access.ownerA, '/v1/suppliers')
        .set('x-store-id', fixture.stores.b)
        .query({ search: '+970 599 123 456' })
        .expect(200),
    );
    expect(forged.items.map((item) => item.id)).toEqual([fixture.suppliers.phone970]);
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ storeId: fixture.stores.b })
      .expect(400);
  });

  it('uses forced least-privileged RLS and contains tenant context across pool paths', async () => {
    if (!app || !environment) {
      throw new Error('The Supplier integration application is unavailable.');
    }
    const runtimeState = await runtimeInspectionPool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      rowSecurityEnabled: boolean;
      runtimeMember: boolean;
      ownsSuppliers: boolean;
      rlsEnabled: boolean;
      rlsForced: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "runtimeMember",
        pg_get_userbyid(supplier_table.relowner) = current_user as "ownsSuppliers",
        supplier_table.relrowsecurity as "rlsEnabled",
        supplier_table.relforcerowsecurity as "rlsForced"
      from pg_roles as role_state
      cross join pg_class as supplier_table
      where role_state.rolname = current_user
        and supplier_table.oid = 'ledger.suppliers'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment.runtimeUrl).username),
      isSuperuser: false,
      bypassesRls: false,
      rowSecurityEnabled: true,
      runtimeMember: true,
      ownsSuppliers: false,
      rlsEnabled: true,
      rlsForced: true,
    });
    const noContext = await runtimeInspectionPool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.suppliers where id = any($1::uuid[])`,
      [supplierIds],
    );
    expect(noContext.rows[0]?.count).toBe(0);

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
          .select({ id: suppliers.id })
          .from(suppliers)
          .where(inArray(suppliers.id, [fixture.suppliers.phone970, fixture.suppliers.foreign])),
      );
    const [visibleA, visibleB] = await Promise.all([visible(contextA), visible(contextB)]);
    expect(visibleA).toEqual([{ id: fixture.suppliers.phone970 }]);
    expect(visibleB).toEqual([{ id: fixture.suppliers.foreign }]);

    const withoutContext = () =>
      database.transaction((transaction) =>
        transaction
          .select({ id: suppliers.id })
          .from(suppliers)
          .where(inArray(suppliers.id, [fixture.suppliers.phone970, fixture.suppliers.foreign])),
      );
    expect(await withoutContext()).toEqual([]);
    await expect(
      database.withTenantTransaction(contextA, async (transaction) => {
        await transaction.select({ id: suppliers.id }).from(suppliers).limit(1);
        throw new Error('Supplier rollback sentinel.');
      }),
    ).rejects.toThrow('Supplier rollback sentinel.');
    expect(await withoutContext()).toEqual([]);

    await expect(
      database.withTenantTransaction(contextA, async (transaction) => {
        await transaction.execute(sql`select set_config('statement_timeout', '5', true)`);
        await transaction.execute(sql`select pg_sleep(0.05)`);
      }),
    ).rejects.toBeDefined();
    expect(await withoutContext()).toEqual([]);

    const repository = app.get(SupplierReadRepository);
    await expect(
      repository.list(undefined as unknown as TenantTransactionContext, {
        status: 'active',
        search: null,
        anchor: null,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('keeps query, cursor, and notes private and creates no read side effects', async () => {
    const privateSearch = 'PRIVATE-SUPPLIER-SEARCH-63';
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ search: privateSearch })
      .expect(200);
    const privateCursor = encodeSupplierCursor({
      scopeHash: supplierCursorScopeHash('active', null),
      anchor: { id: randomUUID(), version: 1n },
    });
    await authorizedGet(access.ownerA, '/v1/suppliers')
      .query({ cursor: privateCursor })
      .expect(400);
    const detail = readDetail(
      await authorizedGet(access.ownerA, `/v1/suppliers/${fixture.suppliers.note}`).expect(200),
    );
    expect(detail.notes).toBe('PRIVATE-SUPPLIER-NOTE-63');

    const logs = logCapture.flush();
    expect(logs).not.toContain(privateSearch);
    expect(logs).not.toContain(privateCursor);
    expect(logs).not.toContain('PRIVATE-SUPPLIER-NOTE-63');
    expect(logs).not.toContain('?search=');
    expect(logs).not.toContain('?cursor=');
    expect(await readSideEffects()).toEqual(sideEffectsAfterLogin);
  });
});
