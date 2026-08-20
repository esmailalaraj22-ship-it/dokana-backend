import { randomUUID } from 'node:crypto';
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
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

const fixture = {
  stores: {
    a: '55040000-0000-4000-8000-000000000001',
    b: '55040000-0000-4000-8000-000000000002',
    readOnly: '55040000-0000-4000-8000-000000000003',
    viewer: '55040000-0000-4000-8000-000000000004',
    flip: '55040000-0000-4000-8000-000000000005',
  },
  users: {
    a: '55140000-0000-4000-8000-000000000001',
    b: '55140000-0000-4000-8000-000000000002',
    readOnly: '55140000-0000-4000-8000-000000000003',
    viewer: '55140000-0000-4000-8000-000000000004',
    flip: '55140000-0000-4000-8000-000000000005',
  },
  memberships: {
    a: '55240000-0000-4000-8000-000000000001',
    b: '55240000-0000-4000-8000-000000000002',
    readOnly: '55240000-0000-4000-8000-000000000003',
    viewer: '55240000-0000-4000-8000-000000000004',
    flip: '55240000-0000-4000-8000-000000000005',
  },
  devices: {
    a: '55340000-0000-4000-8000-000000000001',
    b: '55340000-0000-4000-8000-000000000002',
    readOnly: '55340000-0000-4000-8000-000000000003',
    viewer: '55340000-0000-4000-8000-000000000004',
    flip: '55340000-0000-4000-8000-000000000005',
  },
  emails: {
    a: 'task54-a@example.test',
    b: 'task54-b@example.test',
    readOnly: 'task54-read-only@example.test',
    viewer: 'task54-viewer@example.test',
    flip: 'task54-flip@example.test',
  },
  password: 'Task-5.4-Test-Password!',
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

const storeIdList = Object.values(fixture.stores);
const userIdList = Object.values(fixture.users);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!isRecord(value)) {
    throw new Error('Expected an object response body.');
  }
  return value;
}

interface CreateOverrides {
  id?: string;
  operationId?: string;
  unitId?: string;
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  salePriceMinor?: string | null;
}

function createBody(overrides: CreateOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? randomUUID(),
    operationId: overrides.operationId ?? randomUUID(),
    name: overrides.name ?? 'Olive Oil',
    sku: overrides.sku === undefined ? `SKU-${randomUUID().slice(0, 8)}` : overrides.sku,
    barcode: overrides.barcode === undefined ? null : overrides.barcode,
    measurementType: 'count',
    trackInventory: true,
    lowStockThresholdMilli: '1000',
    initialBaseUnit: {
      id: overrides.unitId ?? randomUUID(),
      unitName: 'Piece',
      salePriceMinor:
        overrides.salePriceMinor === undefined ? '9007199254740993' : overrides.salePriceMinor,
      purchasePriceMinor: null,
    },
  };
}

