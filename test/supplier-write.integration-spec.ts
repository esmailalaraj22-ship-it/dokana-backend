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
import { SupplierWriteRepository } from '../src/suppliers/supplier-write.repository';
import { SupplierWriteService } from '../src/suppliers/supplier-write.service';
import {
  canonicalizeSupplierName,
  canonicalizeSupplierPhone,
} from '../src/suppliers/supplier-validation';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(60_000);

const fixture = {
  stores: {
    a: '66000000-0000-4000-8000-000000000001',
    b: '66000000-0000-4000-8000-000000000002',
    readOnly: '66000000-0000-4000-8000-000000000003',
    viewer: '66000000-0000-4000-8000-000000000004',
    flip: '66000000-0000-4000-8000-000000000005',
  },
  users: {
    a: '66100000-0000-4000-8000-000000000001',
    b: '66100000-0000-4000-8000-000000000002',
    readOnly: '66100000-0000-4000-8000-000000000003',
    viewer: '66100000-0000-4000-8000-000000000004',
    flip: '66100000-0000-4000-8000-000000000005',
  },
  memberships: {
    a: '66200000-0000-4000-8000-000000000001',
    b: '66200000-0000-4000-8000-000000000002',
    readOnly: '66200000-0000-4000-8000-000000000003',
    viewer: '66200000-0000-4000-8000-000000000004',
    flip: '66200000-0000-4000-8000-000000000005',
  },
  devices: {
    a: '66300000-0000-4000-8000-000000000001',
    b: '66300000-0000-4000-8000-000000000002',
    readOnly: '66300000-0000-4000-8000-000000000003',
    viewer: '66300000-0000-4000-8000-000000000004',
    flip: '66300000-0000-4000-8000-000000000005',
    aSecond: '66300000-0000-4000-8000-000000000101',
  },
  emails: {
    a: 'task64-a@example.test',
    b: 'task64-b@example.test',
    readOnly: 'task64-read-only@example.test',
    viewer: 'task64-viewer@example.test',
    flip: 'task64-flip@example.test',
  },
  password: 'Task-6.4-Test-Password!',
};

interface AccessIdentity {
  accessToken: string;
  storeId: string;
  userId: string;
  deviceId: string;
}

interface AccessMap {
  a: AccessIdentity;
  b: AccessIdentity;
  readOnly: AccessIdentity;
  viewer: AccessIdentity;
  flip: AccessIdentity;
}

interface OperationState {
  status: 'processing' | 'applied' | 'rejected';
  responseCode: number | null;
  errorCode: string | null;
  requestHash: string;
  deviceId: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  completed: boolean;
}

interface SupplierState {
  id: string;
  name: string;
  normalizedName: string;
  phone: string | null;
  normalizedPhone: string | null;
  notes: string | null;
  status: 'active' | 'archived';
  archivedAt: Date | null;
  deviceId: string | null;
  operationId: string;
  createdAt: Date;
  updatedAt: Date;
  version: string;
}

interface SupplierEffects {
  changeEvents: number;
  auditLogs: number;
}

const storeIds = Object.values(fixture.stores);
const userIds = Object.values(fixture.users);
let phoneSequence = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!isRecord(value)) {
    throw new Error('Expected an object response body.');
  }
  return value;
}

function nextPhone(): string {
  phoneSequence += 1;
  return `0598${phoneSequence.toString().padStart(6, '0')}`;
}

interface CreateOverrides {
  id?: string;
  operationId?: string;
  name?: string;
  phone?: string;
  notes?: string | null;
}

function createBody(overrides: CreateOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? randomUUID(),
    operationId: overrides.operationId ?? randomUUID(),
    name: overrides.name ?? 'Supplier Name',
    phone: overrides.phone ?? nextPhone(),
    ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
  };
}

