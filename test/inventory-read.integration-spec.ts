import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { DatabaseService } from '../src/database/database.service';
import { inventoryMovements, manualInventoryEntries } from '../src/database/schema';
import { InventoryReadRepository } from '../src/inventory/inventory-read.repository';
import { inventoryBaseQuantity } from '../src/inventory/inventory-math';
import type {
  InventoryOperationResponse,
  InventoryStockResponse,
} from '../src/inventory/inventory-read.types';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const identityFixture = (role: string) => ({
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s113-${randomUUID()}@example.test`,
  role,
  token: '',
});
const identities = [
  identityFixture('owner'),
  identityFixture('owner'),
  identityFixture('manager'),
  identityFixture('viewer'),
  identityFixture('support'),
] as const;
const password = randomUUID();
const occurredAt = new Date('2026-01-15T10:00:00Z');
const day = '2026-01-15';
const large = 9007199254740993n;
const periodId = deriveAccountingPeriodId(identities[0].storeId, 2026, 1);

describe('S11.3 authenticated inventory reads on isolated PostgreSQL', () => {
  jest.setTimeout(120000);
  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let readPool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated inventory database is unavailable.');
    return database;
  }

  function get(path: string, identity = identities[0]) {
    return request(server)
      .get(`/v1/inventory/${path}`)
      .set('authorization', `Bearer ${identity.token}`);
  }

  async function product(
    options: {
      tracked?: boolean;
      store?: number;
      num?: number;
      den?: number;
      family?: 'count' | 'length' | 'weight' | 'volume';
      name?: string;
    } = {},
  ) {
    const identity = identities[options.store ?? 0];
    if (!identity) throw new Error('Unknown fixture identity.');
    const result = {
      productId: randomUUID(),
      baseUnitId: randomUUID(),
      unitId: randomUUID(),
      num: options.num ?? 10,
    };
    await db().admin.query(
      `insert into ledger.products(id,store_id,name,normalized_name,track_inventory,measurement_type,operation_id)
      values ($1,$2,'S11.3 fixture','s11.3 fixture',$3,$4,$5)`,
      [
        result.productId,
        identity.storeId,
        options.tracked ?? true,
        options.family ?? 'count',
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units
      (id,store_id,product_id,unit_name,is_base,factor_num,factor_den,measurement_type,operation_id)
      values ($1,$3,$4,'base',true,1,1,$5,$6),($2,$3,$4,$7,false,$8,$10,$5,$9)`,
      [
        result.baseUnitId,
        result.unitId,
        identity.storeId,
        result.productId,
        options.family ?? 'count',
        randomUUID(),
        options.name ?? 'carton',
        result.num,
        randomUUID(),
        options.den ?? 1,
      ],
    );
    return result;
  }

  async function accept(options: { cost?: bigint | null; selected?: bigint; num?: number } = {}) {
    const item = await product({ num: options.num ?? 10 });
    const id = randomUUID(),
      operationId = randomUUID(),
      movementId = randomUUID();
    const selected = options.selected ?? 1000n;
    const quantity = selected * BigInt(item.num);
    const cost = options.cost === undefined ? 100n : options.cost;
    const client = await db().runtime.connect();
    try {
      await client.query('begin');
      await setInventoryContext(
        client,
        identities[0].storeId,
        identities[0].deviceId,
        identities[0].userId,
      );
      await drizzle(client)
        .insert(manualInventoryEntries)
        .values({
          id,
          storeId: identities[0].storeId,
          operationId,
          productId: item.productId,
          productUnitId: item.unitId,
          selectedQuantityMilli: selected,
          baseQuantityMilli: quantity,
          factorNum: item.num,
          factorDen: 1,
          totalPurchaseCostMinor: cost,
          costStatus: cost === null ? 'unknown' : 'known',
          occurredAt,
          businessDate: day,
          postingDate: day,
          accountingPeriodId: periodId,
          movementId,
          transactionGroupId: operationId,
          deviceId: identities[0].deviceId,
        });
      const average = cost === null ? 0n : (cost * 2000n + quantity) / (quantity * 2n);
      await drizzle(client)
        .insert(inventoryMovements)
        .values({
          id: movementId,
          storeId: identities[0].storeId,
          productId: item.productId,
          accountingPeriodId: periodId,
          productUnitId: item.unitId,
          selectedQuantityMilli: selected,
          factorNum: item.num,
          factorDen: 1,
          movementType: 'adjustment_in',
          quantityBeforeMilli: 0n,
          quantityDeltaMilli: quantity,
          quantityAfterMilli: quantity,
          inventoryValueBeforeMinor: 0n,
          valueDeltaMinor: cost ?? 0n,
          inventoryValueAfterMinor: cost ?? 0n,
          averageUnitCostAfterMinor: average,
          costStatus: cost === null ? 'unknown' : 'known',
          costStateBefore: 'known',
          costStateAfter: cost === null ? 'unknown' : 'known',
          hasPendingCostAfter: false,
          referenceType: 'manual_inventory_entry',
          referenceId: id,
          transactionGroupId: operationId,
          occurredAt,
          operationId: randomUUID(),
          deviceId: identities[0].deviceId,
          businessDate: day,
          postingDate: day,
        });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    return { ...item, id, operationId, movementId };
  }

  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment)
      throw new Error('Approved non-production local test environment is required.');
    // Existing fixture creates a new generated database with no business data.
    // It never applies SQL or inserts fixtures in the source development database.
    database = await createInventoryTestDatabase();
    const migration = await db().migration.connect();
    try {
      await verifyMigrationSession(migration);
      await applyMigration(migration, db().file);
    } finally {
      await migration.query('reset role');
      migration.release();
    }
    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (
      !databaseName ||
      !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName) ||
      databaseName === environment.databaseName
    ) {
      throw new Error('Fixture database is not isolated.');
    }
    expect(
      (await db().admin.query('select count(*)::int as count from ledger.stores')).rows[0],
    ).toEqual({ count: 0 });
    const withDatabase = (source: string) => {
      const url = new URL(source);
      url.pathname = `/${databaseName}`;
      return url.toString();
    };
    readPool = createTestPool(
      withDatabase(environment.runtimeUrl),
      'dokana-s113-readonly-runtime',
      2,
      '-c default_transaction_read_only=on',
    );
    authPool = createTestPool(withDatabase(environment.authUrl), 'dokana-s113-auth', 1);
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name) values($1,'S11.3 isolated fixture')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
        values($1,$2,$2,$3,'S11.3 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
        values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }
    const bounds = resolveAccountingPeriodBoundaries(2026, 1);
    await db().admin.query(
      `insert into ledger.accounting_periods
      (id,store_id,period_year,period_month,starts_at,ends_at,operation_id) values($1,$2,2026,1,$3,$4,$5)`,
      [periodId, identities[0].storeId, bounds.startsAt, bounds.endsAt, randomUUID()],
    );
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(readPool)
      .overrideProvider(AUTH_DATABASE_POOL)
      .useValue(authPool)
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useFactory({
        factory: (config: AppConfigService) =>
          createLoggingParams(config, { write: () => undefined }),
        inject: [AppConfigService],
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useLogger(app.get(Logger));
    configureApplication(app, app.get(AppConfigService));
    await app.init();
    server = app.getHttpServer();
    for (const identity of identities) {
      const response = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S11.3 isolated device',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = response.body as { accessToken: unknown };
      if (typeof body.accessToken !== 'string')
        throw new Error('Login did not return an access token.');
      identity.token = body.accessToken;
    }
    await authPool.query('set default_transaction_read_only=on');
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else {
        await readPool?.end();
        await authPool?.end();
      }
      if (database) {
        expect(
          (
            await database.admin.query(`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and state like 'idle in transaction%'`)
          ).rows[0],
        ).toEqual({ count: 0 });
      }
    } finally {
      await database?.close();
    }
  });

  it('uses authenticated owner access and preserves read_only reads', async () => {
    const item = await product();
    await request(server).get(`/v1/inventory/stock/${item.productId}`).expect(401);
    for (const identity of identities.slice(2))
      await get(`stock/${item.productId}`, identity).expect(403);
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      identities[0].storeId,
    ]);
    try {
      await get(`stock/${item.productId}`).expect(200);
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        identities[0].storeId,
      ]);
    }
  });

  it('validates identifiers and rejects query filters rather than accepting tenant input', async () => {
    await get('stock/not-a-uuid').expect(400);
    await get('operations/not-a-uuid').expect(400);
    const item = await product();
    await get(`stock/${item.productId}`).query({ storeId: identities[1].storeId }).expect(400);
    await get(`stock/${item.productId}`).query({ search: 'unused' }).expect(400);
    await get(`stock/${item.productId.toUpperCase()}`).expect(200);
  });

  it.each([true, false])(
    'does not fabricate quantity for absent projection; tracked=%s',
    async (tracked) => {
      const item = await product({ tracked });
      const response = await get(`stock/${item.productId}`).expect(200);
      expect(response.body).toMatchObject({
        productId: item.productId,
        trackingState: tracked ? 'TRACKED' : 'NOT_TRACKED',
        projectionState: tracked ? 'MISSING' : 'NOT_TRACKED',
        stock: null,
      });
      expect(
        (
          await db().admin.query(
            'select count(*)::int as count from ledger.stock_balances where product_id=$1',
            [item.productId],
          )
        ).rows[0],
      ).toEqual({ count: 0 });
    },
  );

  it.each([
    [1000n, 'known', 25n, 'POSITIVE'],
    [0n, 'known', 0n, 'ZERO'],
    [-1000n, 'pending', 0n, 'NEGATIVE'],
    [1000n, 'unknown', 0n, 'POSITIVE'],
    [1000n, 'pending', 0n, 'POSITIVE'],
    [1000n, 'known', 0n, 'POSITIVE'],
  ] as const)(
    'reads exact projection quantity %s and state %s',
    async (quantity, state, value, quantityState) => {
      const item = await product();
      // Projection fixtures are admin-only; production reads cannot write this table.
      await db().admin.query(
        `insert into ledger.stock_balances
      (store_id,product_id,quantity_milli,cost_state,inventory_value_minor,average_unit_cost_minor,has_pending_cost,version)
      values($1,$2,$3,$4,$5,$5,$6,$7)`,
        [
          identities[0].storeId,
          item.productId,
          quantity.toString(),
          state,
          value.toString(),
          state === 'pending',
          large.toString(),
        ],
      );
      const response = await get(`stock/${item.productId}`).expect(200);
      expect(response.body).toMatchObject({
        trackingState: 'TRACKED',
        projectionState: 'PRESENT',
        stock: {
          baseQuantityMilli: quantity.toString(),
          quantityState,
          version: large.toString(),
          cost: {
            status: state,
            valueMinor: state === 'known' ? value.toString() : null,
            averageUnitCostMinor: state === 'known' ? value.toString() : null,
          },
        },
      });
      const body = response.body as InventoryStockResponse;
      expect(body.baseUnit?.id).toBe(item.baseUnitId);
      expect(body.units.find((unit) => unit.id === item.unitId)).toMatchObject({
        factorNum: 10,
        factorDen: 1,
      });
    },
  );

  it('does not expose an existing balance when tracking is explicitly off', async () => {
    const item = await accept();
    await db().admin.query('update ledger.products set track_inventory=false where id=$1', [
      item.productId,
    ]);
    expect((await get(`stock/${item.productId}`).expect(200)).body).toMatchObject({
      trackingState: 'NOT_TRACKED',
      projectionState: 'NOT_TRACKED',
      stock: null,
    });
  });

  it('serializes accepted quantities, total costs and projection versions above Number precision', async () => {
    const item = await accept({ selected: large, num: 1, cost: large });
    const response = await get(`operations/${item.operationId}`).expect(200);
    expect(response.body).toMatchObject({
      selectedQuantityMilli: large.toString(),
      baseQuantityMilli: large.toString(),
      totalPurchaseCostMinor: large.toString(),
      movement: { quantityDeltaMilli: large.toString(), valueDeltaMinor: large.toString() },
    });
    const body = response.body as InventoryOperationResponse;
    for (const value of [
      body.baseQuantityMilli,
      body.selectedQuantityMilli,
      body.totalPurchaseCostMinor,
      body.movement.quantityDeltaMilli,
      body.movement.valueDeltaMinor,
    ]) {
      expect(value).toMatch(/^\d+$/);
    }
    expect((await get(`stock/${item.productId}`).expect(200)).body).toMatchObject({
      stock: {
        baseQuantityMilli: large.toString(),
        cost: { valueMinor: large.toString(), averageUnitCostMinor: '1000' },
      },
    });
  });

  it.each([null, 0n])('preserves historical cost supplied as %s', async (cost) => {
    const item = await accept({ cost });
    expect((await get(`operations/${item.operationId}`).expect(200)).body).toMatchObject({
      costStatus: cost === null ? 'unknown' : 'known',
      totalPurchaseCostMinor: cost === null ? null : '0',
      movement: {
        costAfter: {
          status: cost === null ? 'unknown' : 'known',
          valueMinor: cost === null ? null : '0',
          averageUnitCostMinor: cost === null ? null : '0',
        },
        valueDeltaMinor: cost === null ? null : '0',
      },
    });
  });

  it('derives the read average HALF UP without replacing the accepted total cost', async () => {
    const item = await accept({ cost: 1n, selected: 2000n, num: 1 });
    expect((await get(`stock/${item.productId}`).expect(200)).body).toMatchObject({
      stock: {
        baseQuantityMilli: '2000',
        cost: { status: 'known', valueMinor: '1', averageUnitCostMinor: '1' },
      },
    });
    expect((await get(`operations/${item.operationId}`).expect(200)).body).toMatchObject({
      totalPurchaseCostMinor: '1',
      baseQuantityMilli: '2000',
    });
  });

  it.each([
    ['piece', 'count', 1, 1],
    ['mm', 'length', 1, 1000],
    ['cm', 'length', 1, 100],
    ['m', 'length', 1, 1],
    ['mg', 'weight', 1, 1000],
    ['g', 'weight', 1, 1],
    ['kg', 'weight', 1000, 1],
    ['mL', 'volume', 1, 1000],
    ['L', 'volume', 1, 1],
  ] as const)(
    'retains configurable %s capability in PostgreSQL and API metadata',
    async (name, family, num, den) => {
      const item = await product({ name, family, num, den });
      const body = (await get(`stock/${item.productId}`).expect(200))
        .body as InventoryStockResponse;
      expect(body.units.find((unit) => unit.id === item.unitId)).toMatchObject({
        unitName: name,
        measurementType: family,
        factorNum: num,
        factorDen: den,
      });
      const converted = await db().runtime.query<{ quantity: string }>(
        'select ledger.inventory_base_quantity($1,$2,$3) as quantity',
        ['1000', num, den],
      );
      expect(converted.rows[0]?.quantity).toBe(inventoryBaseQuantity(1000n, num, den).toString());
    },
  );

  it('uses persisted historical unit facts after current labels, factors and status change', async () => {
    const item = await accept();
    const before = (await get(`operations/${item.operationId}`).expect(200))
      .body as InventoryOperationResponse;
    await db().admin.query(
      `update ledger.product_units set factor_num=24,unit_name='changed carton',status='archived' where id=$1`,
      [item.unitId],
    );
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=now() where id=$1`,
      [item.productId],
    );
    const after = (await get(`operations/${item.operationId.toUpperCase()}`).expect(200))
      .body as InventoryOperationResponse;
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      productUnitId: item.unitId,
      factorNum: 10,
      factorDen: 1,
      selectedQuantityMilli: '1000',
      baseQuantityMilli: '10000',
    });
    expect(after).not.toHaveProperty('unitName');
  });

  it('makes cross-store identifiers indistinguishable from absence, with no trusted-header override', async () => {
    const item = await accept();
    for (const [kind, id] of [
      ['stock', item.productId],
      ['operations', item.operationId],
    ] as const) {
      const foreign = await get(`${kind}/${id}`, identities[1])
        .set('x-store-id', identities[0].storeId)
        .expect(404);
      const absent = await get(`${kind}/${randomUUID()}`, identities[1]).expect(404);
      expect(foreign.body).toMatchObject({
        code: (absent.body as { code: string }).code,
        message: (absent.body as { message: string }).message,
      });
    }
  });

  it('uses forced RLS and rejects missing context without pool leakage', async () => {
    if (!app || !readPool) throw new Error('Application is unavailable.');
    const item = await accept();
    const context = { ...identities[0], requestId: randomUUID() };
    const repository = app.get(InventoryReadRepository);
    await expect(
      repository.findStock({ ...context, requestId: '' }, item.productId),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.findOperation({ ...context, storeId: '' }, item.operationId),
    ).rejects.toBeInstanceOf(TypeError);
    await repository.findStock(context, item.productId);
    const direct = await readPool.query(`select
      (select count(*)::int from ledger.manual_inventory_entries) as entries,
      (select count(*)::int from ledger.inventory_movements) as movements,
      (select count(*)::int from ledger.stock_balances) as balances`);
    expect(direct.rows[0]).toEqual({ entries: 0, movements: 0, balances: 0 });
    expect(
      (
        await readPool.query(`select bool_and(relrowsecurity and relforcerowsecurity) as forced from pg_class
      where oid in ('ledger.products'::regclass,'ledger.product_units'::regclass,'ledger.stock_balances'::regclass,'ledger.manual_inventory_entries'::regclass,'ledger.inventory_movements'::regclass)`)
      ).rows[0],
    ).toEqual({ forced: true });
    expect((await app.get(DatabaseService).checkReadiness(5000)).ready).toBe(true);
  });

  it('performs no writes, including events, audit or projection initialization', async () => {
    if (!readPool || !authPool) throw new Error('Read pools are unavailable.');
    const item = await accept();
    const missing = await product();
    async function snapshot() {
      const state: unknown[] = [];
      for (const table of [
        'ledger.products',
        'ledger.product_units',
        'ledger.stock_balances',
        'ledger.manual_inventory_entries',
        'ledger.inventory_movements',
        'sync.processed_operations',
        'sync.change_events',
        'audit.central_audit_logs',
        'platform.auth_sessions',
        'platform.refresh_tokens',
        'ledger.devices',
      ]) {
        state.push(
          (
            await db().admin.query(
              `select md5(coalesce(string_agg(to_jsonb(t)::text, '' order by to_jsonb(t)::text),'')) as hash from ${table} t`,
            )
          ).rows[0],
        );
      }
      return state;
    }
    const before = await snapshot();
    expect((await readPool.query('show transaction_read_only')).rows[0]).toEqual({
      transaction_read_only: 'on',
    });
    expect((await authPool.query('show transaction_read_only')).rows[0]).toEqual({
      transaction_read_only: 'on',
    });
    await get(`stock/${item.productId}`).expect(200);
    await get(`stock/${missing.productId}`).expect(200);
    await get(`operations/${item.operationId}`).expect(200);
    expect(await snapshot()).toEqual(before);
  });
});
