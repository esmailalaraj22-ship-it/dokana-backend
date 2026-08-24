import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const environment = readLocalPostgresTestEnvironment();

jest.setTimeout(30_000);

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
    process.env.DB_POOL_MAX = '8';

    adminPool = createTestPool(
      environment.adminUrl,
      'dokana-task54-admin',
      2,
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

  async function count(table: string, column: string, value: string): Promise<number> {
    const result = await adminPool.query<{ c: string }>(
      `select count(*)::text as c from ${table} where ${column} = $1`,
      [value],
    );
    return Number(result.rows[0]?.c ?? '0');
  }

  async function operationStatus(operationId: string): Promise<string | undefined> {
    const result = await adminPool.query<{ status: string }>(
      `select status from sync.processed_operations where operation_id = $1`,
      [operationId],
    );
    return result.rows[0]?.status;
  }

  async function waitForBlockedOperationRequests(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await adminPool.query<{ count: string }>(
        `select count(*)::text as count
         from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
           and query ilike '%sync.processed_operations%'
           and query not ilike '%pg_stat_activity%'`,
      );
      if (Number(result.rows[0]?.count ?? '0') >= expected) {
        return;
      }
      await adminPool.query(`select pg_sleep(0.01)`);
    }
    throw new Error(
      `Timed out waiting for ${String(expected)} blocked Product operation requests.`,
    );
  }

  async function runBehindOperationBarrier<T>(work: () => Promise<T>): Promise<T> {
    const blocker: PoolClient = await adminPool.connect();
    let transactionOpen = false;
    let pending: Promise<T> | undefined;
    try {
      await blocker.query('begin');
      transactionOpen = true;
      await blocker.query('lock table sync.processed_operations in access exclusive mode');
      pending = work();
      await waitForBlockedOperationRequests(2);
      await blocker.query('commit');
      transactionOpen = false;
      return await pending;
    } catch (error) {
      if (transactionOpen) {
        await blocker.query('rollback');
      }
      if (pending) {
        await Promise.allSettled([pending]);
      }
      throw error;
    } finally {
      blocker.release();
    }
  }

  async function changeEventSequenceValue(): Promise<bigint> {
    const result = await adminPool.query<{ value: string }>(
      `select last_value::text as value from sync.change_events_cursor_seq`,
    );
    const value = result.rows[0]?.value;
    if (!value) {
      throw new Error('The change-event cursor sequence did not return a value.');
    }
    return BigInt(value);
  }

  async function insertAdminProduct(
    id: string,
    status: 'active' | 'archived',
    storeId = fixture.stores.a,
  ): Promise<void> {
    await adminPool.query(
      `insert into ledger.products
        (id, store_id, name, normalized_name, measurement_type, operation_id, status, archived_at)
       values ($1, $2, 'Admin Product', 'admin product', 'count', $3, $4, $5)`,
      [id, storeId, randomUUID(), status, status === 'archived' ? new Date() : null],
    );
  }

  async function insertAdminUnit(
    id: string,
    productId: string,
    isBase: boolean,
    status: 'active' | 'archived',
    storeId = fixture.stores.a,
  ): Promise<void> {
    await adminPool.query(
      `insert into ledger.product_units
        (id, store_id, product_id, measurement_type, unit_name, is_base, factor_num, factor_den,
         operation_id, status)
       values ($1, $2, $3, 'count', $4, $5, $6, 1, $7, $8)`,
      [
        id,
        storeId,
        productId,
        `Unit ${id.slice(0, 8)}`,
        isBase,
        isBase ? 1 : 2,
        randomUUID(),
        status,
      ],
    );
  }

  async function entityEffects(entityId: string): Promise<{ audits: number; changes: number }> {
    return {
      audits: await count('audit.central_audit_logs', 'entity_id', entityId),
      changes: await count('sync.change_events', 'entity_id', entityId),
    };
  }

  async function accountingInventoryEffects(storeId: string): Promise<Record<string, number>> {
    const result = await adminPool.query<{
      inventoryMovements: string;
      moneyMovements: string;
      purchaseItems: string;
      saleItems: string;
      stockBalances: string;
    }>(
      `select
         (select count(*) from ledger.inventory_movements where store_id = $1)::text
           as "inventoryMovements",
         (select count(*) from ledger.stock_balances where store_id = $1)::text
           as "stockBalances",
         (select count(*) from ledger.money_movements where store_id = $1)::text
           as "moneyMovements",
         (select count(*) from ledger.sale_items where store_id = $1)::text as "saleItems",
         (select count(*) from ledger.purchase_items where store_id = $1)::text as "purchaseItems"`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Accounting and inventory effect counts were not returned.');
    }
    return {
      inventoryMovements: Number(row.inventoryMovements),
      stockBalances: Number(row.stockBalances),
      moneyMovements: Number(row.moneyMovements),
      saleItems: Number(row.saleItems),
      purchaseItems: Number(row.purchaseItems),
    };
  }

  async function waitForBlockedProductLocks(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await adminPool.query<{ count: string }>(
        `select count(*)::text as count
         from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
           and query ilike '%products%'
           and query ilike '%for update%'
           and query not ilike '%pg_stat_activity%'`,
      );
      if (Number(result.rows[0]?.count ?? '0') >= expected) {
        return;
      }
      await adminPool.query(`select pg_sleep(0.01)`);
    }
    throw new Error(`Timed out waiting for ${String(expected)} blocked Product row locks.`);
  }

  async function runInProductLockOrder<T, U>(
    productId: string,
    first: () => Promise<T>,
    second: () => Promise<U>,
  ): Promise<[T, U]> {
    const blocker = await adminPool.connect();
    let transactionOpen = false;
    let firstPending: Promise<T> | undefined;
    let secondPending: Promise<U> | undefined;
    try {
      await blocker.query('begin');
      transactionOpen = true;
      await blocker.query(`select id from ledger.products where id = $1 for update`, [productId]);
      firstPending = first();
      await waitForBlockedProductLocks(1);
      secondPending = second();
      await waitForBlockedProductLocks(2);
      await blocker.query('commit');
      transactionOpen = false;
      return await Promise.all([firstPending, secondPending]);
    } catch (error) {
      if (transactionOpen) {
        await blocker.query('rollback');
      }
      await Promise.allSettled(
        [firstPending, secondPending].filter((value) => value !== undefined),
      );
      throw error;
    } finally {
      blocker.release();
    }
  }

  it('serializes concurrent identical create operations into a single business effect', async () => {
    const payload = createBody();
    const baseUnitId = (payload.initialBaseUnit as Record<string, unknown>).id as string;
    const [first, second] = await runBehindOperationBarrier(() =>
      Promise.all([
        post(access.a, '/v1/products').send(payload),
        post(access.a, '/v1/products').send(payload),
      ]),
    );

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(body(first)).toEqual(body(second));
    expect(body(first)).toMatchObject({
      id: payload.id,
      operationId: payload.operationId,
      version: '1',
    });

    expect(await count('ledger.products', 'id', payload.id as string)).toBe(1);
    expect(await count('ledger.product_units', 'product_id', payload.id as string)).toBe(1);
    const ops = await adminPool.query<{ status: string; c: string }>(
      `select status, count(*)::text as c from sync.processed_operations
       where store_id = $1 and operation_id = $2 group by status`,
      [fixture.stores.a, payload.operationId as string],
    );
    expect(ops.rows).toEqual([{ status: 'applied', c: '1' }]);
    expect(await count('sync.change_events', 'entity_id', payload.id as string)).toBe(1);
    expect(await count('audit.central_audit_logs', 'entity_id', payload.id as string)).toBe(1);
    expect(await count('sync.change_events', 'entity_id', baseUnitId)).toBe(1);
    expect(await count('audit.central_audit_logs', 'entity_id', baseUnitId)).toBe(1);
  });

  it('serializes concurrent identical updates without double version increment', async () => {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, unitId: baseUnitId, sku: 'CC-UPD' }))
      .expect(201);

    const productChangesBefore = await count('sync.change_events', 'entity_id', productId);
    const productAuditsBefore = await count('audit.central_audit_logs', 'entity_id', productId);
    const unitChangesBefore = await count('sync.change_events', 'entity_id', baseUnitId);
    const unitAuditsBefore = await count('audit.central_audit_logs', 'entity_id', baseUnitId);
    const update = { operationId: randomUUID(), expectedVersion: '1', isPinned: true };
    const [first, second] = await runBehindOperationBarrier(() =>
      Promise.all([
        patch(access.a, `/v1/products/${productId}`).send(update),
        patch(access.a, `/v1/products/${productId}`).send(update),
      ]),
    );
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(body(first)).toEqual(body(second));
    expect(body(first)).toMatchObject({
      id: productId,
      operationId: update.operationId,
      version: '2',
      isPinned: true,
    });

    const version = await adminPool.query<{ v: string }>(
      `select version::text as v from ledger.products where id = $1`,
      [productId],
    );
    expect(version.rows[0]?.v).toBe('2');
    expect(await count('ledger.products', 'id', productId)).toBe(1);
    expect(await count('ledger.product_units', 'product_id', productId)).toBe(1);
    expect(await count('sync.change_events', 'entity_id', productId)).toBe(
      productChangesBefore + 1,
    );
    expect(await count('audit.central_audit_logs', 'entity_id', productId)).toBe(
      productAuditsBefore + 1,
    );
    expect(await count('sync.change_events', 'entity_id', baseUnitId)).toBe(unitChangesBefore);
    expect(await count('audit.central_audit_logs', 'entity_id', baseUnitId)).toBe(unitAuditsBefore);
    const operations = await adminPool.query<{ status: string; count: string }>(
      `select status, count(*)::text as count
       from sync.processed_operations
       where store_id = $1 and operation_id = $2
       group by status`,
      [fixture.stores.a, update.operationId],
    );
    expect(operations.rows).toEqual([{ status: 'applied', count: '1' }]);
  });

  it('resolves concurrent optimistic updates with exactly one winner', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'CC-OPT' }))
      .expect(201);

    const [first, second] = await Promise.all([
      patch(access.a, `/v1/products/${productId}`).send({
        operationId: randomUUID(),
        expectedVersion: '1',
        isPinned: true,
      }),
      patch(access.a, `/v1/products/${productId}`).send({
        operationId: randomUUID(),
        expectedVersion: '1',
        lowStockThresholdMilli: '5',
      }),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const loser = [first, second].find((response) => response.status === 409);
    expect(body(loser as Response).code).toBe('PRODUCT_VERSION_CONFLICT');

    const version = await adminPool.query<{ v: string }>(
      `select version::text as v from ledger.products where id = $1`,
      [productId],
    );
    expect(version.rows[0]?.v).toBe('2');
  });

  it('replays and reuse-conflicts standalone ProductUnit create and update', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'PU-REPLAY' }))
      .expect(201);

    const unitId = randomUUID();
    const createOp = randomUUID();
    const createRequest = {
      id: unitId,
      operationId: createOp,
      productId,
      unitName: 'Carton',
      factorNum: 12,
      factorDen: 1,
    };
    const created = body(
      await post(access.a, '/v1/products/units').send(createRequest).expect(201),
    );
    const createdReplay = body(
      await post(access.a, '/v1/products/units').send(createRequest).expect(201),
    );
    expect(createdReplay).toEqual(created);
    const createReuse = body(
      await post(access.a, '/v1/products/units')
        .send({ ...createRequest, unitName: 'Different' })
        .expect(409),
    );
    expect(createReuse.code).toBe('OPERATION_ID_CONFLICT');
    expect(await count('ledger.product_units', 'id', unitId)).toBe(1);

    const updateOp = randomUUID();
    const updateRequest = { operationId: updateOp, expectedVersion: '1', salePriceMinor: '500' };
    const updated = body(
      await patch(access.a, `/v1/products/units/${unitId}`).send(updateRequest).expect(200),
    );
    expect(updated.version).toBe('2');
    const updatedReplay = body(
      await patch(access.a, `/v1/products/units/${unitId}`).send(updateRequest).expect(200),
    );
    expect(updatedReplay).toEqual(updated);
    const updateReuse = body(
      await patch(access.a, `/v1/products/units/${unitId}`)
        .send({ ...updateRequest, salePriceMinor: '999' })
        .expect(409),
    );
    expect(updateReuse.code).toBe('OPERATION_ID_CONFLICT');

    const version = await adminPool.query<{ v: string }>(
      `select version::text as v from ledger.product_units where id = $1`,
      [unitId],
    );
    expect(version.rows[0]?.v).toBe('2');
  });

  it('replays a completed operation after the resource later changes', async () => {
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'REPLAY-VER' }))
      .expect(201);

    const originalOp = randomUUID();
    const originalRequest = { operationId: originalOp, expectedVersion: '1', isPinned: true };
    const original = body(
      await patch(access.a, `/v1/products/${productId}`).send(originalRequest).expect(200),
    );
    expect(original.version).toBe('2');

    await patch(access.a, `/v1/products/${productId}`)
      .send({ operationId: randomUUID(), expectedVersion: '2', lowStockThresholdMilli: '9' })
      .expect(200);

    const replay = body(
      await patch(access.a, `/v1/products/${productId}`).send(originalRequest).expect(200),
    );
    expect(replay).toEqual(original);
    expect(replay.version).toBe('2');

    const version = await adminPool.query<{ v: string }>(
      `select version::text as v from ledger.products where id = $1`,
      [productId],
    );
    expect(version.rows[0]?.v).toBe('3');
  });

  it('rejects Rule-A conversion Unit create when no active base structure exists', async () => {
    const productId = randomUUID();
    await insertAdminProduct(productId, 'active');
    await insertAdminUnit(randomUUID(), productId, true, 'archived');

    const unitId = randomUUID();
    const operationId = randomUUID();
    const rejected = body(
      await post(access.a, '/v1/products/units')
        .send({
          id: unitId,
          operationId,
          productId,
          unitName: 'Carton',
          factorNum: 2,
          factorDen: 1,
        })
        .expect(409),
    );
    expect(rejected.code).toBe('PRODUCT_BASE_UNIT_REQUIRED');
    expect(await count('ledger.product_units', 'id', unitId)).toBe(0);
    expect(await operationStatus(operationId)).toBe('rejected');
    expect(await count('sync.change_events', 'entity_id', unitId)).toBe(0);
    expect(await count('audit.central_audit_logs', 'entity_id', unitId)).toBe(0);
  });

  it('serializes concurrent conversion Unit creates on the Product structural lock', async () => {
    // The Product row FOR UPDATE anchor serializes structural mutations. The complementary
    // Base-invalidation half of the Rule-A/Rule-B race (archiving the base concurrently) is a
    // Task-5.5 lifecycle capability and is not implemented in Task 5.4.
    const productId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'RULEA-CC' }))
      .expect(201);

    const [first, second] = await Promise.all([
      post(access.a, '/v1/products/units').send({
        id: randomUUID(),
        operationId: randomUUID(),
        productId,
        unitName: 'Carton',
        factorNum: 12,
        factorDen: 1,
      }),
      post(access.a, '/v1/products/units').send({
        id: randomUUID(),
        operationId: randomUUID(),
        productId,
        unitName: 'Pallet',
        factorNum: 144,
        factorDen: 1,
      }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const nonBase = await adminPool.query<{ c: string }>(
      `select count(*)::text as c from ledger.product_units
       where product_id = $1 and is_base = false`,
      [productId],
    );
    expect(nonBase.rows[0]?.c).toBe('2');
  });

  it('rolls back a Product insert and its triggers after a later base Unit conflict', async () => {
    const fixtureProductId = randomUUID();
    const conflictingBaseUnitId = randomUUID();
    const fixtureOperationId = randomUUID();
    await post(access.a, '/v1/products')
      .send(
        createBody({
          id: fixtureProductId,
          operationId: fixtureOperationId,
          unitId: conflictingBaseUnitId,
          sku: 'ATOMIC-SEED',
        }),
      )
      .expect(201);

    const fixtureUnitBefore = await adminPool.query<{
      productId: string;
      operationId: string;
      status: string;
      version: string;
    }>(
      `select product_id as "productId", operation_id as "operationId", status,
              version::text as version
       from ledger.product_units
       where id = $1`,
      [conflictingBaseUnitId],
    );
    const unitChangesBefore = await count('sync.change_events', 'entity_id', conflictingBaseUnitId);
    const unitAuditsBefore = await count(
      'audit.central_audit_logs',
      'entity_id',
      conflictingBaseUnitId,
    );
    const sequenceBefore = await changeEventSequenceValue();

    const attempted = createBody({
      id: randomUUID(),
      operationId: randomUUID(),
      unitId: conflictingBaseUnitId,
      sku: 'ATOMIC-LATE-UNIT',
    });
    const rejected = body(await post(access.a, '/v1/products').send(attempted).expect(409));
    expect(rejected.code).toBe('CONFLICT');

    // The Product AFTER INSERT change trigger consumes this non-transactional sequence value.
    // Its one-step advance proves the Product INSERT ran before the conflicting Unit INSERT
    // rolled the nested business savepoint and both transactional trigger rows back.
    expect((await changeEventSequenceValue()) - sequenceBefore).toBe(1n);
    expect(await count('ledger.products', 'id', attempted.id as string)).toBe(0);
    expect(await count('ledger.product_units', 'product_id', attempted.id as string)).toBe(0);
    expect(await count('sync.change_events', 'entity_id', attempted.id as string)).toBe(0);
    expect(await count('audit.central_audit_logs', 'entity_id', attempted.id as string)).toBe(0);
    expect(await count('sync.change_events', 'entity_id', conflictingBaseUnitId)).toBe(
      unitChangesBefore,
    );
    expect(await count('audit.central_audit_logs', 'entity_id', conflictingBaseUnitId)).toBe(
      unitAuditsBefore,
    );
    const fixtureUnitAfter = await adminPool.query<{
      productId: string;
      operationId: string;
      status: string;
      version: string;
    }>(
      `select product_id as "productId", operation_id as "operationId", status,
              version::text as version
       from ledger.product_units
       where id = $1`,
      [conflictingBaseUnitId],
    );
    expect(fixtureUnitAfter.rows).toEqual(fixtureUnitBefore.rows);

    const operation = await adminPool.query<{
      status: string;
      responseCode: number;
      errorCode: string;
      count: string;
    }>(
      `select status, response_code as "responseCode", error_code as "errorCode",
              count(*) over ()::text as count
       from sync.processed_operations
       where store_id = $1 and operation_id = $2`,
      [fixture.stores.a, attempted.operationId as string],
    );
    expect(operation.rows).toEqual([
      { status: 'rejected', responseCode: 409, errorCode: 'CONFLICT', count: '1' },
    ]);

    const sequenceBeforeReplay = await changeEventSequenceValue();
    const replay = body(await post(access.a, '/v1/products').send(attempted).expect(409));
    expect(replay).toMatchObject({
      code: rejected.code,
      message: rejected.message,
      path: rejected.path,
      statusCode: rejected.statusCode,
    });
    expect(await changeEventSequenceValue()).toBe(sequenceBeforeReplay);
    expect(await operationStatus(attempted.operationId as string)).toBe('rejected');
  });

  it('rejects a new Unit under an archived same-store parent Product (P54-D11)', async () => {
    const productId = randomUUID();
    await insertAdminProduct(productId, 'archived');
    await insertAdminUnit(randomUUID(), productId, true, 'active');

    const unitId = randomUUID();
    const operationId = randomUUID();
    const rejected = body(
      await post(access.a, '/v1/products/units')
        .send({
          id: unitId,
          operationId,
          productId,
          unitName: 'Carton',
          factorNum: 2,
          factorDen: 1,
        })
        .expect(409),
    );
    expect(rejected.code).toBe('PRODUCT_ARCHIVED');
    expect(await count('ledger.product_units', 'id', unitId)).toBe(0);
    expect(await operationStatus(operationId)).toBe('rejected');
    const stillArchived = await adminPool.query<{ status: string }>(
      `select status from ledger.products where id = $1`,
      [productId],
    );
    expect(stillArchived.rows[0]?.status).toBe('archived');
  });

  it('enforces ProductUnit stale-version, foreign-target, and archived-target contracts', async () => {
    const productId = randomUUID();
    const unitId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, sku: 'PU-STATE' }))
      .expect(201);
    await post(access.a, '/v1/products/units')
      .send({
        id: unitId,
        operationId: randomUUID(),
        productId,
        unitName: 'Carton',
        factorNum: 6,
        factorDen: 1,
      })
      .expect(201);

    // Stale expectedVersion.
    const stale = body(
      await patch(access.a, `/v1/products/units/${unitId}`)
        .send({ operationId: randomUUID(), expectedVersion: '2', salePriceMinor: '1' })
        .expect(409),
    );
    expect(stale.code).toBe('PRODUCT_UNIT_VERSION_CONFLICT');

    // Foreign store target is non-disclosing.
    const foreign = body(
      await patch(access.b, `/v1/products/units/${unitId}`)
        .send({ operationId: randomUUID(), expectedVersion: '1', salePriceMinor: '1' })
        .expect(404),
    );
    expect(foreign.code).toBe('PRODUCT_UNIT_NOT_FOUND');

    // Archived Unit rejects ordinary update without any lifecycle change.
    await adminPool.query(`update ledger.product_units set status = 'archived' where id = $1`, [
      unitId,
    ]);
    try {
      const archived = body(
        await patch(access.a, `/v1/products/units/${unitId}`)
          .send({ operationId: randomUUID(), expectedVersion: '1', salePriceMinor: '1' })
          .expect(409),
      );
      expect(archived.code).toBe('PRODUCT_UNIT_ARCHIVED');
    } finally {
      await adminPool.query(`update ledger.product_units set status = 'active' where id = $1`, [
        unitId,
      ]);
    }
  });

  it('implements Product archive, restore, replay, stale, no-op, and no-cascade semantics', async () => {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, unitId: baseUnitId, sku: 'P55-PRODUCT' }))
      .expect(201);
    const nonLifecycleEffectsBefore = await accountingInventoryEffects(fixture.stores.a);

    const unitBefore = await adminPool.query<{
      status: string;
      updatedAt: Date;
      version: string;
    }>(
      `select status, updated_at as "updatedAt", version::text as version
       from ledger.product_units where id = $1`,
      [baseUnitId],
    );
    const effectsBefore = await entityEffects(productId);
    const archiveRequest = { operationId: randomUUID(), expectedVersion: '1' };
    const archived = body(
      await post(access.a, `/v1/products/${productId}/archive`).send(archiveRequest).expect(200),
    );
    expect(archived).toMatchObject({
      id: productId,
      operationId: archiveRequest.operationId,
      status: 'archived',
      version: '2',
    });
    expect(typeof archived.archivedAt).toBe('string');
    expect(await entityEffects(productId)).toEqual({
      audits: effectsBefore.audits + 1,
      changes: effectsBefore.changes + 1,
    });
    const unitAfterArchive = await adminPool.query<{
      status: string;
      updatedAt: Date;
      version: string;
    }>(
      `select status, updated_at as "updatedAt", version::text as version
       from ledger.product_units where id = $1`,
      [baseUnitId],
    );
    expect(unitAfterArchive.rows).toEqual(unitBefore.rows);

    const replay = body(
      await post(access.a, `/v1/products/${productId}/archive`).send(archiveRequest).expect(200),
    );
    expect(replay).toEqual(archived);

    const rowBeforeNoOp = await adminPool.query<{
      archivedAt: Date;
      updatedAt: Date;
      version: string;
    }>(
      `select archived_at as "archivedAt", updated_at as "updatedAt", version::text as version
       from ledger.products where id = $1`,
      [productId],
    );
    const effectsBeforeNoOp = await entityEffects(productId);
    const noOpId = randomUUID();
    const noOp = body(
      await post(access.a, `/v1/products/${productId}/archive`)
        .send({ operationId: noOpId, expectedVersion: '2' })
        .expect(200),
    );
    expect(noOp).toMatchObject({ status: 'archived', version: '2', operationId: noOpId });
    const rowAfterNoOp = await adminPool.query<{
      archivedAt: Date;
      updatedAt: Date;
      version: string;
    }>(
      `select archived_at as "archivedAt", updated_at as "updatedAt", version::text as version
       from ledger.products where id = $1`,
      [productId],
    );
    expect(rowAfterNoOp.rows).toEqual(rowBeforeNoOp.rows);
    expect(await entityEffects(productId)).toEqual(effectsBeforeNoOp);
    expect(await operationStatus(noOpId)).toBe('applied');

    const staleId = randomUUID();
    const stale = body(
      await post(access.a, `/v1/products/${productId}/archive`)
        .send({ operationId: staleId, expectedVersion: '1' })
        .expect(409),
    );
    expect(stale.code).toBe('PRODUCT_VERSION_CONFLICT');
    expect(await operationStatus(staleId)).toBe('rejected');

    const actionReuse = body(
      await post(access.a, `/v1/products/${productId}/restore`)
        .send({ operationId: archiveRequest.operationId, expectedVersion: '2' })
        .expect(409),
    );
    expect(actionReuse.code).toBe('OPERATION_ID_CONFLICT');

    const restoreRequest = { operationId: randomUUID(), expectedVersion: '2' };
    const restored = body(
      await post(access.a, `/v1/products/${productId}/restore`).send(restoreRequest).expect(200),
    );
    expect(restored).toMatchObject({ status: 'active', version: '3' });
    expect(restored.archivedAt).toBeNull();

    const noUnitProductId = randomUUID();
    await insertAdminProduct(noUnitProductId, 'active');
    await post(access.a, `/v1/products/${noUnitProductId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(200);
    const noUnitRestored = body(
      await post(access.a, `/v1/products/${noUnitProductId}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '2' })
        .expect(200),
    );
    expect(noUnitRestored).toMatchObject({ status: 'active', version: '3', units: [] });
    expect(await accountingInventoryEffects(fixture.stores.a)).toEqual(nonLifecycleEffectsBefore);
  });

  it('implements base Unit lifecycle and enforces archived-parent restore precedence (C1)', async () => {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, unitId: baseUnitId, sku: 'P55-BASE' }))
      .expect(201);

    const archivedBase = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(200),
    );
    expect(archivedBase).toMatchObject({ status: 'archived', version: '2', isBase: true });
    const restoredBase = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '2' })
        .expect(200),
    );
    expect(restoredBase).toMatchObject({ status: 'active', version: '3', isBase: true });

    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(200);

    const activeNoOpRestoreId = randomUUID();
    const activeNoOpRestore = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/restore`)
        .send({ operationId: activeNoOpRestoreId, expectedVersion: '3' })
        .expect(409),
    );
    expect(activeNoOpRestore.code).toBe('CONFLICT');
    expect(await operationStatus(activeNoOpRestoreId)).toBe('rejected');

    const archivedUnderArchivedParent = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '3' })
        .expect(200),
    );
    expect(archivedUnderArchivedParent).toMatchObject({ status: 'archived', version: '4' });
    const blockedRestore = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '4' })
        .expect(409),
    );
    expect(blockedRestore.code).toBe('CONFLICT');

    await post(access.a, `/v1/products/${productId}/restore`)
      .send({ operationId: randomUUID(), expectedVersion: '2' })
      .expect(200);
    const finalRestore = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '4' })
        .expect(200),
    );
    expect(finalRestore).toMatchObject({ status: 'active', version: '5' });
  });

  it('enforces Rule B and Rule A across base and conversion Unit lifecycle transitions', async () => {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    const conversionId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, unitId: baseUnitId, sku: 'P55-RULES' }))
      .expect(201);
    await post(access.a, '/v1/products/units')
      .send({
        id: conversionId,
        operationId: randomUUID(),
        productId,
        unitName: 'Carton',
        factorNum: 12,
        factorDen: 1,
      })
      .expect(201);

    const baseEffects = await entityEffects(baseUnitId);
    const blockedArchiveId = randomUUID();
    const blockedArchive = body(
      await post(access.a, `/v1/products/units/${baseUnitId}/archive`)
        .send({ operationId: blockedArchiveId, expectedVersion: '1' })
        .expect(409),
    );
    expect(blockedArchive.code).toBe('CONFLICT');
    expect(await operationStatus(blockedArchiveId)).toBe('rejected');
    expect(await entityEffects(baseUnitId)).toEqual(baseEffects);

    await post(access.a, `/v1/products/units/${conversionId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(200);
    await post(access.a, `/v1/products/units/${baseUnitId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(200);

    const missingBase = body(
      await post(access.a, `/v1/products/units/${conversionId}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '2' })
        .expect(409),
    );
    expect(missingBase.code).toBe('PRODUCT_BASE_UNIT_REQUIRED');

    await post(access.a, `/v1/products/units/${baseUnitId}/restore`)
      .send({ operationId: randomUUID(), expectedVersion: '2' })
      .expect(200);
    await post(access.a, `/v1/products/units/${conversionId}/restore`)
      .send({ operationId: randomUUID(), expectedVersion: '2' })
      .expect(200);

    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(200);
    const parentBlockedNoOp = body(
      await post(access.a, `/v1/products/units/${conversionId}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '3' })
        .expect(409),
    );
    expect(parentBlockedNoOp.code).toBe('CONFLICT');
    const archivedConversion = body(
      await post(access.a, `/v1/products/units/${conversionId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '3' })
        .expect(200),
    );
    expect(archivedConversion).toMatchObject({ status: 'archived', version: '4' });

    const invalidLegacyProduct = randomUUID();
    const invalidLegacyBase = randomUUID();
    const invalidLegacyConversion = randomUUID();
    await insertAdminProduct(invalidLegacyProduct, 'active');
    await insertAdminUnit(invalidLegacyBase, invalidLegacyProduct, true, 'archived');
    await insertAdminUnit(invalidLegacyConversion, invalidLegacyProduct, false, 'active');
    const structuralNoOp = body(
      await post(access.a, `/v1/products/units/${invalidLegacyConversion}/restore`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(409),
    );
    expect(structuralNoOp.code).toBe('PRODUCT_BASE_UNIT_REQUIRED');
  });

  it('persists ProductUnit semantic no-ops without resource effects and isolates operation identity', async () => {
    const productId = randomUUID();
    const firstUnitId = randomUUID();
    const secondUnitId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, unitId: firstUnitId, sku: 'P55-UNIT-IDEMP' }))
      .expect(201);
    await insertAdminUnit(secondUnitId, productId, true, 'archived');

    const archiveRequest = { operationId: randomUUID(), expectedVersion: '1' };
    const archived = body(
      await post(access.a, `/v1/products/units/${firstUnitId}/archive`)
        .send(archiveRequest)
        .expect(200),
    );
    const replay = body(
      await post(access.a, `/v1/products/units/${firstUnitId}/archive`)
        .send(archiveRequest)
        .expect(200),
    );
    expect(replay).toEqual(archived);

    const rowBeforeNoOp = await adminPool.query<{
      operationId: string;
      updatedAt: Date;
      version: string;
    }>(
      `select operation_id as "operationId", updated_at as "updatedAt", version::text as version
       from ledger.product_units where id = $1`,
      [firstUnitId],
    );
    const effectsBeforeNoOp = await entityEffects(firstUnitId);
    const noOpId = randomUUID();
    const noOp = body(
      await post(access.a, `/v1/products/units/${firstUnitId}/archive`)
        .send({ operationId: noOpId, expectedVersion: '2' })
        .expect(200),
    );
    expect(noOp).toMatchObject({ status: 'archived', version: '2', operationId: noOpId });
    const rowAfterNoOp = await adminPool.query<{
      operationId: string;
      updatedAt: Date;
      version: string;
    }>(
      `select operation_id as "operationId", updated_at as "updatedAt", version::text as version
       from ledger.product_units where id = $1`,
      [firstUnitId],
    );
    expect(rowAfterNoOp.rows).toEqual(rowBeforeNoOp.rows);
    expect(await entityEffects(firstUnitId)).toEqual(effectsBeforeNoOp);
    expect(await operationStatus(noOpId)).toBe('applied');

    const staleNoOp = body(
      await post(access.a, `/v1/products/units/${firstUnitId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(409),
    );
    expect(staleNoOp.code).toBe('PRODUCT_UNIT_VERSION_CONFLICT');

    const changedRequest = body(
      await post(access.a, `/v1/products/units/${firstUnitId}/archive`)
        .send({ operationId: archiveRequest.operationId, expectedVersion: '2' })
        .expect(409),
    );
    expect(changedRequest.code).toBe('OPERATION_ID_CONFLICT');
    const changedAction = body(
      await post(access.a, `/v1/products/units/${firstUnitId}/restore`)
        .send({ operationId: archiveRequest.operationId, expectedVersion: '2' })
        .expect(409),
    );
    expect(changedAction.code).toBe('OPERATION_ID_CONFLICT');
    const changedTarget = body(
      await post(access.a, `/v1/products/units/${secondUnitId}/archive`)
        .send({ operationId: archiveRequest.operationId, expectedVersion: '1' })
        .expect(409),
    );
    expect(changedTarget.code).toBe('OPERATION_ID_CONFLICT');
  });

  it('enforces lifecycle authentication, owner authority, tenant privacy, strict DTOs, and read_only replay', async () => {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    await post(access.a, '/v1/products')
      .send(createBody({ id: productId, unitId: baseUnitId, sku: 'P55-SECURITY' }))
      .expect(201);

    await request(server)
      .post(`/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(401);
    const viewer = body(
      await post(access.viewer, `/v1/products/${productId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(403),
    );
    expect(viewer.code).toBe('PRODUCT_WRITE_NOT_ALLOWED');

    const foreignProduct = body(
      await post(access.b, `/v1/products/${productId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(404),
    );
    expect(foreignProduct.code).toBe('PRODUCT_NOT_FOUND');
    const foreignUnit = body(
      await post(access.b, `/v1/products/units/${baseUnitId}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(404),
    );
    expect(foreignUnit.code).toBe('PRODUCT_UNIT_NOT_FOUND');

    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1', storeId: fixture.stores.b })
      .expect(400);
    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1', status: 'archived' })
      .expect(400);
    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID() })
      .expect(400);
    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ expectedVersion: '1' })
      .expect(400);
    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: 'not-a-uuid', expectedVersion: '1' })
      .expect(400);
    await post(access.a, `/v1/products/${productId}/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '0' })
      .expect(400);
    await post(access.a, `/v1/products/not-a-uuid/archive`)
      .send({ operationId: randomUUID(), expectedVersion: '1' })
      .expect(400);
    await request(server)
      .delete(`/v1/products/${productId}`)
      .set('authorization', `Bearer ${access.a.accessToken}`)
      .expect(404);

    const readOnlyProduct = randomUUID();
    await insertAdminProduct(readOnlyProduct, 'active', fixture.stores.readOnly);
    const readOnly = body(
      await post(access.readOnly, `/v1/products/${readOnlyProduct}/archive`)
        .send({ operationId: randomUUID(), expectedVersion: '1' })
        .expect(403),
    );
    expect(readOnly.code).toBe('BUSINESS_WRITE_NOT_ALLOWED');

    const flipProduct = randomUUID();
    await post(access.flip, '/v1/products')
      .send(createBody({ id: flipProduct, sku: 'P55-READ-ONLY-REPLAY' }))
      .expect(201);
    const archiveRequest = { operationId: randomUUID(), expectedVersion: '1' };
    const first = body(
      await post(access.flip, `/v1/products/${flipProduct}/archive`)
        .send(archiveRequest)
        .expect(200),
    );
    await adminPool.query(`update ledger.stores set status = 'read_only' where id = $1`, [
      fixture.stores.flip,
    ]);
    try {
      const replay = body(
        await post(access.flip, `/v1/products/${flipProduct}/archive`)
          .send(archiveRequest)
          .expect(200),
      );
      expect(replay).toEqual(first);
      const blocked = body(
        await post(access.flip, `/v1/products/${flipProduct}/restore`)
          .send({ operationId: randomUUID(), expectedVersion: '2' })
          .expect(403),
      );
      expect(blocked.code).toBe('BUSINESS_WRITE_NOT_ALLOWED');
    } finally {
      await adminPool.query(`update ledger.stores set status = 'active' where id = $1`, [
        fixture.stores.flip,
      ]);
    }
  });

  it('serializes conversion create versus base archive in both lock orders', async () => {
    const createFirstProduct = randomUUID();
    const createFirstBase = randomUUID();
    await insertAdminProduct(createFirstProduct, 'active');
    await insertAdminUnit(createFirstBase, createFirstProduct, true, 'active');
    const conversionId = randomUUID();
    const [created, blockedArchive] = await runInProductLockOrder(
      createFirstProduct,
      async () =>
        await post(access.a, '/v1/products/units').send({
          id: conversionId,
          operationId: randomUUID(),
          productId: createFirstProduct,
          unitName: 'Create First',
          factorNum: 2,
          factorDen: 1,
        }),
      async () =>
        await post(access.a, `/v1/products/units/${createFirstBase}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
    );
    expect(created.status).toBe(201);
    expect(blockedArchive.status).toBe(409);
    expect(body(blockedArchive).code).toBe('CONFLICT');

    const archiveFirstProduct = randomUUID();
    const archiveFirstBase = randomUUID();
    await insertAdminProduct(archiveFirstProduct, 'active');
    await insertAdminUnit(archiveFirstBase, archiveFirstProduct, true, 'active');
    const blockedConversionId = randomUUID();
    const [archived, blockedCreate] = await runInProductLockOrder(
      archiveFirstProduct,
      async () =>
        await post(access.a, `/v1/products/units/${archiveFirstBase}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
      async () =>
        await post(access.a, '/v1/products/units').send({
          id: blockedConversionId,
          operationId: randomUUID(),
          productId: archiveFirstProduct,
          unitName: 'Archive First',
          factorNum: 2,
          factorDen: 1,
        }),
    );
    expect(archived.status).toBe(200);
    expect(blockedCreate.status).toBe(409);
    expect(body(blockedCreate).code).toBe('PRODUCT_BASE_UNIT_REQUIRED');
    expect(await count('ledger.product_units', 'id', blockedConversionId)).toBe(0);
  });

  it('serializes conversion restore versus base archive in both lock orders', async () => {
    const restoreFirstProduct = randomUUID();
    const restoreFirstBase = randomUUID();
    const restoreFirstConversion = randomUUID();
    await insertAdminProduct(restoreFirstProduct, 'active');
    await insertAdminUnit(restoreFirstBase, restoreFirstProduct, true, 'active');
    await insertAdminUnit(restoreFirstConversion, restoreFirstProduct, false, 'archived');
    const [restored, blockedArchive] = await runInProductLockOrder(
      restoreFirstProduct,
      async () =>
        await post(access.a, `/v1/products/units/${restoreFirstConversion}/restore`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
      async () =>
        await post(access.a, `/v1/products/units/${restoreFirstBase}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
    );
    expect(restored.status).toBe(200);
    expect(blockedArchive.status).toBe(409);
    expect(body(blockedArchive).code).toBe('CONFLICT');

    const archiveFirstProduct = randomUUID();
    const archiveFirstBase = randomUUID();
    const archiveFirstConversion = randomUUID();
    await insertAdminProduct(archiveFirstProduct, 'active');
    await insertAdminUnit(archiveFirstBase, archiveFirstProduct, true, 'active');
    await insertAdminUnit(archiveFirstConversion, archiveFirstProduct, false, 'archived');
    const [archived, blockedRestore] = await runInProductLockOrder(
      archiveFirstProduct,
      async () =>
        await post(access.a, `/v1/products/units/${archiveFirstBase}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
      async () =>
        await post(access.a, `/v1/products/units/${archiveFirstConversion}/restore`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
    );
    expect(archived.status).toBe(200);
    expect(blockedRestore.status).toBe(409);
    expect(body(blockedRestore).code).toBe('PRODUCT_BASE_UNIT_REQUIRED');
  });

  it('serializes competing base restores and preserves one active base', async () => {
    for (const reverse of [false, true]) {
      const productId = randomUUID();
      const firstBase = randomUUID();
      const secondBase = randomUUID();
      await insertAdminProduct(productId, 'active');
      await insertAdminUnit(firstBase, productId, true, 'archived');
      await insertAdminUnit(secondBase, productId, true, 'archived');
      const firstTarget = reverse ? secondBase : firstBase;
      const secondTarget = reverse ? firstBase : secondBase;
      const [winner, loser] = await runInProductLockOrder(
        productId,
        async () =>
          await post(access.a, `/v1/products/units/${firstTarget}/restore`).send({
            operationId: randomUUID(),
            expectedVersion: '1',
          }),
        async () =>
          await post(access.a, `/v1/products/units/${secondTarget}/restore`).send({
            operationId: randomUUID(),
            expectedVersion: '1',
          }),
      );
      expect(winner.status).toBe(200);
      expect(loser.status).toBe(409);
      expect(body(loser).code).toBe('CONFLICT');
      const activeBases = await adminPool.query<{ count: string }>(
        `select count(*)::text as count from ledger.product_units
         where product_id = $1 and is_base = true and status = 'active'`,
        [productId],
      );
      expect(activeBases.rows[0]?.count).toBe('1');
    }
  });

  it('serializes Product archive versus Unit restore in both lock orders', async () => {
    const restoreFirstProduct = randomUUID();
    const restoreFirstBase = randomUUID();
    const restoreFirstConversion = randomUUID();
    await insertAdminProduct(restoreFirstProduct, 'active');
    await insertAdminUnit(restoreFirstBase, restoreFirstProduct, true, 'active');
    await insertAdminUnit(restoreFirstConversion, restoreFirstProduct, false, 'archived');
    const [restored, archived] = await runInProductLockOrder(
      restoreFirstProduct,
      async () =>
        await post(access.a, `/v1/products/units/${restoreFirstConversion}/restore`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
      async () =>
        await post(access.a, `/v1/products/${restoreFirstProduct}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
    );
    expect(restored.status).toBe(200);
    expect(archived.status).toBe(200);
    const restoreFirstState = await adminPool.query<{ product: string; unit: string }>(
      `select p.status as product, u.status as unit
       from ledger.products p join ledger.product_units u on u.product_id = p.id
       where p.id = $1 and u.id = $2`,
      [restoreFirstProduct, restoreFirstConversion],
    );
    expect(restoreFirstState.rows).toEqual([{ product: 'archived', unit: 'active' }]);

    const archiveFirstProduct = randomUUID();
    const archiveFirstBase = randomUUID();
    const archiveFirstConversion = randomUUID();
    await insertAdminProduct(archiveFirstProduct, 'active');
    await insertAdminUnit(archiveFirstBase, archiveFirstProduct, true, 'active');
    await insertAdminUnit(archiveFirstConversion, archiveFirstProduct, false, 'archived');
    const [productArchived, restoreBlocked] = await runInProductLockOrder(
      archiveFirstProduct,
      async () =>
        await post(access.a, `/v1/products/${archiveFirstProduct}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
      async () =>
        await post(access.a, `/v1/products/units/${archiveFirstConversion}/restore`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
    );
    expect(productArchived.status).toBe(200);
    expect(restoreBlocked.status).toBe(409);
    expect(body(restoreBlocked).code).toBe('CONFLICT');
  });

  it('serializes same-operation replay and distinct same-version lifecycle operations exactly', async () => {
    const replayProduct = randomUUID();
    await insertAdminProduct(replayProduct, 'active');
    const requestBody = { operationId: randomUUID(), expectedVersion: '1' };
    const effectsBefore = await entityEffects(replayProduct);
    const [first, second] = await runBehindOperationBarrier(() =>
      Promise.all([
        post(access.a, `/v1/products/${replayProduct}/archive`).send(requestBody),
        post(access.a, `/v1/products/${replayProduct}/archive`).send(requestBody),
      ]),
    );
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(body(first)).toEqual(body(second));
    expect(await entityEffects(replayProduct)).toEqual({
      audits: effectsBefore.audits + 1,
      changes: effectsBefore.changes + 1,
    });
    expect(await operationStatus(requestBody.operationId)).toBe('applied');

    const competingProduct = randomUUID();
    await insertAdminProduct(competingProduct, 'active');
    const [winner, staleLoser] = await runInProductLockOrder(
      competingProduct,
      async () =>
        await post(access.a, `/v1/products/${competingProduct}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
      async () =>
        await post(access.a, `/v1/products/${competingProduct}/archive`).send({
          operationId: randomUUID(),
          expectedVersion: '1',
        }),
    );
    expect(winner.status).toBe(200);
    expect(staleLoser.status).toBe(409);
    expect(body(staleLoser).code).toBe('PRODUCT_VERSION_CONFLICT');
    const finalVersion = await adminPool.query<{ version: string }>(
      `select version::text as version from ledger.products where id = $1`,
      [competingProduct],
    );
    expect(finalVersion.rows[0]?.version).toBe('2');
  });

  it('leaves no test-created idle-in-transaction PostgreSQL session', async () => {
    const result = await adminPool.query<{ count: string }>(
      `select count(*)::text as count
       from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and state = 'idle in transaction'
         and application_name like 'dokana-task54-%'`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });
});
