import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import type { CustomerMutationResponse } from '../src/customers/customer-write.types';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();
const fixture = {
  stores: {
    a: '45000000-0000-4000-8000-000000000001',
    b: '45000000-0000-4000-8000-000000000002',
    readOnly: '45000000-0000-4000-8000-000000000003',
  },
  users: {
    a: '45100000-0000-4000-8000-000000000001',
    b: '45100000-0000-4000-8000-000000000002',
    readOnly: '45100000-0000-4000-8000-000000000003',
  },
  memberships: {
    a: '45200000-0000-4000-8000-000000000001',
    b: '45200000-0000-4000-8000-000000000002',
    readOnly: '45200000-0000-4000-8000-000000000003',
  },
  devices: {
    a: '45300000-0000-4000-8000-000000000001',
    b: '45300000-0000-4000-8000-000000000002',
    readOnly: '45300000-0000-4000-8000-000000000003',
  },
  customers: {
    aTarget: '45400000-0000-4000-8000-000000000001',
    aDuplicate: '45400000-0000-4000-8000-000000000002',
    aArchived: '45400000-0000-4000-8000-000000000003',
    aRaceOne: '45400000-0000-4000-8000-000000000004',
    aRaceTwo: '45400000-0000-4000-8000-000000000005',
    aConcurrent: '45400000-0000-4000-8000-000000000006',
    bTarget: '45400000-0000-4000-8000-000000000101',
    readOnlyTarget: '45400000-0000-4000-8000-000000000201',
  },
  emails: {
    a: 'task433-a@example.test',
    b: 'task433-b@example.test',
    readOnly: 'task433-read-only@example.test',
  },
  password: 'Task-4.3.3-Test-Password!',
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
  notes?: string;
  creditLimitMinor?: string;
  creditPolicy?: 'allow' | 'warn' | 'block';
  status?: 'active' | 'archived';
}

interface CustomerDatabaseRow extends Record<string, unknown> {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  phone: string;
  normalizedPhone: string;
  notes: string | null;
  creditLimitMinor: string | null;
  creditPolicy: 'allow' | 'warn' | 'block' | null;
  status: 'active' | 'archived';
  archivedAt: Date | null;
  deviceId: string | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: string;
}

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

function readMutation(response: Response): CustomerMutationResponse {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.version !== 'string') {
    throw new Error('Expected a Customer mutation response.');
  }
  return body as unknown as CustomerMutationResponse;
}

function readErrorCode(response: Response): string {
  const body: unknown = response.body;
  if (!isRecord(body) || typeof body.code !== 'string') {
    throw new Error('Expected an API error code.');
  }
  return body.code;
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

function readCustomerIds(response: Response): string[] {
  const body: unknown = response.body;
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('Expected a Customer list response.');
  }
  return body.items.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new Error('Expected a Customer list item.');
    }
    return item.id;
  });
}

function changedCustomerFields(before: CustomerDatabaseRow, after: CustomerDatabaseRow): string[] {
  return Object.keys(before)
    .filter((key) => {
      const beforeValue = before[key];
      const afterValue = after[key];
      const serializedBefore =
        beforeValue instanceof Date ? beforeValue.toISOString() : beforeValue;
      const serializedAfter = afterValue instanceof Date ? afterValue.toISOString() : afterValue;
      return serializedBefore !== serializedAfter;
    })
    .sort();
}