function createRequestHash(payload: Record<string, unknown>): string {
  const supplierId = (payload.id as string).toLowerCase();
  const { name, normalizedName } = canonicalizeSupplierName(payload.name);
  const { phone, normalizedPhone } = canonicalizeSupplierPhone(payload.phone);
  const notes = payload.notes === undefined ? null : payload.notes;
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        action: 'supplier.create',
        supplierId,
        name,
        normalizedName,
        phone,
        normalizedPhone,
        notes,
      }),
      'utf8',
    )
    .digest('hex');
}

describe('Supplier write API with real PostgreSQL', () => {
  let adminPool: Pool;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let supplierWrites: SupplierWriteService;
  let poolsInitialized = false;
  const access = {} as AccessMap;

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
    await adminPool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from sync.conflicts where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from audit.central_audit_logs where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from ledger.suppliers where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIds,
    ]);
    await adminPool.query(
      `delete from platform.store_memberships where store_id = any($1::uuid[])`,
      [storeIds],
    );
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIds]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIds]);
  }

  async function login(
    key: keyof typeof fixture.emails,
    storeId: string,
    userId: string,
    deviceId: string,
  ): Promise<AccessIdentity> {
    const response = await request(server)
      .post('/v1/auth/login')
      .send({
        email: fixture.emails[key],
        password: fixture.password,
        storeId,
        deviceId,
        deviceName: `Task 6.4 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    const accessToken = body(response).accessToken;
    if (typeof accessToken !== 'string') {
      throw new Error('Login did not return an access token.');
    }
    return { accessToken, storeId, userId, deviceId };
  }

  function post(identity: AccessIdentity, path = '/v1/suppliers') {
    return request(server).post(path).set('authorization', `Bearer ${identity.accessToken}`);
  }

  function patch(identity: AccessIdentity, supplierId: string) {
    return request(server)
      .patch(`/v1/suppliers/${supplierId}`)
      .set('authorization', `Bearer ${identity.accessToken}`);
  }

  async function insertSupplier(options: {
    id?: string;
    storeId?: string;
    name?: string;
    phone?: string | null;
    normalizedPhone?: string | null;
    notes?: string | null;
    status?: 'active' | 'archived';
    version?: string;
  }): Promise<string> {
    const id = options.id ?? randomUUID();
    const name = options.name ?? 'Fixture Supplier';
    const normalizedName = canonicalizeSupplierName(name).normalizedName;
    const status = options.status ?? 'active';
    await adminPool.query(
      `
        insert into ledger.suppliers (
          id, store_id, name, normalized_name, phone, normalized_phone, notes,
          status, archived_at, operation_id, version
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          case when $8 = 'archived' then clock_timestamp() else null end,
          $9, $10::bigint
        )
      `,
      [
        id,
        options.storeId ?? fixture.stores.a,
        name,
        normalizedName,
        options.phone ?? null,
        options.normalizedPhone ?? null,
        options.notes ?? null,
        status,
        randomUUID(),
        options.version ?? '1',
      ],
    );
    return id;
  }

  async function readOperation(
    storeId: string,
    operationId: string,
  ): Promise<OperationState | null> {
    const result = await adminPool.query<OperationState>(
      `
        select
          status,
          response_code as "responseCode",
          error_code as "errorCode",
          request_hash as "requestHash",
          device_id as "deviceId",
          aggregate_type as "aggregateType",
          aggregate_id as "aggregateId",
          action,
          completed_at is not null as completed
        from sync.processed_operations
        where store_id = $1 and operation_id = $2
      `,
      [storeId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async function readSupplier(id: string): Promise<SupplierState | null> {
    const result = await adminPool.query<SupplierState>(
      `
        select
          id, name, normalized_name as "normalizedName", phone,
          normalized_phone as "normalizedPhone", notes, status,
          archived_at as "archivedAt", device_id as "deviceId",
          operation_id as "operationId", created_at as "createdAt",
          updated_at as "updatedAt", version::text as version
        from ledger.suppliers where id = $1
      `,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async function readSupplierEffects(
    storeId: string,
    supplierId: string,
  ): Promise<SupplierEffects> {
    const result = await adminPool.query<SupplierEffects>(
      `
        select
          (select count(*)::integer from sync.change_events
            where store_id = $1 and entity_type = 'suppliers' and entity_id = $2) as "changeEvents",
          (select count(*)::integer from audit.central_audit_logs
            where store_id = $1 and entity_type = 'ledger.suppliers' and entity_id = $2) as "auditLogs"
      `,
      [storeId, supplierId],
    );
    const effects = result.rows[0];
    if (!effects) {
      throw new Error('Expected Supplier effect counts.');
    }
    return effects;
  }

  async function expectRejectedReplay(
    supplierId: string,
    payload: Record<string, unknown>,
    statusCode: number,
    errorCode: string,
  ): Promise<void> {
    const first = body(await patch(access.a, supplierId).send(payload).expect(statusCode));
    const replay = body(await patch(access.a, supplierId).send(payload).expect(statusCode));
    expect(first).toMatchObject({ code: errorCode });
    expect(replay).toMatchObject({ code: errorCode });
    const operation = await readOperation(fixture.stores.a, payload.operationId as string);
    expect(operation).toMatchObject({
      status: 'rejected',
      responseCode: statusCode,
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
    process.env.DB_POOL_MAX = '8';

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task64-admin',
      2,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
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
      throw new Error('The local Supplier write fixture database is not approved.');
    }

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 6.4 Store A', 'active'),
          ($2, 'Task 6.4 Store B', 'active'),
          ($3, 'Task 6.4 Read Only', 'read_only'),
          ($4, 'Task 6.4 Viewer', 'active'),
          ($5, 'Task 6.4 Flip', 'active')
      `,
      storeIds,
    );
    await adminPool.query(
      `
        insert into platform.users (id, email, normalized_email, password_hash, full_name, status)
        values
          ($1, $2, $2, $11, 'Task 6.4 Owner A', 'active'),
          ($3, $4, $4, $11, 'Task 6.4 Owner B', 'active'),
          ($5, $6, $6, $11, 'Task 6.4 Read Only Owner', 'active'),
          ($7, $8, $8, $11, 'Task 6.4 Viewer', 'active'),
          ($9, $10, $10, $11, 'Task 6.4 Flip Owner', 'active')
      `,
      [
        fixture.users.a,
        fixture.emails.a,
        fixture.users.b,
        fixture.emails.b,
        fixture.users.readOnly,
        fixture.emails.readOnly,
        fixture.users.viewer,
        fixture.emails.viewer,
        fixture.users.flip,
        fixture.emails.flip,
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
          ($10, $11, $12, 'viewer', 'active'),
          ($13, $14, $15, 'owner', 'active')
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
        fixture.memberships.viewer,
        fixture.stores.viewer,
        fixture.users.viewer,
        fixture.memberships.flip,
        fixture.stores.flip,
        fixture.users.flip,
      ],
    );

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
    supplierWrites = nestApp.get(SupplierWriteService);

    access.a = await login('a', fixture.stores.a, fixture.users.a, fixture.devices.a);
    access.b = await login('b', fixture.stores.b, fixture.users.b, fixture.devices.b);
    access.readOnly = await login(
      'readOnly',
      fixture.stores.readOnly,
      fixture.users.readOnly,
      fixture.devices.readOnly,
    );
    access.viewer = await login(
      'viewer',
      fixture.stores.viewer,
      fixture.users.viewer,
      fixture.devices.viewer,
    );
    access.flip = await login(
      'flip',
      fixture.stores.flip,
      fixture.users.flip,
      fixture.devices.flip,
    );
    await adminPool.query(
      `
        insert into ledger.devices (
          id, store_id, device_name, platform, installation_id, device_prefix, status
        ) values ($1, $2, 'Task 6.4 trusted second device', 'android', $3, 't64b', 'active')
      `,
      [fixture.devices.aSecond, fixture.stores.a, randomUUID()],
    );
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
          + (select count(*) from ledger.suppliers where store_id = any($1::uuid[]))
          + (select count(*) from sync.processed_operations where store_id = any($1::uuid[]))
          + (select count(*) from sync.change_events where store_id = any($1::uuid[]))
          + (select count(*) from audit.central_audit_logs where store_id = any($1::uuid[]))
        )::integer as count
      `,
      [storeIds, userIds],
    );
    expect(residue.rows[0]?.count).toBe(0);
    await adminPool.end();
  });

  it('enforces authentication, owner authority, strict DTOs, and pre-claim failures', async () => {
    const unauthenticated = createBody();
    await request(server).post('/v1/suppliers').send(unauthenticated).expect(401);
    expect(await readOperation(fixture.stores.a, unauthenticated.operationId as string)).toBeNull();

    const denied = createBody();
    const deniedResponse = body(await post(access.viewer).send(denied).expect(403));
    expect(deniedResponse.code).toBe('SUPPLIER_WRITE_NOT_ALLOWED');
    expect(await readOperation(fixture.stores.viewer, denied.operationId as string)).toBeNull();

    const readOnly = createBody();
    const readOnlyResponse = body(await post(access.readOnly).send(readOnly).expect(403));
    expect(readOnlyResponse.code).toBe('BUSINESS_WRITE_NOT_ALLOWED');
    expect(await readOperation(fixture.stores.readOnly, readOnly.operationId as string)).toBeNull();

    const invalid = createBody();
    const invalidResponse = body(
      await post(access.a)
        .send({ ...invalid, phone: null, storeId: fixture.stores.b })
        .expect(400),
    );
    expect(invalidResponse.code).toBe('VALIDATION_ERROR');
    expect(await readOperation(fixture.stores.a, invalid.operationId as string)).toBeNull();
  });

  it('creates only Supplier master data with canonical values and exact public projection', async () => {
    const payload = createBody({
      name: '  Same   Supplier  ',
      phone: ' (0599) 123 401 ',
      notes: '  exact notes  ',
    });
    const created = body(await post(access.a).send(payload).expect(201));

    expect(Object.keys(created).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(created).toMatchObject({
      id: payload.id,
      operationId: payload.operationId,
      name: 'Same Supplier',
      phone: '(0599) 123 401',
      notes: '  exact notes  ',
      status: 'active',
      archivedAt: null,
      version: '1',
    });
    expect(Date.parse(created.createdAt as string)).not.toBeNaN();
    expect(Date.parse(created.updatedAt as string)).not.toBeNaN();

    const stored = await readSupplier(payload.id as string);
    expect(stored).toMatchObject({
      name: 'Same Supplier',
      normalizedName: 'same supplier',
      phone: '(0599) 123 401',
      normalizedPhone: '+970599123401',
      notes: '  exact notes  ',
      status: 'active',
      deviceId: access.a.deviceId,
      operationId: payload.operationId,
      version: '1',
    });
    expect(await readSupplierEffects(fixture.stores.a, payload.id as string)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });

    const accounting = await adminPool.query<{ effects: number }>(
      `
        select (
          (select count(*) from ledger.purchase_invoices where store_id = $1)
          + (select count(*) from ledger.supplier_payments where store_id = $1)
          + (select count(*) from ledger.supplier_ledger_entries where store_id = $1)
          + (select count(*) from ledger.inventory_movements where store_id = $1)
          + (select count(*) from ledger.stock_balances where store_id = $1)
          + (select count(*) from ledger.money_movements where store_id = $1)
        )::integer as effects
      `,
      [fixture.stores.a],
    );
    expect(accounting.rows[0]?.effects).toBe(0);

    const duplicateName = createBody({ name: 'Same Supplier' });
    await post(access.a).send(duplicateName).expect(201);
  });

  it('exact-replays the original create snapshot and conflicts on changed payload or device', async () => {
    const payload = createBody();
    const first = body(await post(access.a).send(payload).expect(201));
    const replay = body(await post(access.a).send(payload).expect(201));
    expect(replay).toEqual(first);

    await patch(access.a, payload.id as string)
      .send({ operationId: randomUUID(), expectedVersion: '1', name: 'Later Name' })
      .expect(200);
    expect(body(await post(access.a).send(payload).expect(201))).toEqual(first);

    const changed = body(
      await post(access.a)
        .send({ ...payload, name: 'Changed Request' })
        .expect(409),
    );
    expect(changed.code).toBe('OPERATION_ID_CONFLICT');
    await expect(
      supplierWrites.create(
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
        {
          id: payload.id as string,
          operationId: payload.operationId as string,
          name: payload.name as string,
          phone: payload.phone as string,
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'OPERATION_ID_CONFLICT' } });
    expect(await readSupplierEffects(fixture.stores.a, payload.id as string)).toEqual({
      changeEvents: 2,
      auditLogs: 2,
    });
  });

  it('applies partial PATCH omission/null/empty semantics and rejects lifecycle fields', async () => {
    const payload = createBody({ notes: 'keep' });
    await post(access.a).send(payload).expect(201);

    const namePatch = {
      operationId: randomUUID(),
      expectedVersion: '1',
      name: '  Renamed  ',
    };
    const nameOnly = body(
      await patch(access.a, payload.id as string)
        .send(namePatch)
        .expect(200),
    );
    expect(nameOnly).toMatchObject({ name: 'Renamed', notes: 'keep', version: '2' });

    const cleared = body(
      await patch(access.a, payload.id as string)
        .send({ operationId: randomUUID(), expectedVersion: '2', notes: null })
        .expect(200),
    );
    expect(cleared).toMatchObject({ notes: null, version: '3' });

    const empty = body(
      await patch(access.a, payload.id as string)
        .send({ operationId: randomUUID(), expectedVersion: '3', notes: '' })
        .expect(200),
    );
    expect(empty).toMatchObject({ notes: '', version: '4' });

    const whitespace = body(
      await patch(access.a, payload.id as string)
        .send({ operationId: randomUUID(), expectedVersion: '4', notes: '  ' })
        .expect(200),
    );
    expect(whitespace).toMatchObject({ notes: '  ', version: '5' });
    expect(
      body(
        await patch(access.a, payload.id as string)
          .send(namePatch)
          .expect(200),
      ),
    ).toEqual(nameOnly);

    await patch(access.a, payload.id as string)
      .send({ operationId: randomUUID(), expectedVersion: '5' })
      .expect(400);
    await patch(access.a, payload.id as string)
      .send({
        operationId: randomUUID(),
        expectedVersion: '5',
        name: 'Forbidden',
        status: 'archived',
      })
      .expect(400);
  });

  it('preserves legacy null phone and does not invent normalized-phone repair policy (P64-D1/F-1)', async () => {
    const legacyId = await insertSupplier({
      phone: null,
      normalizedPhone: null,
      version: '9007199254740993',
    });
    const unrelated = body(
      await patch(access.a, legacyId)
        .send({
          operationId: randomUUID(),
          expectedVersion: '9007199254740993',
          name: 'Legacy Renamed',
          notes: 'preserved',
        })
        .expect(200),
    );
    expect(unrelated).toMatchObject({ phone: null, version: '9007199254740994' });
    expect(await readSupplier(legacyId)).toMatchObject({
      phone: null,
      normalizedPhone: null,
    });

    const established = body(
      await patch(access.a, legacyId)
        .send({
          operationId: randomUUID(),
          expectedVersion: '9007199254740994',
          phone: '+970 599 555 601',
        })
        .expect(200),
    );
    expect(established.phone).toBe('+970 599 555 601');

    const inconsistentId = await insertSupplier({
      phone: '+970 599 555 602',
      normalizedPhone: null,
    });
    await patch(access.a, inconsistentId)
      .send({ operationId: randomUUID(), expectedVersion: '1', notes: 'unrelated' })
      .expect(200);
    expect(await readSupplier(inconsistentId)).toMatchObject({
      phone: '+970 599 555 602',
      normalizedPhone: null,
      notes: 'unrelated',
    });

    for (const phone of [null, '', 'not-a-phone']) {
      const operationId = randomUUID();
      await patch(access.a, inconsistentId)
        .send({ operationId, expectedVersion: '2', phone })
        .expect(400);
      expect(await readOperation(fixture.stores.a, operationId)).toBeNull();
    }
  });

  it('stores and exact-replays deterministic not-found, stale, and archived rejections', async () => {
    await expectRejectedReplay(
      randomUUID(),
      { operationId: randomUUID(), expectedVersion: '1', name: 'Missing' },
      404,
      'SUPPLIER_NOT_FOUND',
    );

    const activeId = await insertSupplier({ phone: nextPhone(), normalizedPhone: '+970598777701' });
    await expectRejectedReplay(
      activeId,
      { operationId: randomUUID(), expectedVersion: '2', name: 'Stale' },
      409,
      'SUPPLIER_VERSION_CONFLICT',
    );

    const archivedId = await insertSupplier({ status: 'archived' });
    await expectRejectedReplay(
      archivedId,
      { operationId: randomUUID(), expectedVersion: '1', notes: 'denied' },
      409,
      'SUPPLIER_ARCHIVED',
    );
  });

  it('enforces phone uniqueness, archived reservation, cross-store reuse, and generic UUID collision', async () => {
    const displayPhone = '+970 599 555 701';
    const normalizedPhone = '+970599555701';
    await insertSupplier({ phone: displayPhone, normalizedPhone, status: 'archived' });

    const duplicate = createBody({ phone: '0599555701' });
    const duplicateResponse = body(await post(access.a).send(duplicate).expect(409));
    expect(duplicateResponse.code).toBe('SUPPLIER_PHONE_CONFLICT');
    expect(await readOperation(fixture.stores.a, duplicate.operationId as string)).toMatchObject({
      status: 'rejected',
      errorCode: 'SUPPLIER_PHONE_CONFLICT',
      completed: true,
    });
    expect(body(await post(access.a).send(duplicate).expect(409)).code).toBe(
      'SUPPLIER_PHONE_CONFLICT',
    );

    await post(access.b)
      .send(createBody({ phone: '0599555701' }))
      .expect(201);

    const updateTarget = createBody({ phone: '+970 599 555 702' });
    await post(access.a).send(updateTarget).expect(201);
    const updateConflict = {
      operationId: randomUUID(),
      expectedVersion: '1',
      phone: '0599555701',
    };
    expect(
      body(
        await patch(access.a, updateTarget.id as string)
          .send(updateConflict)
          .expect(409),
      ).code,
    ).toBe('SUPPLIER_PHONE_CONFLICT');
    expect(
      body(
        await patch(access.a, updateTarget.id as string)
          .send(updateConflict)
          .expect(409),
      ).code,
    ).toBe('SUPPLIER_PHONE_CONFLICT');

    const collisionId = await insertSupplier({ name: 'Collision' });
    const collision = createBody({ id: collisionId });
    expect(body(await post(access.a).send(collision).expect(409)).code).toBe('CONFLICT');
    expect(body(await post(access.a).send(collision).expect(409)).code).toBe('CONFLICT');

    const foreignCollisionId = await insertSupplier({
      storeId: fixture.stores.b,
      name: 'Foreign Collision',
    });
    const foreignCollision = createBody({ id: foreignCollisionId });
    expect(body(await post(access.a).send(foreignCollision).expect(409)).code).toBe('CONFLICT');
    expect(await readSupplier(foreignCollisionId)).toMatchObject({ name: 'Foreign Collision' });
  });

  it('completes canonical no-op without Supplier row, event, audit, version, or timestamp changes (P64-D2)', async () => {
    const payload = createBody({
      name: 'No Op Supplier',
      phone: '+970 599 555 801',
      notes: 'same',
    });
    await post(access.a).send(payload).expect(201);
    const before = await readSupplier(payload.id as string);
    const beforeEffects = await readSupplierEffects(fixture.stores.a, payload.id as string);
    const operationId = randomUUID();
    const noOp = body(
      await patch(access.a, payload.id as string)
        .send({
          operationId,
          expectedVersion: '1',
          name: '  No   Op Supplier ',
          phone: '+970 599 555 801',
          notes: 'same',
        })
        .expect(200),
    );
    const after = await readSupplier(payload.id as string);

    expect(noOp).toMatchObject({ version: '1', operationId });
    expect(after).toEqual(before);
    expect(await readSupplierEffects(fixture.stores.a, payload.id as string)).toEqual(
      beforeEffects,
    );
    expect(await readOperation(fixture.stores.a, operationId)).toMatchObject({
      status: 'applied',
      responseCode: 200,
      completed: true,
    });
    expect(
      body(
        await patch(access.a, payload.id as string)
          .send({
            operationId,
            expectedVersion: '1',
            name: '  No   Op Supplier ',
            phone: '+970 599 555 801',
            notes: 'same',
          })
          .expect(200),
      ),
    ).toEqual(noOp);
  });

  it('allows read-only exact applied/rejected replay but denies new writes and preserves conflict ordering', async () => {
    const payload = createBody();
    const applied = body(await post(access.flip).send(payload).expect(201));
    const missingId = randomUUID();
    const rejectedPayload = {
      operationId: randomUUID(),
      expectedVersion: '1',
      name: 'Missing',
    };
    const rejected = body(await patch(access.flip, missingId).send(rejectedPayload).expect(404));
    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.flip,
    ]);
    try {
      expect(body(await post(access.flip).send(payload).expect(201))).toEqual(applied);
      expect(
        body(await patch(access.flip, missingId).send(rejectedPayload).expect(404)),
      ).toMatchObject({ code: rejected.code });
      expect(
        body(
          await post(access.flip)
            .send({ ...payload, name: 'Changed' })
            .expect(409),
        ).code,
      ).toBe('OPERATION_ID_CONFLICT');

      const newPayload = createBody();
      expect(body(await post(access.flip).send(newPayload).expect(403)).code).toBe(
        'BUSINESS_WRITE_NOT_ALLOWED',
      );
      expect(await readOperation(fixture.stores.flip, newPayload.operationId as string)).toBeNull();
    } finally {
      await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
        fixture.stores.flip,
      ]);
    }
  });

  it('does not allow completed replay through suspended or archived store sessions', async () => {
    const suspendedPayload = createBody();
    await post(access.flip).send(suspendedPayload).expect(201);
    await adminPool.query(`update ledger.stores set status = 'suspended' where id = $1`, [
      fixture.stores.flip,
    ]);
    await post(access.flip).send(suspendedPayload).expect(401);

    await adminPool.query(`update ledger.stores set status = 'archived' where id = $1`, [
      fixture.stores.flip,
    ]);
    await post(access.flip).send(suspendedPayload).expect(401);
    await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
      fixture.stores.flip,
    ]);
  });

  it('keeps foreign Supplier targets, phone values, and operation namespaces tenant-safe', async () => {
    const foreignId = await insertSupplier({
      storeId: fixture.stores.b,
      name: 'Foreign Private Supplier',
      phone: '+970 599 555 901',
      normalizedPhone: '+970599555901',
    });
    const operationId = randomUUID();
    const foreignTarget = body(
      await patch(access.a, foreignId)
        .send({ operationId, expectedVersion: '1', name: 'Probe' })
        .expect(404),
    );
    expect(foreignTarget.code).toBe('SUPPLIER_NOT_FOUND');
    expect(await readSupplier(foreignId)).toMatchObject({ name: 'Foreign Private Supplier' });

    const sharedOperationId = randomUUID();
    await post(access.b)
      .send(createBody({ operationId: sharedOperationId }))
      .expect(201);
    await post(access.a)
      .send(createBody({ operationId: sharedOperationId }))
      .expect(201);
    await post(access.a)
      .send(createBody({ phone: '0599555901' }))
      .expect(201);
  });

  it('serializes duplicate-phone and same-version races with exactly one business winner', async () => {
    const sharedPhone = '+970 599 556 001';
    const first = createBody({ phone: sharedPhone });
    const second = createBody({ phone: sharedPhone });
    const createResponses = await Promise.all([
      post(access.a).send(first),
      post(access.a).send(second),
    ]);
    expect(createResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      createResponses.some((response) => body(response).code === 'SUPPLIER_PHONE_CONFLICT'),
    ).toBe(true);
    const duplicates = await adminPool.query<{ count: string }>(
      `select count(*)::text as count from ledger.suppliers
       where store_id = $1 and normalized_phone = $2`,
      [fixture.stores.a, '+970599556001'],
    );
    expect(duplicates.rows[0]?.count).toBe('1');

    const winnerId = (
      createResponses.find((response) => response.status === 201)?.body as Record<string, unknown>
    ).id as string;
    const updates = await Promise.all([
      patch(access.a, winnerId).send({
        operationId: randomUUID(),
        expectedVersion: '1',
        name: 'Concurrent A',
      }),
      patch(access.a, winnerId).send({
        operationId: randomUUID(),
        expectedVersion: '1',
        name: 'Concurrent B',
      }),
    ]);
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(updates.some((response) => body(response).code === 'SUPPLIER_VERSION_CONFLICT')).toBe(
      true,
    );
    expect((await readSupplier(winnerId))?.version).toBe('2');
  });

  it('serializes concurrent identical operations into one Supplier effect', async () => {
    const payload = createBody({ phone: '+970 599 556 101' });
    const responses = await Promise.all([
      post(access.a).send(payload),
      post(access.a).send(payload),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(body(responses[0])).toEqual(body(responses[1]));
    expect(await readSupplierEffects(fixture.stores.a, payload.id as string)).toEqual({
      changeEvents: 1,
      auditLogs: 1,
    });
  });

  it('returns OPERATION_IN_PROGRESS for a matching physical claim without duplicating effects', async () => {
    const payload = createBody({ phone: '+970 599 556 201' });
    const operationId = payload.operationId as string;
    await adminPool.query(
      `
        insert into sync.processed_operations (
          store_id, operation_id, device_id, aggregate_type, aggregate_id,
          action, request_hash, status
        ) values ($1, $2, $3, 'suppliers', $4, 'create', $5, 'processing')
      `,
      [fixture.stores.a, operationId, fixture.devices.a, payload.id, createRequestHash(payload)],
    );

    const response = body(await post(access.a).send(payload).expect(409));
    expect(response.code).toBe('OPERATION_IN_PROGRESS');
    expect(await readSupplier(payload.id as string)).toBeNull();
    expect(await readOperation(fixture.stores.a, operationId)).toMatchObject({
      status: 'processing',
      completed: false,
    });
  });

  it('rolls back Supplier, trigger, audit, and operation state when completion fails', async () => {
    if (!app) {
      throw new Error('Application is unavailable for fault injection.');
    }
    const repository = app.get<{
      applyOperation: (...arguments_: unknown[]) => Promise<void>;
    }>(SupplierWriteRepository);
    const completion = jest
      .spyOn(repository, 'applyOperation')
      .mockRejectedValueOnce(new Error('Task 6.4 completion fault'));
    const payload = createBody({ phone: '+970 599 556 301' });
    try {
      await post(access.a).send(payload).expect(500);
    } finally {
      completion.mockRestore();
    }

    expect(await readSupplier(payload.id as string)).toBeNull();
    expect(await readOperation(fixture.stores.a, payload.operationId as string)).toBeNull();
    expect(await readSupplierEffects(fixture.stores.a, payload.id as string)).toEqual({
      changeEvents: 0,
      auditLogs: 0,
    });
  });
});
