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
import { parseStockCountCommand } from '../src/inventory/stock-count-command';
import { StockCountRepository } from '../src/inventory/stock-count.repository';
import type { StockCountResponse } from '../src/inventory/stock-count-response';
import {
  createInventoryTestDatabase,
  setInventoryContext,
  stockCountMigrationFilename,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

type Role = 'owner' | 'manager';
interface Identity {
  role: Role;
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  token: string;
}
interface ProductFixture {
  productId: string;
  baseUnitId: string;
  unitId: string;
}

const primaryStoreId = randomUUID();
const owner: Identity = {
  role: 'owner',
  storeId: primaryStoreId,
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s115-${randomUUID()}@example.test`,
  token: '',
};
const manager: Identity = {
  role: 'manager',
  storeId: primaryStoreId,
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s115-${randomUUID()}@example.test`,
  token: '',
};
const foreignOwner: Identity = {
  role: 'owner',
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s115-${randomUUID()}@example.test`,
  token: '',
};
const identities = [owner, manager, foreignOwner];

const january = '2026-01-15T10:00:00Z';

describe('S11.5 Stock Counts on isolated real PostgreSQL', () => {
  jest.setTimeout(180000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let migrationEvidence: Record<string, unknown> | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated Stock Count database is unavailable.');
    return database;
  }

  function postCount(body: unknown, identity = owner) {
    return request(server)
      .post('/v1/inventory/counts')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body as object);
  }

  function postInventory(kind: 'opening' | 'increase' | 'decrease', body: unknown) {
    return request(server)
      .post(`/v1/inventory/${kind}`)
      .set('authorization', `Bearer ${owner.token}`)
      .send(body as object);
  }

  function countInput(
    items: {
      productId: string;
      productUnitId: string;
      actualQuantityMilli: string;
    }[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      operationId: randomUUID(),
      countType: 'partial',
      occurredAt: january,
      items,
      ...overrides,
    };
  }

  function inventoryInput(product: ProductFixture, overrides: Record<string, unknown> = {}) {
    return {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.baseUnitId,
      selectedQuantityMilli: '1000',
      occurredAt: january,
      ...overrides,
    };
  }

  async function product(
    options: {
      storeId?: string;
      tracked?: boolean;
      status?: 'active' | 'archived';
      family?: 'count' | 'weight' | 'length' | 'volume';
      factorNum?: number;
      factorDen?: number;
      allowNegative?: boolean;
    } = {},
  ): Promise<ProductFixture> {
    const productId = randomUUID();
    const baseUnitId = randomUUID();
    const factorNum = options.factorNum ?? 1;
    const factorDen = options.factorDen ?? 1;
    const family = options.family ?? 'count';
    const storeId = options.storeId ?? owner.storeId;
    const archived = options.status === 'archived';
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,track_inventory,measurement_type,
        allow_negative_stock_override,status,archived_at,operation_id)
       values($1,$2,$3,$3,$4,$5,$6,$7,case when $7='archived' then now() end,$8)`,
      [
        productId,
        storeId,
        `s11.5-${productId}`,
        options.tracked ?? true,
        family,
        options.allowNegative ?? null,
        archived ? 'archived' : 'active',
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,unit_name,is_base,factor_num,factor_den,
        measurement_type,purchase_price_minor,operation_id)
       values($1,$2,$3,'base',true,1,1,$4,777,$5)`,
      [baseUnitId, storeId, productId, family, randomUUID()],
    );
    if (factorNum === 1 && factorDen === 1) {
      return { productId, baseUnitId, unitId: baseUnitId };
    }
    const unitId = randomUUID();
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,unit_name,is_base,factor_num,factor_den,
        measurement_type,purchase_price_minor,operation_id)
       values($1,$2,$3,'configured',false,$4,$5,$6,777,$7)`,
      [unitId, storeId, productId, factorNum, factorDen, family, randomUUID()],
    );
    return { productId, baseUnitId, unitId };
  }

  async function countFacts(productId: string) {
    return (
      await db().admin.query(
        `select
          (select count(*)::int from ledger.stock_count_items where product_id=$1) as items,
          (select count(*)::int from ledger.inventory_movements where product_id=$1) as movements,
          (select count(*)::int from ledger.inventory_movements
             where product_id=$1 and quantity_fact_kind='count_zero_establishment') as zero_facts,
          (select count(*)::int from ledger.stock_balances where product_id=$1) as balances`,
        [productId],
      )
    ).rows[0] as { items: number; movements: number; zero_facts: number; balances: number };
  }

  async function stock(productId: string) {
    return (
      await db().admin.query(
        `select quantity_milli::text as quantity, inventory_value_minor::text as value,
          average_unit_cost_minor::text as average, cost_state as state,
          version::text as version, last_movement_id as "lastMovementId"
         from ledger.stock_balances where product_id=$1`,
        [productId],
      )
    ).rows[0] as
      | {
          quantity: string;
          value: string;
          average: string;
          state: string;
          version: string;
          lastMovementId: string | null;
        }
      | undefined;
  }

  async function operation(operationId: string) {
    return (
      await db().admin.query(
        `select status,error_code as "errorCode" from sync.processed_operations
         where store_id=$1 and operation_id=$2`,
        [owner.storeId, operationId],
      )
    ).rows[0] as { status: string; errorCode: string | null } | undefined;
  }

  async function activeFullItems() {
    const result = await db().admin.query<{
      productId: string;
      productUnitId: string;
    }>(
      `select p.id as "productId",u.id as "productUnitId"
       from ledger.products p
       join ledger.product_units u on u.store_id=p.store_id and u.product_id=p.id
         and u.is_base and u.status='active'
       where p.store_id=$1 and p.status='active' and p.track_inventory
       order by p.id`,
      [owner.storeId],
    );
    return result.rows.map((row) => ({ ...row, actualQuantityMilli: '0' }));
  }

  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment) throw new Error('Approved non-production local test environment required.');
    database = await createInventoryTestDatabase(stockCountMigrationFilename);
    const name = (await db().admin.query<{ name: string }>('select current_database() as name'))
      .rows[0]?.name;
    if (!name || !/^dokana_s112_[0-9a-f]{32}$/.test(name) || name === environment.databaseName) {
      throw new Error('Stock Count test database is not isolated.');
    }

    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await migrator.query('begin');
      await migrator.query(db().file.contents);
      const inside = await migrator.query(
        `select exists(select 1 from pg_attribute
          where attrelid='ledger.inventory_movements'::regclass
            and attname='quantity_fact_kind' and not attisdropped) as present`,
      );
      await migrator.query('rollback');
      const rolledBack = await migrator.query(
        `select not exists(select 1 from pg_attribute
          where attrelid='ledger.inventory_movements'::regclass
            and attname='quantity_fact_kind' and not attisdropped) as absent`,
      );
      await applyMigration(migrator, db().file);
      migrationEvidence = { inside: inside.rows[0], rolledBack: rolledBack.rows[0] };
    } finally {
      await migrator.query('rollback');
      await migrator.query('reset role');
      migrator.release();
    }

    const url = (source: string) => {
      const parsed = new URL(source);
      parsed.pathname = `/${name}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(url(environment.runtimeUrl), 'dokana-s115-runtime', 8);
    authPool = createTestPool(url(environment.authUrl), 'dokana-s115-auth', 3);

    for (const storeId of new Set(identities.map((identity) => identity.storeId))) {
      await db().admin.query(`insert into ledger.stores(id,name) values($1,'S11.5 fixture')`, [
        storeId,
      ]);
    }
    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S11.5 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
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

    for (const identity of identities) {
      const response = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S11.5 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = response.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('Login token is missing.');
      identity.token = body.accessToken;
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else {
        await runtimePool?.end();
        await authPool?.end();
      }
      if (database) {
        expect(
          (
            await database.admin.query(
              `select count(*)::int as count from pg_stat_activity
               where datname=current_database() and state like 'idle in transaction%'`,
            )
          ).rows[0],
        ).toEqual({ count: 0 });
      }
    } finally {
      await database?.close();
    }
  });

  it('applies 0008 transactionally and preserves forced RLS and least privilege', async () => {
    expect(migrationEvidence).toEqual({ inside: { present: true }, rolledBack: { absent: true } });
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count, min(filename) filter (where filename like '0008%') as migration
           from platform.schema_migrations`,
        )
      ).rows[0],
    ).toEqual({ count: 8, migration: stockCountMigrationFilename });
    expect(
      (
        await db().admin.query(
          `select bool_and(relrowsecurity and relforcerowsecurity) as forced
           from pg_class where oid in (
             'ledger.inventory_movements'::regclass,'ledger.stock_balances'::regclass,
             'ledger.stock_counts'::regclass,'ledger.stock_count_items'::regclass)`,
        )
      ).rows[0],
    ).toEqual({ forced: true });
    expect(
      (
        await db().admin.query(
          `select
             has_table_privilege('shop_app_runtime','ledger.stock_balances','INSERT,UPDATE,DELETE') as balance_dml,
             has_table_privilege('shop_app_runtime','ledger.inventory_movements','UPDATE,DELETE') as movement_mutation,
             p.prosecdef as security_definer,
             p.proconfig = array['search_path=pg_catalog, pg_temp'] as pinned
           from pg_proc p where p.oid='ledger.apply_inventory_movement()'::regprocedure`,
        )
      ).rows[0],
    ).toEqual({
      balance_dml: false,
      movement_mutation: false,
      security_definer: true,
      pinned: true,
    });
  });

  it('establishes missing physical zero once and keeps a later zero count movement-free', async () => {
    const fixture = await product();
    const body = countInput([
      {
        productId: fixture.productId,
        productUnitId: fixture.baseUnitId,
        actualQuantityMilli: '0',
      },
    ]);
    const first = await postCount(body).expect(201);
    expect(first.body).toMatchObject({
      countType: 'partial',
      status: 'posted',
      items: [
        {
          productId: fixture.productId,
          actualBaseQuantityMilli: '0',
          previousProjectionState: 'MISSING',
          previousBaseQuantityMilli: null,
          varianceMilli: null,
          adjustmentKind: 'establishment',
          quantityFactKind: 'count_zero_establishment',
          stock: {
            projectionState: 'PRESENT',
            baseQuantityMilli: '0',
            cost: { status: 'unknown', valueMinor: null, averageUnitCostMinor: null },
          },
        },
      ],
    });
    const accepted = first.body as StockCountResponse;
    const replay = await postCount(body).expect(201);
    expect(replay.body as unknown).toEqual(accepted);
    expect(await countFacts(fixture.productId)).toEqual({
      items: 1,
      movements: 1,
      zero_facts: 1,
      balances: 1,
    });
    const acceptedItem = accepted.items[0];
    if (!acceptedItem?.movementId) throw new Error('Zero establishment movement is missing.');
    expect(
      (
        await db().admin.query(
          `select previous_projection_state as state,
            system_quantity_milli::text as system_quantity,
            difference_milli::text as difference
           from ledger.stock_count_items where id=$1`,
          [acceptedItem.itemId],
        )
      ).rows[0],
    ).toEqual({ state: 'missing', system_quantity: null, difference: null });
    expect(
      (
        await db().admin.query(
          `select
            exists(select 1 from sync.change_events where entity_id=$1) as count_change,
            exists(select 1 from sync.change_events where entity_id=$2) as movement_change,
            exists(select 1 from audit.central_audit_logs where entity_id=$1) as count_audit,
            exists(select 1 from audit.central_audit_logs where entity_id=$2) as movement_audit`,
          [accepted.countId, acceptedItem.movementId],
        )
      ).rows[0],
    ).toEqual({
      count_change: true,
      movement_change: true,
      count_audit: true,
      movement_audit: true,
    });

    const later = await postCount(
      countInput([
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(201);
    expect(later.body).toMatchObject({
      items: [
        {
          previousProjectionState: 'ESTABLISHED',
          previousBaseQuantityMilli: '0',
          varianceMilli: '0',
          adjustmentKind: 'none',
          quantityFactKind: null,
          movementId: null,
          stock: { baseQuantityMilli: '0', cost: { status: 'unknown' } },
        },
      ],
    });
    expect(await countFacts(fixture.productId)).toEqual({
      items: 2,
      movements: 1,
      zero_facts: 1,
      balances: 1,
    });
    const read = await request(server)
      .get(`/v1/inventory/stock/${fixture.productId}`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(read.body).toMatchObject({
      projectionState: 'PRESENT',
      stock: { baseQuantityMilli: '0', quantityState: 'ZERO', cost: { status: 'unknown' } },
    });
  });

  it.each([
    ['count', 24, 1, '1000', '24000'],
    ['weight', 1000, 1, '1000', '1000000'],
    ['length', 1, 1000, '1000', '1'],
    ['volume', 1000, 1, '1000', '1000000'],
  ] as const)(
    'establishes exact %s unit conversion %s/%s without catalog-cost substitution',
    async (family, factorNum, factorDen, selected, expected) => {
      const fixture = await product({ family, factorNum, factorDen });
      const response = await postCount(
        countInput([
          {
            productId: fixture.productId,
            productUnitId: fixture.unitId,
            actualQuantityMilli: selected,
          },
        ]),
      ).expect(201);
      expect(response.body).toMatchObject({
        items: [
          {
            factorNum,
            factorDen,
            actualSelectedQuantityMilli: selected,
            actualBaseQuantityMilli: expected,
            previousProjectionState: 'MISSING',
            previousBaseQuantityMilli: null,
            varianceMilli: null,
            quantityFactKind: 'movement',
            stock: {
              baseQuantityMilli: expected,
              cost: { status: 'unknown', valueMinor: null, averageUnitCostMinor: null },
            },
          },
        ],
      });
      expect(await stock(fixture.productId)).toMatchObject({
        quantity: expected,
        value: '0',
        state: 'unknown',
      });
    },
  );

  it('rejects client authority, duplicate Products, negative/lossy quantity, and queries before claim', async () => {
    const fixture = await product();
    const item = {
      productId: fixture.productId,
      productUnitId: fixture.baseUnitId,
      actualQuantityMilli: '0',
    };
    const invalid = [
      countInput([item, item]),
      countInput([{ ...item, actualQuantityMilli: '-1' }]),
      countInput([{ ...item, actualQuantityMilli: '1.1' }]),
      { ...countInput([item]), quantityFactKind: 'count_zero_establishment' },
      { ...countInput([item]), quantityDeltaMilli: '0' },
      { ...countInput([item]), purchaseCostMinor: '0' },
      { ...countInput([item]), storeId: owner.storeId },
    ];
    for (const body of invalid) {
      await postCount(body).expect(400);
      expect(await operation(body.operationId)).toBeUndefined();
    }
    const queryBody = countInput([item]);
    await postCount(queryBody).query({ storeId: owner.storeId }).expect(400);
    expect(await operation(queryBody.operationId)).toBeUndefined();
  });

  it('rejects non-exact and overflowing conversions without rounding or partial stock', async () => {
    for (const options of [
      { factorNum: 1, factorDen: 3, quantity: '1' },
      { factorNum: 2, factorDen: 1, quantity: '9223372036854775807' },
    ]) {
      const fixture = await product(options);
      const body = countInput([
        {
          productId: fixture.productId,
          productUnitId: fixture.unitId,
          actualQuantityMilli: options.quantity,
        },
      ]);
      await postCount(body).expect(400);
      expect(await countFacts(fixture.productId)).toEqual({
        items: 0,
        movements: 0,
        zero_facts: 0,
        balances: 0,
      });
      expect(await operation(body.operationId)).toEqual({
        status: 'rejected',
        errorCode: 'STOCK_COUNT_AMOUNT_INVALID',
      });
    }
  });

  it('keeps PostgreSQL int8 quantities above JavaScript Number precision lossless', async () => {
    const fixture = await product();
    const quantity = '9007199254740993';
    const response = await postCount(
      countInput([
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli: quantity,
        },
      ]),
    ).expect(201);
    expect(response.body).toMatchObject({
      items: [
        {
          actualSelectedQuantityMilli: quantity,
          actualBaseQuantityMilli: quantity,
          stock: { baseQuantityMilli: quantity },
        },
      ],
    });
  });

  it('implements PARTIAL without touching unsubmitted Products', async () => {
    const submitted = await product();
    const untouched = await product();
    await postCount(
      countInput([
        {
          productId: submitted.productId,
          productUnitId: submitted.baseUnitId,
          actualQuantityMilli: '1000',
        },
      ]),
    ).expect(201);
    expect(await stock(submitted.productId)).toMatchObject({ quantity: '1000' });
    expect(await stock(untouched.productId)).toBeUndefined();
  });

  it('implements FULL from the active tracked set and rejects incomplete/invalid sets atomically', async () => {
    const excluded = await product({ tracked: false });
    const archived = await product({ status: 'archived' });
    const fullItems = await activeFullItems();
    const success = await postCount(
      countInput([...fullItems].reverse(), { countType: 'full' }),
    ).expect(201);
    expect((success.body as StockCountResponse).items).toHaveLength(fullItems.length);
    expect(await stock(excluded.productId)).toBeUndefined();
    expect(await stock(archived.productId)).toBeUndefined();

    const required = await product();
    const incomplete = countInput(fullItems, { countType: 'full' });
    await postCount(incomplete).expect(409);
    expect(await stock(required.productId)).toBeUndefined();
    expect(await operation(incomplete.operationId)).toEqual({
      status: 'rejected',
      errorCode: 'STOCK_COUNT_FULL_SET_MISMATCH',
    });

    const current = await activeFullItems();
    const invalid = countInput(
      current.map((item, index) => (index === 0 ? { ...item, productUnitId: randomUUID() } : item)),
      { countType: 'full' },
    );
    const countBefore = (
      await db().admin.query<{ count: number }>(
        `select count(*)::int as count from ledger.stock_counts`,
      )
    ).rows[0];
    await postCount(invalid).expect(409);
    expect(
      (
        await db().admin.query<{ count: number }>(
          `select count(*)::int as count from ledger.stock_counts`,
        )
      ).rows[0],
    ).toEqual(countBefore);
  });

  it('rejects NOT_TRACKED, inactive, wrong-unit, foreign, and absent Products without leakage', async () => {
    const notTracked = await product({ tracked: false });
    const inactive = await product({ status: 'archived' });
    const first = await product();
    const second = await product();
    const foreign = await product({ storeId: foreignOwner.storeId });
    for (const fixture of [notTracked, inactive]) {
      await postCount(
        countInput([
          {
            productId: fixture.productId,
            productUnitId: fixture.baseUnitId,
            actualQuantityMilli: '0',
          },
        ]),
      ).expect(409);
      expect(await stock(fixture.productId)).toBeUndefined();
    }
    await postCount(
      countInput([
        {
          productId: first.productId,
          productUnitId: second.baseUnitId,
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(409);
    const hidden = await postCount(
      countInput([
        {
          productId: foreign.productId,
          productUnitId: foreign.baseUnitId,
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(409);
    const absent = await postCount(
      countInput([
        {
          productId: randomUUID(),
          productUnitId: randomUUID(),
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(409);
    expect(hidden.body).toMatchObject({ code: (absent.body as { code: string }).code });
  });

  it('enforces authenticated owner authority and trusted Store context', async () => {
    const fixture = await product();
    const body = countInput([
      {
        productId: fixture.productId,
        productUnitId: fixture.baseUnitId,
        actualQuantityMilli: '0',
      },
    ]);
    await request(server).post('/v1/inventory/counts').send(body).expect(401);
    await postCount(body, manager).expect(403);
    const response = await postCount(body).set('x-store-id', foreignOwner.storeId).expect(201);
    expect(response.body).toMatchObject({ items: [{ productId: fixture.productId }] });
    const crossStore = await postCount(body, foreignOwner).expect(409);
    expect(crossStore.body).toMatchObject({ code: 'STOCK_COUNT_PRODUCT_UNAVAILABLE' });
  });

  it('preserves honest known, known-zero, unknown, and pending cost transitions', async () => {
    const knownPositive = await product();
    await postInventory(
      'increase',
      inventoryInput(knownPositive, {
        selectedQuantityMilli: '3000',
        totalPurchaseCostMinor: '10',
      }),
    ).expect(201);
    const positive = await postCount(
      countInput([
        {
          productId: knownPositive.productId,
          productUnitId: knownPositive.baseUnitId,
          actualQuantityMilli: '4000',
        },
      ]),
    ).expect(201);
    expect(positive.body).toMatchObject({
      items: [
        {
          varianceMilli: '1000',
          stock: { cost: { status: 'unknown', valueMinor: null } },
        },
      ],
    });

    const knownNegative = await product();
    await postInventory(
      'increase',
      inventoryInput(knownNegative, {
        selectedQuantityMilli: '3000',
        totalPurchaseCostMinor: '10',
      }),
    ).expect(201);
    await postCount(
      countInput([
        {
          productId: knownNegative.productId,
          productUnitId: knownNegative.baseUnitId,
          actualQuantityMilli: '2000',
        },
      ]),
    ).expect(201);
    expect(await stock(knownNegative.productId)).toMatchObject({
      quantity: '2000',
      value: '7',
      average: '4',
      state: 'known',
    });
    await postCount(
      countInput([
        {
          productId: knownNegative.productId,
          productUnitId: knownNegative.baseUnitId,
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(201);
    expect(await stock(knownNegative.productId)).toMatchObject({
      quantity: '0',
      value: '0',
      state: 'known',
    });

    const knownZero = await product();
    await postInventory(
      'opening',
      inventoryInput(knownZero, { totalPurchaseCostMinor: '0' }),
    ).expect(201);
    await postCount(
      countInput([
        {
          productId: knownZero.productId,
          productUnitId: knownZero.baseUnitId,
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(201);
    expect(await stock(knownZero.productId)).toMatchObject({ state: 'known', value: '0' });

    for (const actual of ['4000', '2000', '0']) {
      const unknown = await product();
      await postInventory(
        'increase',
        inventoryInput(unknown, { selectedQuantityMilli: '3000' }),
      ).expect(201);
      await postCount(
        countInput([
          {
            productId: unknown.productId,
            productUnitId: unknown.baseUnitId,
            actualQuantityMilli: actual,
          },
        ]),
      ).expect(201);
      expect(await stock(unknown.productId)).toMatchObject({
        quantity: actual,
        value: '0',
        state: 'unknown',
      });
    }

    const pendingPositive = await product({ allowNegative: true });
    await postInventory(
      'decrease',
      inventoryInput(pendingPositive, { reason: 'fixture negative stock' }),
    ).expect(201);
    await postCount(
      countInput([
        {
          productId: pendingPositive.productId,
          productUnitId: pendingPositive.baseUnitId,
          actualQuantityMilli: '0',
        },
      ]),
    ).expect(201);
    expect(await stock(pendingPositive.productId)).toMatchObject({
      quantity: '0',
      value: '0',
      state: 'pending',
    });

    const pendingNegative = await product({ allowNegative: true });
    await postInventory(
      'decrease',
      inventoryInput(pendingNegative, { reason: 'fixture negative stock' }),
    ).expect(201);
    await postInventory(
      'increase',
      inventoryInput(pendingNegative, {
        selectedQuantityMilli: '3000',
        totalPurchaseCostMinor: '10',
      }),
    ).expect(201);
    await postCount(
      countInput([
        {
          productId: pendingNegative.productId,
          productUnitId: pendingNegative.baseUnitId,
          actualQuantityMilli: '1000',
        },
      ]),
    ).expect(201);
    expect(await stock(pendingNegative.productId)).toMatchObject({
      quantity: '1000',
      value: '0',
      state: 'pending',
    });
  });

  it('replays canonically and rejects every changed semantic request', async () => {
    const first = await product();
    const second = await product();
    const body = countInput([
      {
        productId: second.productId,
        productUnitId: second.baseUnitId,
        actualQuantityMilli: '2000',
      },
      {
        productId: first.productId,
        productUnitId: first.baseUnitId,
        actualQuantityMilli: '1000',
      },
    ]);
    const accepted = await postCount(body).expect(201);
    const reordered = await postCount({ ...body, items: [...body.items].reverse() }).expect(201);
    expect(reordered.body).toEqual(accepted.body);
    for (const change of [
      { countType: 'full' },
      { occurredAt: '2026-01-16T10:00:00Z' },
      { items: body.items.slice(0, 1) },
      { items: [{ ...body.items[0], actualQuantityMilli: '3000' }, body.items[1]] },
      { items: [{ ...body.items[0], productUnitId: randomUUID() }, body.items[1]] },
    ]) {
      await postCount({ ...body, ...change }).expect(409);
    }
    expect(await countFacts(first.productId)).toMatchObject({ items: 1, movements: 1 });
  });

  it('rejects a new closed-period count while replaying completed history after closure and lifecycle change', async () => {
    const fixture = await product();
    const body = countInput(
      [
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli: '1000',
        },
      ],
      { occurredAt: '2026-02-15T10:00:00Z' },
    );
    const accepted = await postCount(body).expect(201);
    const result = accepted.body as StockCountResponse;
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=now() where id=$1`,
      [result.accountingPeriodId],
    );
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=now(),track_inventory=false where id=$1`,
      [fixture.productId],
    );
    expect((await postCount(body).expect(201)).body).toEqual(accepted.body);
    const rejected = countInput(
      [
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli: '2000',
        },
      ],
      { occurredAt: body.occurredAt },
    );
    await postCount(rejected).expect(409);
    expect(await operation(rejected.operationId)).toEqual({
      status: 'rejected',
      errorCode: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    });

    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      owner.storeId,
    ]);
    try {
      expect((await postCount(body).expect(201)).body).toEqual(accepted.body);
      const newProduct = await product();
      await postCount(
        countInput([
          {
            productId: newProduct.productId,
            productUnitId: newProduct.baseUnitId,
            actualQuantityMilli: '0',
          },
        ]),
      ).expect(403);
      expect(await stock(newProduct.productId)).toBeUndefined();
    } finally {
      await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
        owner.storeId,
      ]);
    }
  });

  it('serializes concurrent exact replay and two initial physical-zero counts', async () => {
    const replayProduct = await product();
    const replayBody = countInput([
      {
        productId: replayProduct.productId,
        productUnitId: replayProduct.baseUnitId,
        actualQuantityMilli: '0',
      },
    ]);
    const replayed = await Promise.all([postCount(replayBody), postCount(replayBody)]);
    expect(replayed.map((response) => response.status)).toEqual([201, 201]);
    expect(replayed[0].body as unknown).toEqual(replayed[1].body as unknown);
    expect(await countFacts(replayProduct.productId)).toEqual({
      items: 1,
      movements: 1,
      zero_facts: 1,
      balances: 1,
    });

    const zeroProduct = await product();
    const zeroItem = {
      productId: zeroProduct.productId,
      productUnitId: zeroProduct.baseUnitId,
      actualQuantityMilli: '0',
    };
    const counts = await Promise.all([
      postCount(countInput([zeroItem])),
      postCount(countInput([zeroItem])),
    ]);
    expect(counts.map((response) => response.status)).toEqual([201, 201]);
    expect(await countFacts(zeroProduct.productId)).toEqual({
      items: 2,
      movements: 1,
      zero_facts: 1,
      balances: 1,
    });
  });

  it('serializes zero-vs-positive establishment and overlapping multi-Product counts', async () => {
    const establishment = await product();
    const zero = countInput([
      {
        productId: establishment.productId,
        productUnitId: establishment.baseUnitId,
        actualQuantityMilli: '0',
      },
    ]);
    const positive = countInput([
      {
        productId: establishment.productId,
        productUnitId: establishment.baseUnitId,
        actualQuantityMilli: '1000',
      },
    ]);
    const race = await Promise.all([postCount(zero), postCount(positive)]);
    expect(race.map((response) => response.status)).toEqual([201, 201]);
    expect(['0', '1000']).toContain((await stock(establishment.productId))?.quantity);
    expect(await countFacts(establishment.productId)).toMatchObject({
      items: 2,
      movements: 2,
      balances: 1,
    });

    const first = await product();
    const second = await product();
    const make = (quantity: string) =>
      countInput([
        {
          productId: second.productId,
          productUnitId: second.baseUnitId,
          actualQuantityMilli: quantity,
        },
        {
          productId: first.productId,
          productUnitId: first.baseUnitId,
          actualQuantityMilli: quantity,
        },
      ]);
    const overlapping = await Promise.all([postCount(make('1000')), postCount(make('2000'))]);
    expect(overlapping.map((response) => response.status)).toEqual([201, 201]);
    const firstStock = await stock(first.productId);
    const secondStock = await stock(second.productId);
    expect(['1000', '2000']).toContain(firstStock?.quantity);
    expect(secondStock?.quantity).toBe(firstStock?.quantity);
  });

  it('serializes Stock Count against manual increase and decrease without stale variance', async () => {
    const increasing = await product();
    const count = countInput([
      {
        productId: increasing.productId,
        productUnitId: increasing.baseUnitId,
        actualQuantityMilli: '2000',
      },
    ]);
    const increase = inventoryInput(increasing);
    const increaseRace = await Promise.all([postCount(count), postInventory('increase', increase)]);
    expect(increaseRace.map((response) => response.status)).toEqual([201, 201]);
    expect(['2000', '3000']).toContain((await stock(increasing.productId))?.quantity);

    const decreasing = await product({ allowNegative: true });
    await postInventory(
      'opening',
      inventoryInput(decreasing, { selectedQuantityMilli: '5000', totalPurchaseCostMinor: '10' }),
    ).expect(201);
    const decreaseRace = await Promise.all([
      postCount(
        countInput([
          {
            productId: decreasing.productId,
            productUnitId: decreasing.baseUnitId,
            actualQuantityMilli: '4000',
          },
        ]),
      ),
      postInventory('decrease', inventoryInput(decreasing, { reason: 'count race fixture' })),
    ]);
    expect(decreaseRace.map((response) => response.status)).toEqual([201, 201]);
    expect(['3000', '4000']).toContain((await stock(decreasing.productId))?.quantity);
  });

  it('fails closed under RLS, rejects ordinary/forged zero facts, and denies projection DML', async () => {
    if (!app) throw new Error('Stock Count application is unavailable.');
    const fixture = await product();
    const body = countInput([
      {
        productId: fixture.productId,
        productUnitId: fixture.baseUnitId,
        actualQuantityMilli: '0',
      },
    ]);
    await postCount(body).expect(201);
    const context = {
      storeId: owner.storeId,
      userId: owner.userId,
      deviceId: owner.deviceId,
      requestId: randomUUID(),
    };
    await expect(
      app
        .get(StockCountRepository)
        .post({ ...context, storeId: '' }, parseStockCountCommand(countInput([])), '2026-01-15'),
    ).rejects.toThrow(TypeError);
    const client = await db().runtime.connect();
    const insertCopy = async (
      productId: string,
      unitId: string,
      factKind: 'movement' | 'count_zero_establishment',
    ) =>
      client.query(
        `insert into ledger.inventory_movements(
          id,store_id,product_id,accounting_period_id,movement_type,
          quantity_before_milli,quantity_delta_milli,quantity_after_milli,
          inventory_value_before_minor,value_delta_minor,inventory_value_after_minor,
          average_unit_cost_after_minor,cost_status,has_pending_cost_after,
          reference_type,reference_id,transaction_group_id,occurred_at,reason,
          device_id,operation_id,product_unit_id,selected_quantity_milli,
          factor_num,factor_den,business_date,posting_date,cost_state_before,
          cost_state_after,quantity_fact_kind)
         select $1,store_id,$2,accounting_period_id,movement_type,
          0,0,0,0,0,0,0,'unknown',false,reference_type,reference_id,$3,
          occurred_at,null,device_id,$4,$5,0,1,1,business_date,posting_date,
          'unknown','unknown',$6
         from ledger.inventory_movements
         where store_id=$7 and product_id=$8 and quantity_fact_kind='count_zero_establishment'
         limit 1`,
        [
          randomUUID(),
          productId,
          randomUUID(),
          randomUUID(),
          unitId,
          factKind,
          owner.storeId,
          fixture.productId,
        ],
      );
    try {
      expect(
        (await client.query('select count(*)::int as count from ledger.stock_balances')).rows[0],
      ).toEqual({ count: 0 });
      await client.query('begin');
      await setInventoryContext(client, owner.storeId, owner.deviceId, owner.userId);
      await expect(
        client.query(`update ledger.stock_balances set quantity_milli=0 where product_id=$1`, [
          fixture.productId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');

      await client.query('begin');
      await setInventoryContext(client, owner.storeId, owner.deviceId, owner.userId);
      await expect(
        insertCopy(fixture.productId, fixture.baseUnitId, 'movement'),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('rollback');

      await client.query('begin');
      await setInventoryContext(client, owner.storeId, owner.deviceId, owner.userId);
      await expect(
        insertCopy(fixture.productId, fixture.baseUnitId, 'count_zero_establishment'),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('rollback');

      const untracked = await product({ tracked: false });
      await client.query('begin');
      await setInventoryContext(client, owner.storeId, owner.deviceId, owner.userId);
      await expect(
        insertCopy(untracked.productId, untracked.baseUnitId, 'count_zero_establishment'),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('rollback');

      await client.query('begin');
      await setInventoryContext(client, owner.storeId, owner.deviceId, owner.userId);
      await expect(
        client.query(`update ledger.stock_counts set status='draft' where operation_id=$1`, [
          body.operationId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await client.query('rollback');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('rolls back claim, count, movement, projection, audit, and change facts after a controlled failure', async () => {
    if (!app) throw new Error('Stock Count application is unavailable.');
    const fixture = await product();
    const body = countInput([
      {
        productId: fixture.productId,
        productUnitId: fixture.baseUnitId,
        actualQuantityMilli: '0',
      },
    ]);
    const evidence = async () => {
      const result = await db().admin.query<{
        counts: number;
        items: number;
        movements: number;
        balances: number;
        operations: number;
        changes: number;
        audit: number;
      }>(
        `select
            (select count(*)::int from ledger.stock_counts where operation_id=$1) as counts,
            (select count(*)::int from ledger.stock_count_items where product_id=$2) as items,
            (select count(*)::int from ledger.inventory_movements where product_id=$2) as movements,
            (select count(*)::int from ledger.stock_balances where product_id=$2) as balances,
            (select count(*)::int from sync.processed_operations where operation_id=$1) as operations,
            (select count(*)::int from sync.change_events where entity_id=$2) as changes,
            (select count(*)::int from audit.central_audit_logs where entity_id=$2) as audit`,
        [body.operationId, fixture.productId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Stock Count rollback evidence is missing.');
      return row;
    };
    const before = await evidence();
    const databaseService = app.get(DatabaseService);
    const original = databaseService.withTenantTransaction.bind(databaseService);
    const spy = jest
      .spyOn(databaseService, 'withTenantTransaction')
      .mockImplementation((context, work) =>
        original(context, async (transaction) => {
          await work(transaction);
          throw new Error('S11.5 controlled rollback');
        }),
      );
    try {
      await postCount(body).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await evidence()).toEqual(before);
    await postCount(body).expect(201);
  });

  it('creates no supplier, payable, money, expense, Sale, sold-quantity, COGS, or profit effect', async () => {
    const tables = [
      'purchase_invoices',
      'goods_receipts',
      'supplier_ledger_entries',
      'supplier_payments',
      'money_movements',
      'expenses',
      'sales',
      'sale_items',
    ];
    const before = new Map<string, number>();
    for (const table of tables) {
      before.set(
        table,
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.${table}`,
          )
        ).rows[0]?.count ?? -1,
      );
    }
    const fixture = await product();
    await postCount(
      countInput([
        {
          productId: fixture.productId,
          productUnitId: fixture.baseUnitId,
          actualQuantityMilli: '1000',
        },
      ]),
    ).expect(201);
    for (const table of tables) {
      expect(
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.${table}`,
          )
        ).rows[0]?.count,
      ).toBe(before.get(table));
    }
  });
});