describe('Customer mutation API with real PostgreSQL', () => {
  let app: INestApplication | undefined;
  let server: Server;
  let adminPool: Pool;
  let runtimeInspectionPool: Pool;
  let poolsInitialized = false;
  let access: Record<'a' | 'b' | 'readOnly', AccessIdentity>;

  const storeIds = Object.values(fixture.stores);
  const userIds = Object.values(fixture.users);
  const membershipIds = Object.values(fixture.memberships);
  const baseCustomers: CustomerFixtureRecord[] = [
    {
      id: fixture.customers.aTarget,
      storeId: fixture.stores.a,
      name: 'Store A Target',
      normalizedName: 'store a target',
      phone: '0599 300 001',
      normalizedPhone: '+970599300001',
      notes: 'Original notes',
      creditLimitMinor: '50000',
      creditPolicy: 'warn',
    },
    {
      id: fixture.customers.aDuplicate,
      storeId: fixture.stores.a,
      name: 'Store A Duplicate',
      normalizedName: 'store a duplicate',
      phone: '0599 300 002',
      normalizedPhone: '+970599300002',
    },
    {
      id: fixture.customers.aArchived,
      storeId: fixture.stores.a,
      name: 'Store A Archived',
      normalizedName: 'store a archived',
      phone: '0599 300 003',
      normalizedPhone: '+970599300003',
      status: 'archived',
    },
    {
      id: fixture.customers.aRaceOne,
      storeId: fixture.stores.a,
      name: 'Store A Race One',
      normalizedName: 'store a race one',
      phone: '0599 300 004',
      normalizedPhone: '+970599300004',
    },
    {
      id: fixture.customers.aRaceTwo,
      storeId: fixture.stores.a,
      name: 'Store A Race Two',
      normalizedName: 'store a race two',
      phone: '0599 300 005',
      normalizedPhone: '+970599300005',
    },
    {
      id: fixture.customers.aConcurrent,
      storeId: fixture.stores.a,
      name: 'Store A Concurrent',
      normalizedName: 'store a concurrent',
      phone: '0599 300 006',
      normalizedPhone: '+970599300006',
    },
    {
      id: fixture.customers.bTarget,
      storeId: fixture.stores.b,
      name: 'Store B Target',
      normalizedName: 'store b target',
      phone: '0599 900 001',
      normalizedPhone: '+970599900001',
    },
    {
      id: fixture.customers.readOnlyTarget,
      storeId: fixture.stores.readOnly,
      name: 'Read Only Target',
      normalizedName: 'read only target',
      phone: '0599 800 001',
      normalizedPhone: '+970599800001',
    },
  ];

  async function clearStoreBusinessData(): Promise<void> {
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
    await adminPool.query(`delete from ledger.customers where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
  }

  async function removeFixtures(): Promise<void> {
    await clearStoreBusinessData();
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIds,
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

  async function insertBaseCustomers(): Promise<void> {
    for (const [index, customer] of baseCustomers.entries()) {
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
            credit_limit_minor,
            credit_policy,
            status,
            archived_at,
            operation_id,
            version
          ) values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            case when $10 = 'archived' then '2026-08-01T00:00:00Z'::timestamptz else null end,
            $11,
            1
          )
        `,
        [
          customer.id,
          customer.storeId,
          customer.name,
          customer.normalizedName,
          customer.phone,
          customer.normalizedPhone,
          customer.notes ?? null,
          customer.creditLimitMinor ?? null,
          customer.creditPolicy ?? null,
          customer.status ?? 'active',
          `45500000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
        ],
      );
    }
  }

  async function resetBusinessFixtures(): Promise<void> {
    await clearStoreBusinessData();
    await adminPool.query(
      `
        update ledger.stores
        set status = case when id = $1 then 'read_only' else 'active' end
        where id = any($2::uuid[])
      `,
      [fixture.stores.readOnly, storeIds],
    );
    await insertBaseCustomers();
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
        deviceName: `Task 4.3.3 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    return { accessToken: readAccessToken(response), storeId, userId, deviceId };
  }

  function authorizedPost(identity: AccessIdentity) {
    return request(server)
      .post('/v1/customers')
      .set('authorization', `Bearer ${identity.accessToken}`);
  }

  function authorizedPatch(identity: AccessIdentity, customerId: string) {
    return request(server)
      .patch(`/v1/customers/${customerId}`)
      .set('authorization', `Bearer ${identity.accessToken}`);
  }

  function authorizedLifecycle(
    identity: AccessIdentity,
    customerId: string,
    action: 'archive' | 'restore',
  ) {
    return request(server)
      .post(`/v1/customers/${customerId}/${action}`)
      .set('authorization', `Bearer ${identity.accessToken}`);
  }

  function authorizedGet(identity: AccessIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  async function readCustomer(customerId: string): Promise<CustomerDatabaseRow | undefined> {
    const result = await adminPool.query<CustomerDatabaseRow>(
      `
        select
          id,
          store_id as "storeId",
          name,
          normalized_name as "normalizedName",
          phone,
          normalized_phone as "normalizedPhone",
          notes,
          credit_limit_minor::text as "creditLimitMinor",
          credit_policy as "creditPolicy",
          status,
          archived_at as "archivedAt",
          device_id as "deviceId",
          operation_id as "operationId",
          created_at as "createdAt",
          updated_at as "updatedAt",
          version::text
        from ledger.customers
        where id = $1
      `,
      [customerId],
    );
    return result.rows[0];
  }

  async function readAccountingCounts(storeId: string): Promise<Record<string, number>> {
    const result = await adminPool.query<Record<string, number>>(
      `
        select
          (select count(*)::integer from ledger.sales where store_id = $1) as sales,
          (select count(*)::integer from ledger.customer_payments where store_id = $1)
            as "customerPayments",
          (select count(*)::integer from ledger.customer_payment_allocations where store_id = $1)
            as "paymentAllocations",
          (select count(*)::integer from ledger.customer_ledger_entries where store_id = $1)
            as "customerLedgerEntries",
          (select count(*)::integer from ledger.money_movements where store_id = $1)
            as "moneyMovements"
      `,
      [storeId],
    );
    const counts = result.rows[0];
    if (!counts) {
      throw new Error('Expected Customer accounting counts.');
    }
    return counts;
  }

  beforeAll(async () => {
    if (!environment) {
      throw new Error('The approved local PostgreSQL test environment is unavailable.');
    }

    process.env.APP_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = environment.runtimeUrl;
    process.env.AUTH_DATABASE_URL = environment.authUrl;

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task433-admin',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    runtimeInspectionPool = createTestPool(
      environment.runtimeUrl,
      'dokana-task433-runtime-inspection',
      2,
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
          ($1, 'Task 4.3.3 Store A', 'active'),
          ($2, 'Task 4.3.3 Store B', 'active'),
          ($3, 'Task 4.3.3 Read Only', 'read_only')
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
        ) values
          ($1, $2, $2, $7, 'Task 4.3.3 Owner A', 'active'),
          ($3, $4, $4, $7, 'Task 4.3.3 Owner B', 'active'),
          ($5, $6, $6, $7, 'Task 4.3.3 Read Only Owner', 'active')
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

    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    await resetBusinessFixtures();
  }, 60_000);

  beforeEach(async () => {
    await resetBusinessFixtures();
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
          + (select count(*) from ledger.customers where store_id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from sync.conflicts where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds, membershipIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await Promise.all([runtimeInspectionPool.end(), adminPool.end()]);
  }, 30_000);

  it('requires authentication and strictly rejects malformed or system-controlled fields', async () => {
    await request(server).post('/v1/customers').send({}).expect(401);

    const valid = {
      id: randomUUID(),
      operationId: randomUUID(),
      name: 'Validation Customer',
      phone: '0599 310 001',
    };
    for (const body of [
      { ...valid, id: 'not-a-uuid' },
      { ...valid, operationId: 'not-a-uuid' },
      { ...valid, name: 123 },
      { ...valid, phone: null },
      { ...valid, storeId: fixture.stores.b },
      { ...valid, deviceId: fixture.devices.b },
      { ...valid, status: 'archived' },
      { ...valid, normalizedName: 'forged' },
      { ...valid, normalizedPhone: '+111' },
      { ...valid, archivedAt: '2026-08-01T00:00:00Z' },
      { ...valid, version: '9' },
    ]) {
      await authorizedPost(access.a)
        .send(body)
        .expect(400)
        .expect(({ body: errorBody }) => {
          expect(errorBody).toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    }

    for (const body of [
      { operationId: randomUUID(), expectedVersion: '1' },
      { operationId: randomUUID(), expectedVersion: '0', notes: null },
      { operationId: randomUUID(), expectedVersion: '1.5', notes: null },
      { operationId: randomUUID(), expectedVersion: '9223372036854775808', notes: null },
      { operationId: randomUUID(), expectedVersion: '1', status: 'archived', notes: null },
      { operationId: randomUUID(), expectedVersion: '1', deviceId: fixture.devices.b, notes: null },
      { operationId: randomUUID(), expectedVersion: '1', name: null },
      { operationId: randomUUID(), expectedVersion: '1', phone: null },
    ]) {
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send(body)
        .expect(400)
        .expect(({ body: errorBody }) => {
          expect(errorBody).toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    }
  });

  it('creates an active Customer with client UUIDs, normalization, trusted ownership, and safe response', async () => {
    const id = randomUUID();
    const operationId = randomUUID();
    const responseMessage = await authorizedPost(access.a)
      .set('x-store-id', fixture.stores.b)
      .query({ storeId: fixture.stores.b })
      .send({
        id,
        operationId,
        name: '  أحمــد   مُحَمَّد  ',
        phone: ' ٠٥٩٩ ٣١٠ ٠٠٢ ',
        notes: '  exact notes  ',
      })
      .expect(201);
    const body = readMutation(responseMessage);

    expect(body).toMatchObject({
      id,
      operationId,
      name: 'أحمــد مُحَمَّد',
      phone: '٠٥٩٩ ٣١٠ ٠٠٢',
      notes: '  exact notes  ',
      status: 'active',
      archivedAt: null,
      version: '1',
    });
    expect(Object.keys(body).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'id',
      'name',
      'notes',
      'operationId',
      'phone',
      'status',
      'updatedAt',
      'version',
    ]);

    await expect(readCustomer(id)).resolves.toMatchObject({
      id,
      storeId: fixture.stores.a,
      normalizedName: 'احمد محمد',
      normalizedPhone: '+970599310002',
      status: 'active',
      archivedAt: null,
      deviceId: fixture.devices.a,
      operationId,
      version: '1',
    });
    const effects = await adminPool.query<{
      processed: number;
      changes: number;
      audits: number;
    }>(
      `
        select
          (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $2 and status = 'applied') as processed,
          (select count(*)::integer from sync.change_events
            where store_id = $1 and entity_id = $3 and action = 'create') as changes,
          (select count(*)::integer from audit.central_audit_logs
            where store_id = $1 and entity_id = $3 and action = 'insert') as audits
      `,
      [fixture.stores.a, operationId, id],
    );
    expect(effects.rows[0]).toEqual({ processed: 1, changes: 1, audits: 1 });
  });

  it('replays the same create once and rejects changed reuse with a non-sensitive conflict record', async () => {
    const id = randomUUID();
    const operationId = randomUUID();
    const payload = {
      id,
      operationId,
      name: 'Replay Customer',
      phone: '0599 310 003',
      notes: null,
    };
    const first = await authorizedPost(access.a).send(payload).expect(201);
    const replay = await authorizedPost(access.a).send(payload).expect(201);
    expect(replay.body).toEqual(first.body);

    await authorizedPost(access.a)
      .send({ ...payload, name: 'Changed Replay Customer' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
      });

    const effects = await adminPool.query<{
      customers: number;
      changes: number;
      conflicts: number;
    }>(
      `
        select
          (select count(*)::integer from ledger.customers where id = $1) as customers,
          (select count(*)::integer from sync.change_events where entity_id = $1) as changes,
          (select count(*)::integer from sync.conflicts
            where store_id = $2 and operation_id = $3 and conflict_type = 'duplicate_identity')
            as conflicts
      `,
      [id, fixture.stores.a, operationId],
    );
    expect(effects.rows[0]).toEqual({ customers: 1, changes: 1, conflicts: 1 });
  });

  it('converges concurrent identical create retries to one committed effect', async () => {
    const id = randomUUID();
    const operationId = randomUUID();
    const payload = {
      id,
      operationId,
      name: 'Concurrent Replay Customer',
      phone: '0599 310 010',
    };
    const [first, second] = await Promise.all([
      authorizedPost(access.a).send(payload),
      authorizedPost(access.a).send(payload),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body).toEqual(second.body);
    const effects = await adminPool.query<{
      customers: number;
      operations: number;
      changes: number;
    }>(
      `
        select
          (select count(*)::integer from ledger.customers where id = $1) as customers,
          (select count(*)::integer from sync.processed_operations
            where store_id = $2 and operation_id = $3 and status = 'applied') as operations,
          (select count(*)::integer from sync.change_events where entity_id = $1) as changes
      `,
      [id, fixture.stores.a, operationId],
    );
    expect(effects.rows[0]).toEqual({ customers: 1, operations: 1, changes: 1 });
  });

  it('rejects concurrent reuse of one operation ID with different canonical payloads', async () => {
    const id = randomUUID();
    const operationId = randomUUID();
    const [first, second] = await Promise.all([
      authorizedPost(access.a).send({
        id,
        operationId,
        name: 'Concurrent Payload One',
        phone: '0599 310 011',
      }),
      authorizedPost(access.a).send({
        id,
        operationId,
        name: 'Concurrent Payload Two',
        phone: '0599 310 011',
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    const effects = await adminPool.query<{ customers: number; conflicts: number }>(
      `
        select
          (select count(*)::integer from ledger.customers where id = $1) as customers,
          (select count(*)::integer from sync.conflicts
            where store_id = $2 and operation_id = $3 and conflict_type = 'duplicate_identity')
            as conflicts
      `,
      [id, fixture.stores.a, operationId],
    );
    expect(effects.rows[0]).toEqual({ customers: 1, conflicts: 1 });
  });

  it('enforces active and archived same-store phone reservation but allows cross-store equality', async () => {
    for (const [phone, expectedId] of [
      ['0599 300 002', fixture.customers.aDuplicate],
      ['0599 300 003', fixture.customers.aArchived],
    ] as const) {
      const operationId = randomUUID();
      await authorizedPost(access.a)
        .send({ id: randomUUID(), operationId, name: 'Duplicate Phone', phone })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'CUSTOMER_PHONE_CONFLICT' });
        });
      const original = await readCustomer(expectedId);
      expect(original?.normalizedPhone).toBe(`+970${phone.replaceAll(' ', '').slice(1)}`);
      const operation = await adminPool.query<{ status: string }>(
        `select status from sync.processed_operations where store_id = $1 and operation_id = $2`,
        [fixture.stores.a, operationId],
      );
      expect(operation.rows[0]?.status).toBe('rejected');
    }

    const crossStoreId = randomUUID();
    await authorizedPost(access.a)
      .send({
        id: crossStoreId,
        operationId: randomUUID(),
        name: 'Cross Store Phone',
        phone: '0599 900 001',
      })
      .expect(201);
    await expect(readCustomer(crossStoreId)).resolves.toMatchObject({
      storeId: fixture.stores.a,
      normalizedPhone: '+970599900001',
    });
  });

  it('keeps Customer identity collisions tenant-confidential and operation IDs store-scoped', async () => {
    const sameStore = await authorizedPost(access.a)
      .send({
        id: fixture.customers.aTarget,
        operationId: randomUUID(),
        name: 'Identity Collision',
        phone: '0599 310 004',
      })
      .expect(409);
    const foreignStore = await authorizedPost(access.a)
      .send({
        id: fixture.customers.bTarget,
        operationId: randomUUID(),
        name: 'Foreign Identity Collision',
        phone: '0599 310 005',
      })
      .expect(409);
    expect(withoutTraceFields(foreignStore.body)).toEqual(withoutTraceFields(sameStore.body));
    expect(foreignStore.body).toMatchObject({ code: 'CONFLICT' });

    const sharedOperationId = randomUUID();
    await authorizedPost(access.a)
      .send({
        id: randomUUID(),
        operationId: sharedOperationId,
        name: 'Store A Shared Operation',
        phone: '0599 310 006',
      })
      .expect(201);
    await authorizedPost(access.b)
      .send({
        id: randomUUID(),
        operationId: sharedOperationId,
        name: 'Store B Shared Operation',
        phone: '0599 310 006',
      })
      .expect(201);
  });

  it('denies read-only create before claim or Customer persistence', async () => {
    const id = randomUUID();
    const operationId = randomUUID();
    await authorizedPost(access.readOnly)
      .send({ id, operationId, name: 'Denied Create', phone: '0599 310 007' })
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' });
      });

    await expect(readCustomer(id)).resolves.toBeUndefined();
    const operation = await adminPool.query(
      `select operation_id from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [fixture.stores.readOnly, operationId],
    );
    expect(operation.rows).toEqual([]);
  });

  it('updates only supplied master data, derives device provenance, and returns actual versions', async () => {
    const nameOperation = randomUUID();
    const nameUpdate = readMutation(
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send({
          operationId: nameOperation,
          expectedVersion: '1',
          name: '  أحمــد   الجديد  ',
        })
        .expect(200),
    );
    expect(nameUpdate).toMatchObject({
      name: 'أحمــد الجديد',
      phone: '0599 300 001',
      notes: 'Original notes',
      version: '2',
      operationId: nameOperation,
    });

    const phoneOperation = randomUUID();
    const phoneUpdate = readMutation(
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send({
          operationId: phoneOperation,
          expectedVersion: '2',
          phone: '٠٥٩٩ ٣١٠ ٠٠٨',
        })
        .expect(200),
    );
    expect(phoneUpdate).toMatchObject({ version: '3', operationId: phoneOperation });

    const notesOperation = randomUUID();
    const notesUpdate = readMutation(
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send({ operationId: notesOperation, expectedVersion: '3', notes: null })
        .expect(200),
    );
    expect(notesUpdate).toMatchObject({ notes: null, version: '4', operationId: notesOperation });

    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      storeId: fixture.stores.a,
      normalizedName: 'احمد الجديد',
      normalizedPhone: '+970599310008',
      notes: null,
      deviceId: fixture.devices.a,
      operationId: notesOperation,
      version: '4',
    });
  });

  it('allows own-phone and equal-value updates while advancing the database-managed version', async () => {
    const first = readMutation(
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send({
          operationId: randomUUID(),
          expectedVersion: '1',
          phone: '+970599300001',
        })
        .expect(200),
    );
    expect(first).toMatchObject({ version: '2', phone: '+970599300001' });

    const second = readMutation(
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send({
          operationId: randomUUID(),
          expectedVersion: '2',
          name: first.name,
        })
        .expect(200),
    );
    expect(second.version).toBe('3');
  });

  it('classifies not-found, foreign, archived, and stale updates without cross-tenant leakage', async () => {
    const missing = await authorizedPatch(access.a, randomUUID())
      .send({ operationId: randomUUID(), expectedVersion: '1', notes: null })
      .expect(404);
    const foreign = await authorizedPatch(access.a, fixture.customers.bTarget)
      .send({ operationId: randomUUID(), expectedVersion: '999', notes: null })
      .expect(404);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(missing.body));
    expect(foreign.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });

    await authorizedPatch(access.a, fixture.customers.aArchived)
      .send({ operationId: randomUUID(), expectedVersion: '999', notes: null })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_ARCHIVED' });
      });
    await authorizedPatch(access.a, fixture.customers.aTarget)
      .send({ operationId: randomUUID(), expectedVersion: '999', notes: null })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
      });

    await expect(readCustomer(fixture.customers.aArchived)).resolves.toMatchObject({
      name: 'Store A Archived',
      version: '1',
      status: 'archived',
    });
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      notes: 'Original notes',
      version: '1',
    });
  });

  it('translates exact phone constraints and rolls back every conflicting update field', async () => {
    for (const phone of ['0599 300 002', '0599 300 003']) {
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send({
          operationId: randomUUID(),
          expectedVersion: '1',
          name: 'Must Roll Back',
          phone,
          notes: 'Must Roll Back',
        })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'CUSTOMER_PHONE_CONFLICT' });
          expect(JSON.stringify(body)).not.toContain('customers_store_id_normalized_phone_key');
          expect(JSON.stringify(body)).not.toContain('23505');
        });
      await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
        name: 'Store A Target',
        phone: '0599 300 001',
        notes: 'Original notes',
        version: '1',
      });
    }

    await authorizedPatch(access.a, fixture.customers.aTarget)
      .send({
        operationId: randomUUID(),
        expectedVersion: '1',
        phone: '0599 900 001',
      })
      .expect(200);
  });

  it('replays successful and rejected updates without duplicate row effects', async () => {
    const operationId = randomUUID();
    const payload = { operationId, expectedVersion: '1', notes: 'Applied Once' };
    const first = await authorizedPatch(access.a, fixture.customers.aTarget)
      .send(payload)
      .expect(200);
    const replay = await authorizedPatch(access.a, fixture.customers.aTarget)
      .send(payload)
      .expect(200);
    expect(replay.body).toEqual(first.body);
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      notes: 'Applied Once',
      version: '2',
    });

    const rejectedOperation = randomUUID();
    const rejectedPayload = {
      operationId: rejectedOperation,
      expectedVersion: '1',
      notes: 'Stale',
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await authorizedPatch(access.a, fixture.customers.aTarget)
        .send(rejectedPayload)
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
        });
    }
    const operation = await adminPool.query<{ status: string }>(
      `select status from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [fixture.stores.a, rejectedOperation],
    );
    expect(operation.rows).toEqual([{ status: 'rejected' }]);
  });

  it('denies read-only update before claim and preserves the original Customer', async () => {
    const operationId = randomUUID();
    await authorizedPatch(access.readOnly, fixture.customers.readOnlyTarget)
      .send({ operationId, expectedVersion: '1', notes: 'Denied' })
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' });
      });
    await expect(readCustomer(fixture.customers.readOnlyTarget)).resolves.toMatchObject({
      notes: null,
      version: '1',
    });
    const operation = await adminPool.query(
      `select operation_id from sync.processed_operations where store_id = $1 and operation_id = $2`,
      [fixture.stores.readOnly, operationId],
    );
    expect(operation.rows).toEqual([]);
  });

  it('permits at most one concurrent update from the same expected version', async () => {
    const [first, second] = await Promise.all([
      authorizedPatch(access.a, fixture.customers.aConcurrent).send({
        operationId: randomUUID(),
        expectedVersion: '1',
        notes: 'Concurrent One',
      }),
      authorizedPatch(access.a, fixture.customers.aConcurrent).send({
        operationId: randomUUID(),
        expectedVersion: '1',
        notes: 'Concurrent Two',
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });

    const persisted = await readCustomer(fixture.customers.aConcurrent);
    expect(persisted?.version).toBe('2');
    expect(['Concurrent One', 'Concurrent Two']).toContain(persisted?.notes);
  });

  it('uses the unique phone constraint to resolve repeated concurrent same-store races', async () => {
    for (let round = 1; round <= 3; round += 1) {
      await adminPool.query(
        `
          update ledger.customers
          set
            phone = case id when $1 then '0599 300 004' else '0599 300 005' end,
            normalized_phone = case id
              when $1 then '+970599300004'
              else '+970599300005'
            end,
            operation_id = case id
              when $1 then $3::uuid
              else $4::uuid
            end,
            version = 1
          where id = any($2::uuid[])
        `,
        [
          fixture.customers.aRaceOne,
          [fixture.customers.aRaceOne, fixture.customers.aRaceTwo],
          randomUUID(),
          randomUUID(),
        ],
      );
      const phoneSuffix = round.toString().padStart(3, '0');
      const canonicalPhone = `+970599400${phoneSuffix}`;
      const displayPhone = `0599 400 ${phoneSuffix}`;
      const [first, second] = await Promise.all([
        authorizedPatch(access.a, fixture.customers.aRaceOne).send({
          operationId: randomUUID(),
          expectedVersion: '1',
          phone: displayPhone,
        }),
        authorizedPatch(access.a, fixture.customers.aRaceTwo).send({
          operationId: randomUUID(),
          expectedVersion: '1',
          phone: canonicalPhone,
        }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body).toMatchObject({ code: 'CUSTOMER_PHONE_CONFLICT' });

      const owners = await adminPool.query<{ count: number }>(
        `
          select count(*)::integer as count
          from ledger.customers
          where store_id = $1 and normalized_phone = $2
        `,
        [fixture.stores.a, canonicalPhone],
      );
      expect(owners.rows[0]?.count).toBe(1);
    }
  });

  it('validates lifecycle authentication, identifiers, versions, and exact command fields', async () => {
    const valid = { operationId: randomUUID(), expectedVersion: '1' };
    await request(server)
      .post(`/v1/customers/${fixture.customers.aTarget}/archive`)
      .send(valid)
      .expect(401);
    await request(server)
      .post(`/v1/customers/${fixture.customers.aArchived}/restore`)
      .send(valid)
      .expect(401);

    for (const action of ['archive', 'restore'] as const) {
      await authorizedLifecycle(access.a, 'not-a-uuid', action).send(valid).expect(400);
      for (const body of [
        { operationId: 'not-a-uuid', expectedVersion: '1' },
        { operationId: randomUUID(), expectedVersion: '0' },
        { operationId: randomUUID(), expectedVersion: '04' },
        { operationId: randomUUID(), expectedVersion: '1.5' },
        { operationId: randomUUID(), expectedVersion: '9223372036854775808' },
        { ...valid, storeId: fixture.stores.b },
        { ...valid, deviceId: fixture.devices.b },
        { ...valid, status: action === 'archive' ? 'archived' : 'active' },
        { ...valid, archivedAt: '2026-08-01T00:00:00Z' },
        { ...valid, name: 'Forged lifecycle edit' },
        { ...valid, phone: '0599 999 999' },
        { ...valid, notes: 'Forged lifecycle edit' },
        { ...valid, version: '9' },
      ]) {
        const customerId =
          action === 'archive' ? fixture.customers.aTarget : fixture.customers.aArchived;
        await authorizedLifecycle(access.a, customerId, action)
          .send(body)
          .expect(400)
          .expect(({ body: errorBody }) => {
            expect(errorBody).toMatchObject({ code: 'VALIDATION_ERROR' });
          });
      }
    }

    await request(server).delete(`/v1/customers/${fixture.customers.aTarget}`).expect(404);
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      status: 'active',
      version: '1',
    });
    await expect(readCustomer(fixture.customers.aArchived)).resolves.toMatchObject({
      status: 'archived',
      version: '1',
    });
  });

  it('archives one Customer row with database time while preserving master and accounting data', async () => {
    const before = await readCustomer(fixture.customers.aTarget);
    if (!before) {
      throw new Error('Expected the active Customer fixture.');
    }
    const accountingBefore = await readAccountingCounts(fixture.stores.a);
    const lowerBound = await adminPool.query<{ now: Date }>(`select clock_timestamp() as now`);
    const operationId = randomUUID();
    const responseMessage = await authorizedLifecycle(
      access.a,
      fixture.customers.aTarget,
      'archive',
    )
      .set('x-store-id', fixture.stores.b)
      .query({ storeId: fixture.stores.b })
      .send({ operationId, expectedVersion: '1' })
      .expect(200);
    const upperBound = await adminPool.query<{ now: Date }>(`select clock_timestamp() as now`);
    const body = readMutation(responseMessage);
    const after = await readCustomer(fixture.customers.aTarget);
    if (!after?.archivedAt) {
      throw new Error('Expected the archived Customer result.');
    }

    expect(body).toMatchObject({
      id: before.id,
      name: before.name,
      phone: before.phone,
      notes: before.notes,
      status: 'archived',
      archivedAt: after.archivedAt.toISOString(),
      updatedAt: after.updatedAt.toISOString(),
      version: '2',
      operationId,
    });
    expect(Object.keys(body).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'id',
      'name',
      'notes',
      'operationId',
      'phone',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(changedCustomerFields(before, after)).toEqual([
      'archivedAt',
      'deviceId',
      'operationId',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(after).toMatchObject({
      id: before.id,
      storeId: before.storeId,
      name: before.name,
      normalizedName: before.normalizedName,
      phone: before.phone,
      normalizedPhone: before.normalizedPhone,
      notes: before.notes,
      creditLimitMinor: before.creditLimitMinor,
      creditPolicy: before.creditPolicy,
      status: 'archived',
      deviceId: fixture.devices.a,
      operationId,
      version: '2',
    });
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
    expect(after.archivedAt.getTime()).toBeGreaterThanOrEqual(
      lowerBound.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(after.archivedAt.getTime()).toBeLessThanOrEqual(
      upperBound.rows[0]?.now.getTime() ?? Number.NEGATIVE_INFINITY,
    );
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      lowerBound.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(after.updatedAt.getTime()).toBeLessThanOrEqual(
      upperBound.rows[0]?.now.getTime() ?? Number.NEGATIVE_INFINITY,
    );

    expect(
      readCustomerIds(await authorizedGet(access.a, '/v1/customers').expect(200)),
    ).not.toContain(before.id);
    expect(
      readCustomerIds(
        await authorizedGet(access.a, '/v1/customers').query({ status: 'archived' }).expect(200),
      ),
    ).toContain(before.id);
    await authorizedGet(access.a, `/v1/customers/${before.id}`)
      .expect(200)
      .expect(({ body: detail }) => {
        expect(detail).toMatchObject({ id: before.id, status: 'archived', version: '2' });
      });
    await authorizedPatch(access.a, before.id)
      .send({ operationId: randomUUID(), expectedVersion: '2', notes: 'Forbidden edit' })
      .expect(409)
      .expect(({ body: errorBody }) => {
        expect(errorBody).toMatchObject({ code: 'CUSTOMER_ARCHIVED' });
      });
    await authorizedPost(access.a)
      .send({
        id: randomUUID(),
        operationId: randomUUID(),
        name: 'Reserved Phone',
        phone: before.phone,
      })
      .expect(409)
      .expect(({ body: errorBody }) => {
        expect(errorBody).toMatchObject({ code: 'CUSTOMER_PHONE_CONFLICT' });
      });

    await expect(readAccountingCounts(fixture.stores.a)).resolves.toEqual(accountingBefore);
    const effects = await adminPool.query<{
      processed: number;
      changes: number;
      audits: number;
    }>(
      `
        select
          (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $2 and status = 'applied') as processed,
          (select count(*)::integer from sync.change_events
            where store_id = $1 and entity_id = $3 and action = 'archive') as changes,
          (select count(*)::integer from audit.central_audit_logs
            where store_id = $1 and entity_id = $3 and action = 'update') as audits
      `,
      [fixture.stores.a, operationId, before.id],
    );
    expect(effects.rows[0]).toEqual({ processed: 1, changes: 1, audits: 1 });
  });

  it('restores the same Customer identity and requires the newly current version for PATCH', async () => {
    const before = await readCustomer(fixture.customers.aArchived);
    if (!before?.archivedAt) {
      throw new Error('Expected the archived Customer fixture.');
    }
    const accountingBefore = await readAccountingCounts(fixture.stores.a);
    const operationId = randomUUID();
    const body = readMutation(
      await authorizedLifecycle(access.a, before.id, 'restore')
        .send({ operationId, expectedVersion: '1' })
        .expect(200),
    );
    const after = await readCustomer(before.id);
    if (!after) {
      throw new Error('Expected the restored Customer result.');
    }

    expect(body).toMatchObject({
      id: before.id,
      name: before.name,
      phone: before.phone,
      notes: before.notes,
      status: 'active',
      archivedAt: null,
      updatedAt: after.updatedAt.toISOString(),
      version: '2',
      operationId,
    });
    expect(changedCustomerFields(before, after)).toEqual([
      'archivedAt',
      'deviceId',
      'operationId',
      'status',
      'updatedAt',
      'version',
    ]);
    expect(after).toMatchObject({
      id: before.id,
      storeId: before.storeId,
      name: before.name,
      normalizedName: before.normalizedName,
      phone: before.phone,
      normalizedPhone: before.normalizedPhone,
      notes: before.notes,
      creditLimitMinor: before.creditLimitMinor,
      creditPolicy: before.creditPolicy,
      status: 'active',
      archivedAt: null,
      deviceId: fixture.devices.a,
      operationId,
      version: '2',
    });
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());

    expect(readCustomerIds(await authorizedGet(access.a, '/v1/customers').expect(200))).toContain(
      before.id,
    );
    expect(
      readCustomerIds(
        await authorizedGet(access.a, '/v1/customers').query({ status: 'archived' }).expect(200),
      ),
    ).not.toContain(before.id);
    expect(
      readCustomerIds(
        await authorizedGet(access.a, '/v1/customers')
          .query({ search: 'Store A Archived' })
          .expect(200),
      ),
    ).toContain(before.id);
    await authorizedGet(access.a, `/v1/customers/${before.id}`)
      .expect(200)
      .expect(({ body: detail }) => {
        expect(detail).toMatchObject({ id: before.id, status: 'active', version: '2' });
      });
    await authorizedPatch(access.a, before.id)
      .send({ operationId: randomUUID(), expectedVersion: '1', notes: 'Stale edit' })
      .expect(409)
      .expect(({ body: errorBody }) => {
        expect(errorBody).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
      });
    await authorizedPatch(access.a, before.id)
      .send({ operationId: randomUUID(), expectedVersion: '2', notes: 'Current edit' })
      .expect(200)
      .expect(({ body: updateBody }) => {
        expect(updateBody).toMatchObject({ status: 'active', notes: 'Current edit', version: '3' });
      });

    await expect(readAccountingCounts(fixture.stores.a)).resolves.toEqual(accountingBefore);
    const effects = await adminPool.query<{ processed: number; changes: number; audits: number }>(
      `
        select
          (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $2 and status = 'applied') as processed,
          (select count(*)::integer from sync.change_events
            where store_id = $1 and entity_id = $3 and action = 'update') as changes,
          (select count(*)::integer from audit.central_audit_logs
            where store_id = $1 and entity_id = $3 and action = 'update') as audits
      `,
      [fixture.stores.a, operationId, before.id],
    );
    expect(effects.rows[0]).toEqual({ processed: 1, changes: 2, audits: 2 });
  });

  it('classifies lifecycle failures tenant-safely and denies read-only stores before claim', async () => {
    const missingArchiveOperation = randomUUID();
    const foreignArchiveOperation = randomUUID();
    const missing = await authorizedLifecycle(access.a, randomUUID(), 'archive')
      .send({ operationId: missingArchiveOperation, expectedVersion: '1' })
      .expect(404);
    const foreign = await authorizedLifecycle(access.a, fixture.customers.bTarget, 'archive')
      .send({ operationId: foreignArchiveOperation, expectedVersion: '999' })
      .expect(404);
    expect(withoutTraceFields(foreign.body)).toEqual(withoutTraceFields(missing.body));
    expect(foreign.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });

    const alreadyArchivedOperation = randomUUID();
    await authorizedLifecycle(access.a, fixture.customers.aArchived, 'archive')
      .send({ operationId: alreadyArchivedOperation, expectedVersion: '999' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_ARCHIVED' });
      });
    const staleArchiveOperation = randomUUID();
    await authorizedLifecycle(access.a, fixture.customers.aTarget, 'archive')
      .send({ operationId: staleArchiveOperation, expectedVersion: '999' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
      });
    const alreadyActiveOperation = randomUUID();
    await authorizedLifecycle(access.a, fixture.customers.aTarget, 'restore')
      .send({ operationId: alreadyActiveOperation, expectedVersion: '999' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CONFLICT' });
      });
    const staleRestoreOperation = randomUUID();
    await authorizedLifecycle(access.a, fixture.customers.aArchived, 'restore')
      .send({ operationId: staleRestoreOperation, expectedVersion: '999' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
      });

    const deniedOperations = [randomUUID(), randomUUID()];
    await authorizedLifecycle(access.readOnly, fixture.customers.readOnlyTarget, 'archive')
      .send({ operationId: deniedOperations[0], expectedVersion: '1' })
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' });
      });
    await authorizedLifecycle(access.readOnly, fixture.customers.readOnlyTarget, 'restore')
      .send({ operationId: deniedOperations[1], expectedVersion: '1' })
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' });
      });

    const rejectedOperations = [
      missingArchiveOperation,
      foreignArchiveOperation,
      alreadyArchivedOperation,
      staleArchiveOperation,
      alreadyActiveOperation,
      staleRestoreOperation,
    ];
    const operationState = await adminPool.query<{ operationId: string; status: string }>(
      `
        select operation_id as "operationId", status
        from sync.processed_operations
        where store_id = $1 and operation_id = any($2::uuid[])
        order by operation_id
      `,
      [fixture.stores.a, rejectedOperations],
    );
    expect(operationState.rows).toHaveLength(rejectedOperations.length);
    expect(operationState.rows.every((operation) => operation.status === 'rejected')).toBe(true);
    const deniedState = await adminPool.query(
      `select operation_id from sync.processed_operations where operation_id = any($1::uuid[])`,
      [deniedOperations],
    );
    expect(deniedState.rows).toEqual([]);
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      status: 'active',
      version: '1',
    });
    await expect(readCustomer(fixture.customers.aArchived)).resolves.toMatchObject({
      status: 'archived',
      version: '1',
    });
  });

  it('replays historical lifecycle responses without changing the current Customer state', async () => {
    const archiveOperation = randomUUID();
    const archivePayload = { operationId: archiveOperation, expectedVersion: '1' };
    const archive = await authorizedLifecycle(access.a, fixture.customers.aTarget, 'archive')
      .send(archivePayload)
      .expect(200);
    const immediateReplay = await authorizedLifecycle(
      access.a,
      fixture.customers.aTarget,
      'archive',
    )
      .send(archivePayload)
      .expect(200);
    expect(immediateReplay.body).toEqual(archive.body);

    const restoreOperation = randomUUID();
    const restore = await authorizedLifecycle(access.a, fixture.customers.aTarget, 'restore')
      .send({ operationId: restoreOperation, expectedVersion: '2' })
      .expect(200);
    expect(restore.body).toMatchObject({ status: 'active', version: '3' });

    const historicalReplay = await authorizedLifecycle(
      access.a,
      fixture.customers.aTarget,
      'archive',
    )
      .send(archivePayload)
      .expect(200);
    expect(historicalReplay.body).toEqual(archive.body);
    expect(historicalReplay.body).toMatchObject({ status: 'archived', version: '2' });
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      status: 'active',
      archivedAt: null,
      version: '3',
      operationId: restoreOperation,
    });

    await authorizedLifecycle(access.a, fixture.customers.aTarget, 'restore')
      .send({ operationId: archiveOperation, expectedVersion: '3' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
      });
    await authorizedLifecycle(access.a, fixture.customers.aDuplicate, 'archive')
      .send({ operationId: archiveOperation, expectedVersion: '1' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
      });

    const rejectedOperation = randomUUID();
    const rejectedPayload = { operationId: rejectedOperation, expectedVersion: '999' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await authorizedLifecycle(access.a, fixture.customers.aDuplicate, 'archive')
        .send(rejectedPayload)
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
        });
    }
    await authorizedLifecycle(access.a, fixture.customers.aDuplicate, 'archive')
      .send({ operationId: rejectedOperation, expectedVersion: '1' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
      });
    await expect(readCustomer(fixture.customers.aDuplicate)).resolves.toMatchObject({
      status: 'active',
      version: '1',
    });

    const operationEffects = await adminPool.query<{
      changes: number;
      applied: number;
      rejected: number;
      conflicts: number;
    }>(
      `
        select
          (select count(*)::integer from sync.change_events
            where store_id = $1 and entity_id = $2) as changes,
          (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = any($3::uuid[]) and status = 'applied') as applied,
          (select count(*)::integer from sync.processed_operations
            where store_id = $1 and operation_id = $4 and status = 'rejected') as rejected,
          (select count(*)::integer from sync.conflicts
            where store_id = $1 and operation_id = any($5::uuid[])) as conflicts
      `,
      [
        fixture.stores.a,
        fixture.customers.aTarget,
        [archiveOperation, restoreOperation],
        rejectedOperation,
        [archiveOperation, rejectedOperation],
      ],
    );
    expect(operationEffects.rows[0]).toEqual({ changes: 2, applied: 2, rejected: 1, conflicts: 3 });
  });

  it('scopes the same lifecycle operation ID independently per store', async () => {
    const operationId = randomUUID();
    const [storeA, storeB] = await Promise.all([
      authorizedLifecycle(access.a, fixture.customers.aTarget, 'archive').send({
        operationId,
        expectedVersion: '1',
      }),
      authorizedLifecycle(access.b, fixture.customers.bTarget, 'archive').send({
        operationId,
        expectedVersion: '1',
      }),
    ]);
    expect([storeA.status, storeB.status]).toEqual([200, 200]);
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      storeId: fixture.stores.a,
      status: 'archived',
      deviceId: fixture.devices.a,
      operationId,
      version: '2',
    });
    await expect(readCustomer(fixture.customers.bTarget)).resolves.toMatchObject({
      storeId: fixture.stores.b,
      status: 'archived',
      deviceId: fixture.devices.b,
      operationId,
      version: '2',
    });
    const operations = await adminPool.query<{ count: number }>(
      `select count(*)::integer as count from sync.processed_operations where operation_id = $1`,
      [operationId],
    );
    expect(operations.rows[0]?.count).toBe(2);

    await authorizedLifecycle(access.a, fixture.customers.bTarget, 'restore')
      .send({ operationId: randomUUID(), expectedVersion: '2' })
      .expect(404)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
      });
    await expect(readCustomer(fixture.customers.bTarget)).resolves.toMatchObject({
      status: 'archived',
      version: '2',
    });
  });

  it('orders update/archive and duplicate lifecycle races with one coherent winner', async () => {
    const updateOperation = randomUUID();
    const archiveOperation = randomUUID();
    const [update, archive] = await Promise.all([
      authorizedPatch(access.a, fixture.customers.aConcurrent).send({
        operationId: updateOperation,
        expectedVersion: '1',
        notes: 'Concurrent update winner',
      }),
      authorizedLifecycle(access.a, fixture.customers.aConcurrent, 'archive').send({
        operationId: archiveOperation,
        expectedVersion: '1',
      }),
    ]);
    expect([update.status, archive.status].sort()).toEqual([200, 409]);
    const updateArchiveLoser = update.status === 409 ? update : archive;
    expect(['CUSTOMER_ARCHIVED', 'CUSTOMER_VERSION_CONFLICT']).toContain(
      readErrorCode(updateArchiveLoser),
    );
    const updateArchiveRow = await readCustomer(fixture.customers.aConcurrent);
    expect(updateArchiveRow?.version).toBe('2');
    if (update.status === 200) {
      expect(updateArchiveRow).toMatchObject({
        status: 'active',
        archivedAt: null,
        notes: 'Concurrent update winner',
        operationId: updateOperation,
      });
    } else {
      expect(updateArchiveRow).toMatchObject({
        status: 'archived',
        notes: null,
        operationId: archiveOperation,
      });
      expect(updateArchiveRow?.archivedAt).toBeInstanceOf(Date);
    }

    const archiveOperations = [randomUUID(), randomUUID()] as const;
    const [archiveOne, archiveTwo] = await Promise.all([
      authorizedLifecycle(access.a, fixture.customers.aRaceOne, 'archive').send({
        operationId: archiveOperations[0],
        expectedVersion: '1',
      }),
      authorizedLifecycle(access.a, fixture.customers.aRaceOne, 'archive').send({
        operationId: archiveOperations[1],
        expectedVersion: '1',
      }),
    ]);
    expect([archiveOne.status, archiveTwo.status].sort()).toEqual([200, 409]);
    const archiveLoser = archiveOne.status === 409 ? archiveOne : archiveTwo;
    expect(archiveLoser.body).toMatchObject({ code: 'CUSTOMER_ARCHIVED' });
    const archiveWinner = archiveOne.status === 200 ? archiveOne : archiveTwo;
    const archiveWinnerBody = readMutation(archiveWinner);
    if (!archiveWinnerBody.archivedAt) {
      throw new Error('Expected the archive race winner timestamp.');
    }
    await expect(readCustomer(fixture.customers.aRaceOne)).resolves.toMatchObject({
      status: 'archived',
      archivedAt: new Date(archiveWinnerBody.archivedAt),
      operationId: archiveWinnerBody.operationId,
      version: '2',
    });

    const restoreOperations = [randomUUID(), randomUUID()] as const;
    const [restoreOne, restoreTwo] = await Promise.all([
      authorizedLifecycle(access.a, fixture.customers.aArchived, 'restore').send({
        operationId: restoreOperations[0],
        expectedVersion: '1',
      }),
      authorizedLifecycle(access.a, fixture.customers.aArchived, 'restore').send({
        operationId: restoreOperations[1],
        expectedVersion: '1',
      }),
    ]);
    expect([restoreOne.status, restoreTwo.status].sort()).toEqual([200, 409]);
    const restoreLoser = restoreOne.status === 409 ? restoreOne : restoreTwo;
    expect(restoreLoser.body).toMatchObject({ code: 'CONFLICT' });
    const restoreWinner = restoreOne.status === 200 ? restoreOne : restoreTwo;
    const restoreWinnerBody = readMutation(restoreWinner);
    await expect(readCustomer(fixture.customers.aArchived)).resolves.toMatchObject({
      status: 'active',
      archivedAt: null,
      operationId: restoreWinnerBody.operationId,
      version: '2',
    });

    await authorizedPatch(access.a, fixture.customers.aArchived)
      .send({ operationId: randomUUID(), expectedVersion: '1', notes: 'Stale after restore' })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_VERSION_CONFLICT' });
      });
    await authorizedPatch(access.a, fixture.customers.aArchived)
      .send({ operationId: randomUUID(), expectedVersion: '2', notes: 'Current after restore' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ notes: 'Current after restore', version: '3' });
      });

    const raceOperations = [
      updateOperation,
      archiveOperation,
      ...archiveOperations,
      ...restoreOperations,
    ];
    const operationStates = await adminPool.query<{ status: string; count: number }>(
      `
        select status, count(*)::integer as count
        from sync.processed_operations
        where store_id = $1 and operation_id = any($2::uuid[])
        group by status
        order by status
      `,
      [fixture.stores.a, raceOperations],
    );
    expect(operationStates.rows).toEqual([
      { status: 'applied', count: 3 },
      { status: 'rejected', count: 3 },
    ]);
  });

  it('executes protected writes as a non-owner runtime role under forced RLS', async () => {
    const runtimeState = await runtimeInspectionPool.query<{
      currentUser: string;
      isSuperuser: boolean;
      bypassesRls: boolean;
      rowSecurityEnabled: boolean;
      runtimeMember: boolean;
      ownsCustomers: boolean;
      rlsForced: boolean;
    }>(`
      select
        current_user as "currentUser",
        role_state.rolsuper as "isSuperuser",
        role_state.rolbypassrls as "bypassesRls",
        current_setting('row_security') = 'on' as "rowSecurityEnabled",
        pg_has_role(current_user, 'shop_app_runtime', 'MEMBER') as "runtimeMember",
        pg_get_userbyid(customer_table.relowner) = current_user as "ownsCustomers",
        customer_table.relforcerowsecurity as "rlsForced"
      from pg_roles as role_state
      cross join pg_class as customer_table
      where role_state.rolname = current_user
        and customer_table.oid = 'ledger.customers'::regclass
    `);
    expect(runtimeState.rows[0]).toEqual({
      currentUser: decodeURIComponent(new URL(environment?.runtimeUrl ?? '').username),
      isSuperuser: false,
      bypassesRls: false,
      rowSecurityEnabled: true,
      runtimeMember: true,
      ownsCustomers: false,
      rlsForced: true,
    });

    await expect(
      runtimeInspectionPool.query(
        `
          insert into ledger.customers (
            id, store_id, name, normalized_name, phone, normalized_phone, operation_id
          ) values ($1, $2, 'No Context', 'no context', '0599 399 999', '+970599399999', $3)
        `,
        [randomUUID(), fixture.stores.a, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const runtimeClient = await runtimeInspectionPool.connect();
    try {
      await runtimeClient.query('begin');
      await runtimeClient.query(
        `
          select
            set_config('app.store_id', $1, true),
            set_config('app.user_id', $2, true),
            set_config('app.device_id', $3, true),
            set_config('app.request_id', $4, true)
        `,
        [fixture.stores.b, fixture.users.b, fixture.devices.b, randomUUID()],
      );
      const wrongTenant = await runtimeClient.query(
        `
          update ledger.customers
          set status = 'archived', archived_at = clock_timestamp()
          where id = $1
          returning id
        `,
        [fixture.customers.aTarget],
      );
      expect(wrongTenant.rows).toEqual([]);
      await runtimeClient.query('rollback');

      await runtimeClient.query('begin');
      await runtimeClient.query(
        `
          select
            set_config('app.store_id', $1, true),
            set_config('app.user_id', $2, true),
            set_config('app.device_id', $3, true),
            set_config('app.request_id', $4, true)
        `,
        [fixture.stores.a, fixture.users.a, fixture.devices.a, randomUUID()],
      );
      await expect(
        runtimeClient.query(`update ledger.customers set store_id = $1 where id = $2`, [
          fixture.stores.b,
          fixture.customers.aTarget,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await runtimeClient.query('rollback');
    } finally {
      await runtimeClient.query('rollback').catch(() => undefined);
      runtimeClient.release();
    }
    await expect(readCustomer(fixture.customers.aTarget)).resolves.toMatchObject({
      storeId: fixture.stores.a,
      status: 'active',
      version: '1',
    });

    const id = randomUUID();
    await authorizedPost(access.a)
      .send({ id, operationId: randomUUID(), name: 'RLS HTTP Create', phone: '0599 310 009' })
      .expect(201);
    await authorizedPatch(access.a, id)
      .send({ operationId: randomUUID(), expectedVersion: '1', notes: 'RLS HTTP Update' })
      .expect(200);
    await authorizedLifecycle(access.a, id, 'archive')
      .send({ operationId: randomUUID(), expectedVersion: '2' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ id, status: 'archived', version: '3' });
      });
  });
});
