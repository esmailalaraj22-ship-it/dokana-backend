import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import { DatabaseService } from '../src/database/database.service';
import { InventoryPostingRepository } from '../src/inventory/inventory-posting.repository';
import { parseInventoryPostingCommand } from '../src/inventory/inventory-posting-command';
import type { InventoryPostingResponse } from '../src/inventory/inventory-posting-response';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const identities = ['owner', 'owner', 'manager', 'viewer', 'support'].map((role) => ({
  role,
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s114-${randomUUID()}@example.test`,
  token: '',
}));
const owner = identities[0];
if (!owner) throw new Error('Missing test owner.');
const principal = owner;
const instant = '2026-01-15T10:00:00Z';

describe('S11.4 manual inventory posting on isolated real PostgreSQL', () => {
  jest.setTimeout(120000);
  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  function db() {
    if (!database) throw new Error('Isolated DB unavailable.');
    return database;
  }
  function post(kind: string, body: unknown, identity = principal) {
    return request(server)
      .post(`/v1/inventory/${kind}`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body as object);
  }
  function input(
    p: { productId: string; unitId: string },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      operationId: randomUUID(),
      productId: p.productId,
      productUnitId: p.unitId,
      selectedQuantityMilli: '1000',
      occurredAt: instant,
      ...overrides,
    };
  }
  async function product(
    options: {
      storeId?: string;
      tracked?: boolean;
      num?: number;
      den?: number;
      family?: string;
      negative?: boolean;
    } = {},
  ) {
    const p = { productId: randomUUID(), unitId: randomUUID() };
    const storeId = options.storeId ?? principal.storeId;
    await db().admin.query(
      `insert into ledger.products(id,store_id,name,normalized_name,track_inventory,measurement_type,allow_negative_stock_override,operation_id)
      values($1,$2,'S11.4 fixture','s11.4 fixture',$3,$4,$5,$6)`,
      [
        p.productId,
        storeId,
        options.tracked ?? true,
        options.family ?? 'count',
        options.negative ?? null,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(id,store_id,product_id,unit_name,is_base,factor_num,factor_den,measurement_type,purchase_price_minor,operation_id)
      values($1,$2,$3,'configured',false,$4,$5,$6,777,$7)`,
      [
        p.unitId,
        storeId,
        p.productId,
        options.num ?? 1,
        options.den ?? 1,
        options.family ?? 'count',
        randomUUID(),
      ],
    );
    return p;
  }
  async function facts(productId: string) {
    return (
      await db().admin.query(
        `select
      (select count(*)::int from ledger.manual_inventory_entries where product_id=$1) as entries,
      (select count(*)::int from ledger.inventory_movements where product_id=$1) as movements,
      (select count(*)::int from ledger.stock_balances where product_id=$1) as balances`,
        [productId],
      )
    ).rows[0] as { entries: number; movements: number; balances: number };
  }
  async function stock(productId: string) {
    return (
      await db().admin.query(
        `select quantity_milli::text as qty,inventory_value_minor::text as value,cost_state as state,version::text as version from ledger.stock_balances where product_id=$1`,
        [productId],
      )
    ).rows[0] as { qty: string; value: string; state: string; version: string } | undefined;
  }
  async function operation(operationId: string) {
    return (
      await db().admin.query(
        'select status from sync.processed_operations where store_id=$1 and operation_id=$2',
        [principal.storeId, operationId],
      )
    ).rows[0] as { status: string } | undefined;
  }
  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment) throw new Error('Approved non-production local test environment required.');
    database = await createInventoryTestDatabase();
    const migration = await db().migration.connect();
    try {
      await verifyMigrationSession(migration);
      await applyMigration(migration, db().file);
    } finally {
      await migration.query('reset role');
      migration.release();
    }
    const name = (await db().admin.query<{ name: string }>('select current_database() as name'))
      .rows[0]?.name;
    if (!name || !/^dokana_s112_[0-9a-f]{32}$/.test(name) || name === environment.databaseName)
      throw new Error('Test DB is not isolated.');
    expect(
      (await db().admin.query('select count(*)::int as count from ledger.stores')).rows[0],
    ).toEqual({ count: 0 });
    const url = (source: string) => {
      const u = new URL(source);
      u.pathname = `/${name}`;
      return u.toString();
    };
    runtimePool = createTestPool(url(environment.runtimeUrl), 'dokana-s114-runtime', 4);
    authPool = createTestPool(url(environment.authUrl), 'dokana-s114-auth', 2);
    const password = randomUUID(),
      hash = await new PasswordService().hash(password);
    for (const id of identities) {
      await db().admin.query(`insert into ledger.stores(id,name) values($1,'S11.4 fixture')`, [
        id.storeId,
      ]);
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name) values($1,$2,$2,$3,'fixture')`,
        [id.userId, id.email, hash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status) values($1,$2,$3,$4,'active')`,
        [randomUUID(), id.storeId, id.userId, id.role],
      );
    }
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(runtimePool)
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
    for (const id of identities) {
      const result = await request(server)
        .post('/v1/auth/login')
        .send({
          email: id.email,
          password,
          storeId: id.storeId,
          deviceId: id.deviceId,
          deviceName: 'S11.4 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = result.body as { accessToken: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('Login token missing.');
      id.token = body.accessToken;
    }
  });
  afterAll(async () => {
    try {
      if (app) await app.close();
      else {
        await runtimePool?.end();
        await authPool?.end();
      }
      if (database)
        expect(
          (
            await database.admin.query(
              `select count(*)::int as count from pg_stat_activity where datname=current_database() and state like 'idle in transaction%'`,
            )
          ).rows[0],
        ).toEqual({ count: 0 });
    } finally {
      await database?.close();
    }
  });

  it('posts an opening, captures immutable accepted facts, and replays exactly without duplicate effects', async () => {
    const p = await product(),
      body = input(p, { totalPurchaseCostMinor: '10' });
    const a = await post('opening', body).expect(201);
    expect(a.body).toMatchObject({
      kind: 'opening',
      quantityDeltaMilli: '1000',
      costStatus: 'known',
      stock: {
        baseQuantityMilli: '1000',
        cost: { status: 'known', valueMinor: '10', averageUnitCostMinor: '10' },
      },
    });
    const b = await post('opening', body).expect(201);
    expect(b.body).toEqual(a.body);
    expect(await facts(p.productId)).toEqual({ entries: 1, movements: 1, balances: 1 });
    expect(await operation(body.operationId)).toEqual({ status: 'applied' });
    const r = a.body as InventoryPostingResponse;
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from audit.central_audit_logs where entity_id in ($1,$2)`,
          [r.entryId, r.movementId],
        )
      ).rows[0],
    ).toEqual({ count: 2 });
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from sync.change_events where entity_id in ($1,$2)`,
          [r.entryId, r.movementId],
        )
      ).rows[0],
    ).toEqual({ count: 2 });
    const history = await request(server)
      .get(`/v1/inventory/operations/${body.operationId}`)
      .set('authorization', `Bearer ${principal.token}`)
      .expect(200);
    expect(history.body).toMatchObject({
      id: r.entryId,
      totalPurchaseCostMinor: '10',
      movement: { id: r.movementId, quantityAfterMilli: '1000' },
    });
  });
  it('serializes two distinct openings and rejects the loser without partial effects', async () => {
    const p = await product(),
      a = input(p),
      b = input(p);
    const results = await Promise.all([post('opening', a), post('opening', b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      code: 'INVENTORY_OPENING_ALREADY_EXISTS',
    });
    expect(await facts(p.productId)).toEqual({ entries: 1, movements: 1, balances: 1 });
  });
  it('rejects Opening Stock once any manual inventory history has established stock', async () => {
    for (const firstKind of ['increase', 'decrease'] as const) {
      const p = await product({ negative: firstKind === 'decrease' });
      await post(
        firstKind,
        input(p, firstKind === 'decrease' ? { reason: 'initial manual decrease' } : {}),
      ).expect(201);
      await post('opening', input(p)).expect(409);
      expect(await facts(p.productId)).toEqual({ entries: 1, movements: 1, balances: 1 });
    }
  });
  it('serializes duplicate operation IDs into one accepted fact and exact response', async () => {
    const p = await product(),
      body = input(p);
    const results = await Promise.all([post('increase', body), post('increase', body)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body).toEqual(results[1].body);
    expect(await facts(p.productId)).toEqual({ entries: 1, movements: 1, balances: 1 });
  });
  it.each([
    ['count', 10, 1, '10000'],
    ['count', 24, 1, '24000'],
    ['weight', 1000, 1, '1000000'],
    ['length', 1, 1000, '1'],
    ['volume', 1000, 1, '1000000'],
  ] as const)('posts configured %s unit %s/%s', async (family, num, den, qty) => {
    const p = await product({ family, num, den });
    await post('increase', input(p)).expect(201);
    expect((await stock(p.productId))?.qty).toBe(qty);
  });
  it.each([undefined, '0', '15'])(
    'preserves optional purchase cost %s rather than catalog price',
    async (cost) => {
      const p = await product();
      const body = input(p, cost === undefined ? {} : { totalPurchaseCostMinor: cost });
      const r = await post('increase', body).expect(201);
      expect(r.body).toMatchObject({
        costStatus: cost === undefined ? 'unknown' : 'known',
        stock: {
          cost: { status: cost === undefined ? 'unknown' : 'known', valueMinor: cost ?? null },
        },
      });
    },
  );
  it('decreases using aggregate cost and depletes all residual value exactly', async () => {
    const p = await product();
    await post(
      'increase',
      input(p, { selectedQuantityMilli: '3000', totalPurchaseCostMinor: '10' }),
    ).expect(201);
    await post('decrease', input(p, { reason: 'damaged' })).expect(201);
    expect(await stock(p.productId)).toMatchObject({ qty: '2000', value: '7' });
    await post('decrease', input(p, { selectedQuantityMilli: '2000', reason: 'loss' })).expect(201);
    expect(await stock(p.productId)).toMatchObject({ qty: '0', value: '0', state: 'known' });
  });
  it('does not resolve earlier unknown stock with later known input', async () => {
    const p = await product();
    await post('increase', input(p)).expect(201);
    await post('increase', input(p, { totalPurchaseCostMinor: '10' })).expect(201);
    expect(await stock(p.productId)).toMatchObject({ qty: '2000', value: '0', state: 'unknown' });
    const r = await post('decrease', input(p, { reason: 'loss' })).expect(201);
    expect(r.body).toMatchObject({
      costStatus: 'unknown',
      stock: { cost: { status: 'unknown', valueMinor: null } },
    });
  });
  it('allows configured negative stock, keeps pending valuation when crossing back positive', async () => {
    const p = await product({ negative: true });
    const outbound = await post('decrease', input(p, { reason: 'physical adjustment' })).expect(
      201,
    );
    expect(outbound.body).toMatchObject({ costStatus: 'pending' });
    expect(await stock(p.productId)).toMatchObject({ qty: '-1000', state: 'pending', value: '0' });
    const r = await post(
      'increase',
      input(p, { selectedQuantityMilli: '2000', totalPurchaseCostMinor: '8' }),
    ).expect(201);
    expect(r.body).toMatchObject({
      costStatus: 'known',
      stock: { baseQuantityMilli: '1000', cost: { status: 'pending', valueMinor: null } },
    });
  });
  it('rejects forbidden negative stock and leaves no projection or partial business effect', async () => {
    const p = await product({ negative: false }),
      body = input(p, { reason: 'loss' });
    await post('decrease', body).expect(409);
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
    expect(await operation(body.operationId)).toEqual({ status: 'rejected' });
  });
  it('uses Product negative-stock override before the Store policy', async () => {
    await db().admin.query(
      `insert into ledger.app_settings(store_id,allow_negative_stock) values($1,true)`,
      [principal.storeId],
    );
    try {
      const inherited = await product(),
        forbidden = await product({ negative: false });
      await post('decrease', input(inherited, { reason: 'loss' })).expect(201);
      await post('decrease', input(forbidden, { reason: 'loss' })).expect(409);
      expect((await stock(inherited.productId))?.qty).toBe('-1000');
      expect(await facts(forbidden.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
    } finally {
      await db().admin.query('delete from ledger.app_settings where store_id=$1', [
        principal.storeId,
      ]);
    }
  });
  it('preserves known zero on a positive decrease and permits a fresh addition after depletion', async () => {
    const p = await product();
    await post(
      'opening',
      input(p, { totalPurchaseCostMinor: '0', selectedQuantityMilli: '2000' }),
    ).expect(201);
    const decrease = await post('decrease', input(p, { reason: 'loss' })).expect(201);
    expect(decrease.body).toMatchObject({
      costStatus: 'known',
      stock: { cost: { status: 'known', valueMinor: '0' } },
    });
    await post('decrease', input(p, { reason: 'loss' })).expect(201);
    await post('increase', input(p, { totalPurchaseCostMinor: '5' })).expect(201);
    expect(await stock(p.productId)).toMatchObject({ qty: '1000', value: '5', state: 'known' });
    await post('opening', input(p)).expect(409);
  });
  it.each([
    { totalPurchaseCostMinor: '1.1' },
    { totalPurchaseCostMinor: null },
    { reason: '\0' },
    { occurredAt: '2019-01-15T10:00:00Z' },
    { occurredAt: '0001-01-01T10:00:00Z' },
    { supplierInvoiceId: randomUUID() },
  ])('rejects malformed or forbidden fields %j without claiming', async (override) => {
    const p = await product(),
      body = input(p, override);
    await post('increase', body).expect(400);
    expect(await operation(body.operationId)).toBeUndefined();
  });
  it('rejects nonempty query parameters on a write', async () => {
    const p = await product();
    await post('increase', input(p)).query({ storeId: randomUUID() }).expect(400);
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
  });
  it.each(['opening', 'increase', 'decrease'])(
    'rejects %s on NOT_TRACKED without changing tracking or creating stock',
    async (kind) => {
      const p = await product({ tracked: false }),
        body = input(p, kind === 'decrease' ? { reason: 'loss' } : {});
      await post(kind, body).expect(409);
      expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
      expect(await operation(body.operationId)).toEqual({ status: 'rejected' });
      expect(
        (
          await db().admin.query('select track_inventory from ledger.products where id=$1', [
            p.productId,
          ])
        ).rows[0],
      ).toEqual({ track_inventory: false });
    },
  );
  it.each(['product', 'unit'])('rejects inactive %s', async (which) => {
    const p = await product();
    if (which === 'product')
      await db().admin.query(
        `update ledger.products set status='archived',archived_at=now() where id=$1`,
        [p.productId],
      );
    else
      await db().admin.query(`update ledger.product_units set status='archived' where id=$1`, [
        p.unitId,
      ]);
    await post('increase', input(p)).expect(409);
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
  });
  it('rejects wrong and foreign units and hides foreign Product existence', async () => {
    const other = identities[1];
    if (!other) throw new Error('Foreign fixture missing.');
    const p = await product(),
      q = await product(),
      foreign = await product({ storeId: other.storeId });
    for (const unitId of [q.unitId, foreign.unitId])
      await post('increase', input(p, { productUnitId: unitId })).expect(404);
    const hidden = await post('increase', input(foreign)).expect(404);
    const absent = await post(
      'increase',
      input({ productId: randomUUID(), unitId: randomUUID() }),
    ).expect(404);
    expect(hidden.body).toMatchObject({ code: (absent.body as { code: string }).code });
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
    expect(await facts(foreign.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
  });
  it('requires authenticated owner and ignores forged tenant headers', async () => {
    const p = await product(),
      body = input(p);
    await request(server).post('/v1/inventory/increase').send(body).expect(401);
    for (const actor of identities.slice(2)) await post('increase', body, actor).expect(403);
    const r = await post('increase', body).set('x-store-id', randomUUID()).expect(201);
    expect(r.body).toMatchObject({ productId: p.productId });
  });
  it.each(['0', '-1', '-9223372036854775808', '9223372036854775808', '1.1'])(
    'rejects invalid magnitude %s',
    async (q) => {
      const p = await product(),
        body = input(p, { selectedQuantityMilli: q });
      await post('increase', body).expect(400);
      expect(await operation(body.operationId)).toBeUndefined();
    },
  );
  it.each([
    [1, 3, '1'],
    [2, 1, '9223372036854775807'],
  ] as const)('rejects non-exact or overflowing conversion %s/%s', async (num, den, q) => {
    const p = await product({ num, den });
    await post('increase', input(p, { selectedQuantityMilli: q })).expect(400);
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
  });
  it('preserves int8 magnitude above JavaScript safe integer', async () => {
    const p = await product();
    const r = await post(
      'increase',
      input(p, {
        selectedQuantityMilli: '9007199254740993',
        totalPurchaseCostMinor: '9007199254740993',
      }),
    ).expect(201);
    expect(r.body).toMatchObject({
      baseQuantityMilli: '9007199254740993',
      stock: { baseQuantityMilli: '9007199254740993', cost: { valueMinor: '9007199254740993' } },
    });
  });
  it('rejects changed payload/cost presence/command type and persists conflict without duplicate stock', async () => {
    const p = await product(),
      body = input(p);
    await post('increase', body).expect(201);
    for (const change of [
      { totalPurchaseCostMinor: '0' },
      { selectedQuantityMilli: '2000' },
      { reason: 'different' },
    ])
      await post('increase', { ...body, ...change }).expect(409);
    await post('opening', body).expect(409);
    expect(await facts(p.productId)).toEqual({ entries: 1, movements: 1, balances: 1 });
    expect(
      (
        await db().admin.query(
          'select count(*)::int as count from sync.conflicts where operation_id=$1',
          [body.operationId],
        )
      ).rows[0],
    ).toEqual({ count: 4 });
  });
  it('replays completed success despite later unit/product/tracking/read_only changes; blocks new writes', async () => {
    const p = await product(),
      body = input(p);
    const a = await post('increase', body).expect(201);
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=now(),track_inventory=false where id=$1`,
      [p.productId],
    );
    await db().admin.query(
      `update ledger.product_units set status='archived',factor_num=24 where id=$1`,
      [p.unitId],
    );
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      principal.storeId,
    ]);
    try {
      const b = await post('increase', body).expect(201);
      expect(b.body).toEqual(a.body);
      await post('increase', input(p)).expect(403);
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        principal.storeId,
      ]);
    }
  });
  it('rejects new closed-period posting but replays completed success exactly', async () => {
    const p = await product(),
      body = input(p, { occurredAt: '2026-02-15T10:00:00Z' });
    const a = await post('increase', body).expect(201);
    const posted = a.body as InventoryPostingResponse;
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=now() where id=$1`,
      [posted.accountingPeriodId],
    );
    const b = await post('increase', body).expect(201);
    expect(b.body).toEqual(a.body);
    const next = input(p, { occurredAt: body.occurredAt });
    await post('increase', next).expect(409);
    expect(await facts(p.productId)).toEqual({ entries: 1, movements: 1, balances: 1 });
  });
  it('keeps known rejection deterministic even after eligibility changes', async () => {
    const p = await product({ tracked: false }),
      body = input(p);
    const a = await post('increase', body).expect(409);
    await db().admin.query('update ledger.products set track_inventory=true where id=$1', [
      p.productId,
    ]);
    const b = await post('increase', body).expect(409);
    expect(b.body).toMatchObject({ code: (a.body as { code: string }).code });
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
  });
  it('serializes concurrent additions without stale quantity or value loss', async () => {
    const p = await product();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => post('increase', input(p, { totalPurchaseCostMinor: '3' }))),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await stock(p.productId)).toMatchObject({ qty: '4000', value: '12', state: 'known' });
    expect(await facts(p.productId)).toEqual({ entries: 4, movements: 4, balances: 1 });
  });
  it('fails closed without context and denies direct runtime projection/history DML', async () => {
    if (!app) throw new Error('App missing.');
    const p = await product();
    await expect(
      app.get(InventoryPostingRepository).post(
        {
          storeId: '',
          userId: principal.userId,
          deviceId: principal.deviceId,
          requestId: randomUUID(),
        },
        parseInventoryPostingCommand('increase', input(p)),
        '2026-01-15',
      ),
    ).rejects.toThrow(TypeError);
    const c = await db().runtime.connect();
    try {
      for (const table of ['stock_balances', 'manual_inventory_entries', 'inventory_movements']) {
        await c.query('begin');
        await setInventoryContext(c, principal.storeId, principal.deviceId, principal.userId);
        await expect(c.query(`delete from ledger.${table}`)).rejects.toMatchObject({
          code: '42501',
        });
        await c.query('rollback');
      }
      expect(
        (await c.query(`select count(*)::int as count from ledger.stock_balances`)).rows[0],
      ).toEqual({ count: 0 });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('rolls back all effects and the claim after a controlled post-insert failure', async () => {
    if (!app) throw new Error('App missing.');
    const p = await product(),
      body = input(p);
    const service = app.get(DatabaseService);
    const evidence = async () =>
      (
        await db().admin.query(`select
      (select count(*)::int from audit.central_audit_logs) as audit,
      (select count(*)::int from sync.change_events) as changes`)
      ).rows[0] as { audit: number; changes: number };
    const beforeEvidence = await evidence();
    const original = service.withTenantTransaction.bind(service);
    const spy = jest.spyOn(service, 'withTenantTransaction').mockImplementation((ctx, work) =>
      original(ctx, async (tx) => {
        await work(tx);
        throw new Error('S11.4 controlled rollback');
      }),
    );
    try {
      await post('increase', body).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await facts(p.productId)).toEqual({ entries: 0, movements: 0, balances: 0 });
    expect(await operation(body.operationId)).toBeUndefined();
    expect(await evidence()).toEqual(beforeEvidence);
    await post('increase', body).expect(201);
  });
  it('creates no supplier, money, expense, sales or count facts', async () => {
    for (const table of [
      'purchase_invoices',
      'goods_receipts',
      'supplier_ledger_entries',
      'money_movements',
      'expenses',
      'sales',
      'stock_counts',
      'stock_count_items',
    ])
      expect(
        (await db().admin.query(`select count(*)::int as count from ledger.${table}`)).rows[0],
      ).toEqual({ count: 0 });
  });
});