describe('Product write API with real PostgreSQL', () => {
  let adminPool: Pool;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let poolsInitialized = false;
  const access = {} as AccessMap;

  async function removeFixtures(): Promise<void> {
    await adminPool.query(
      `delete from sync.processed_operations where store_id = any($1::uuid[])`,
      [storeIdList],
    );
    await adminPool.query(`delete from sync.conflicts where store_id = any($1::uuid[])`, [
      storeIdList,
    ]);
    await adminPool.query(`delete from sync.change_events where store_id = any($1::uuid[])`, [
      storeIdList,
    ]);
    await adminPool.query(`delete from audit.central_audit_logs where store_id = any($1::uuid[])`, [
      storeIdList,
    ]);
    await adminPool.query(`delete from ledger.product_units where store_id = any($1::uuid[])`, [
      storeIdList,
    ]);
    await adminPool.query(`delete from ledger.products where store_id = any($1::uuid[])`, [
      storeIdList,
    ]);
    await adminPool.query(
      `delete from platform.refresh_tokens where session_id in (
         select id from platform.auth_sessions where user_id = any($1::uuid[])
       )`,
      [userIdList],
    );
    await adminPool.query(`delete from platform.auth_sessions where user_id = any($1::uuid[])`, [
      userIdList,
    ]);
    await adminPool.query(`delete from ledger.devices where store_id = any($1::uuid[])`, [
      storeIdList,
    ]);
    await adminPool.query(
      `delete from platform.store_memberships where store_id = any($1::uuid[])`,
      [storeIdList],
    );
    await adminPool.query(`delete from platform.users where id = any($1::uuid[])`, [userIdList]);
    await adminPool.query(`delete from ledger.stores where id = any($1::uuid[])`, [storeIdList]);
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
        deviceName: `Task 5.4 ${key} device`,
        devicePlatform: 'android',
      })
      .expect(200);
    const token = body(response).accessToken;
    if (typeof token !== 'string') {
      throw new Error('Login did not return an access token.');
    }
    return { accessToken: token, storeId, userId, deviceId };
  }

  function post(identity: AccessIdentity, path: string) {
    return request(server).post(path).set('authorization', `Bearer ${identity.accessToken}`);
  }
  function patch(identity: AccessIdentity, path: string) {
    return request(server).patch(path).set('authorization', `Bearer ${identity.accessToken}`);
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
      'dokana-task54-admin',
      1,
      '-c session_replication_role=replica -c app.suppress_change_events=on',
    );
    poolsInitialized = true;

    await removeFixtures();
    const passwordHash = await new PasswordService().hash(fixture.password);
    await adminPool.query(
      `
        insert into ledger.stores (id, name, status)
        values
          ($1, 'Task 5.4 Store A', 'active'),
          ($2, 'Task 5.4 Store B', 'active'),
          ($3, 'Task 5.4 Read Only', 'read_only'),
          ($4, 'Task 5.4 Viewer', 'active'),
          ($5, 'Task 5.4 Flip', 'active')
      `,
      storeIdList,
    );
    await adminPool.query(
      `
        insert into platform.users (id, email, normalized_email, password_hash, full_name, status)
        values
          ($1, $2, $2, $11, 'Task 5.4 Owner A', 'active'),
          ($3, $4, $4, $11, 'Task 5.4 Owner B', 'active'),
          ($5, $6, $6, $11, 'Task 5.4 Read Only Owner', 'active'),
          ($7, $8, $8, $11, 'Task 5.4 Viewer', 'active'),
          ($9, $10, $10, $11, 'Task 5.4 Flip Owner', 'active')
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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (poolsInitialized) {
      await removeFixtures();
      await adminPool.end();
    }
  });

  it('enforces authentication, owner authority, and the read-only write gate', async () => {
    await request(server).post('/v1/products').send(createBody()).expect(401);
    const viewer = await post(access.viewer, '/v1/products').send(createBody()).expect(403);
    expect(body(viewer).code).toBe('PRODUCT_WRITE_NOT_ALLOWED');
    const readOnly = await post(access.readOnly, '/v1/products').send(createBody()).expect(403);
    expect(body(readOnly).code).toBe('BUSINESS_WRITE_NOT_ALLOWED');
  });

  it('atomically creates a Product with its base Unit and preserves precision and UUIDs', async () => {
    const productId = randomUUID();
    const unitId = randomUUID();
    const payload = createBody({ id: productId, unitId, salePriceMinor: '9007199254740993' });
    const created = body(await post(access.a, '/v1/products').send(payload).expect(201));

    expect(created.id).toBe(productId);
    expect(created.status).toBe('active');
    expect(created.version).toBe('1');
    expect(created.measurementType).toBe('count');
    expect(Array.isArray(created.units)).toBe(true);
    const units = created.units as Record<string, unknown>[];
    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe(unitId);
    expect(units[0]?.isBase).toBe(true);
    expect(units[0]?.factorNum).toBe(1);
    expect(units[0]?.factorDen).toBe(1);
    expect(units[0]?.salePriceMinor).toBe('9007199254740993');

    const rows = await adminPool.query<{ count: string }>(
      `select count(*)::text as count from ledger.product_units where product_id = $1`,
      [productId],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('replays an identical create operation and rejects operation-id reuse with a different request', async () => {
    const payload = createBody();
    const first = body(await post(access.a, '/v1/products').send(payload).expect(201));
    const replay = body(await post(access.a, '/v1/products').send(payload).expect(201));
    expect(replay).toEqual(first);

    const rows = await adminPool.query<{ count: string }>(
      `select count(*)::text as count from ledger.products where id = $1`,
      [payload.id as string],
    );
    expect(rows.rows[0]?.count).toBe('1');

    const changed = { ...payload, name: 'Different Name' };
    const conflict = body(await post(access.a, '/v1/products').send(changed).expect(409));
    expect(conflict.code).toBe('OPERATION_ID_CONFLICT');
  });

  it('never overwrites an existing Product UUID and rejects duplicate SKU in the same store', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'SHARED-SKU' }))
      .expect(201);

    const collision = body(
      await post(access.a, '/v1/products')
        .send(createBody({ id: productId }))
        .expect(409),
    );
    expect(collision.code).toBe('CONFLICT');

    const duplicateSku = body(
      await post(access.a, '/v1/products')
        .send(createBody({ sku: 'SHARED-SKU' }))
        .expect(409),
    );
    expect(duplicateSku.code).toBe('PRODUCT_SKU_CONFLICT');
  });

  it('updates with optimistic concurrency, canonical no-op, and immutable-field protection', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'EDIT-1' }))
      .expect(201);

    const updated = body(
      await patch(access.a, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', isPinned: true })
        .expect(200),
    );
    expect(updated.version).toBe('2');
    expect(updated.isPinned).toBe(true);

    // Stale expectedVersion.
    const stale = body(
      await patch(access.a, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', isPinned: false })
        .expect(409),
    );
    expect(stale.code).toBe('PRODUCT_VERSION_CONFLICT');

    // Canonical no-op: same value, no version increment.
    const noop = body(
      await patch(access.a, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '2', isPinned: true })
        .expect(200),
    );
    expect(noop.version).toBe('2');

    // Immutable and server-owned fields are rejected by the strict DTO boundary.
    for (const forbidden of [
      { measurementType: 'weight' },
      { trackInventory: false },
      { status: 'archived' },
      { version: '5' },
      { storeId: fixture.stores.b },
      { normalizedName: 'x' },
    ]) {
      await patch(access.a, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '2', ...forbidden })
        .expect(400);
    }
  });

  it('distinguishes omitted from null in Product PATCH semantics', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'PATCH-1' }))
      .expect(201);

    // Clear SKU explicitly with null.
    const cleared = body(
      await patch(access.a, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', sku: null })
        .expect(200),
    );
    expect(cleared.sku).toBeNull();
    expect(cleared.version).toBe('2');

    // Omit SKU on the next update: it stays null, only isPinned changes.
    const kept = body(
      await patch(access.a, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '2', isPinned: true })
        .expect(200),
    );
    expect(kept.sku).toBeNull();
    expect(kept.version).toBe('3');
  });

  it('creates non-base conversion Units, enforces server-controlled base role, and updates prices', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'UNIT-1' }))
      .expect(201);

    const unitId = randomUUID();
    const unit = body(
      await post(access.a, '/v1/products/units')
        .send({
          id: unitId,
          operationId: randomUUID(),
          productId,
          unitName: 'Carton',
          factorNum: 12,
          factorDen: 1,
          salePriceMinor: '0',
        })
        .expect(201),
    );
    expect(unit.id).toBe(unitId);
    expect(unit.isBase).toBe(false);
    expect(unit.factorNum).toBe(12);
    expect(unit.salePriceMinor).toBe('0');
    expect(unit.productId).toBe(productId);

    // A client cannot request a base Unit through the standalone create route.
    await post(access.a, '/v1/products/units')
      .send({
        id: randomUUID(),
        operationId: randomUUID(),
        productId,
        unitName: 'Bad Base',
        isBase: true,
        factorNum: 1,
        factorDen: 1,
      })
      .expect(400);

    // Update the Unit price; version increments once, ratio is untouched.
    const updated = body(
      await patch(access.a, `/v1/products/units/${unitId}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', purchasePriceMinor: '250' })
        .expect(200),
    );
    expect(updated.version).toBe('2');
    expect(updated.purchasePriceMinor).toBe('250');
    expect(updated.factorNum).toBe(12);
  });

  it('does not disclose or mutate a foreign-store Product', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'ISO-1' }))
      .expect(201);

    const foreign = body(
      await patch(access.b, `/v1/products/${productId}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', isPinned: true })
        .expect(404),
    );
    expect(foreign.code).toBe('PRODUCT_NOT_FOUND');

    const foreignUnit = body(
      await post(access.b, '/v1/products/units')
        .send({
          id: randomUUID(),
          operationId: randomUUID(),
          productId,
          unitName: 'Carton',
          factorNum: 2,
          factorDen: 1,
        })
        .expect(404),
    );
    expect(foreignUnit.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('allows a completed exact replay after the store becomes read-only but blocks new writes (P54-D10)', async () => {
    const payload = createBody();
    const created = body(await post(access.flip, '/v1/products').send(payload).expect(201));

    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.flip,
    ]);
    try {
      const replay = body(await post(access.flip, '/v1/products').send(payload).expect(201));
      expect(replay).toEqual(created);

      const blocked = body(await post(access.flip, '/v1/products').send(createBody()).expect(403));
      expect(blocked.code).toBe('BUSINESS_WRITE_NOT_ALLOWED');
    } finally {
      await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
        fixture.stores.flip,
      ]);
    }
  });
});
