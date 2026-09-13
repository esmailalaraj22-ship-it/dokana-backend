import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import type {
  CustomerReceivableListResponse,
  SaleDetailResponse,
  SaleListResponse,
} from '../src/sales/sale-read.types';
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0012_sales_inventory_validation.sql';

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  token: string;
}

interface ProductFixture {
  id: string;
  unitId: string;
  name: string;
  unitName: string;
}

interface PostedFixtures {
  anonymous: SalePostingResponse;
  partial: SalePostingResponse;
  credit: SalePostingResponse;
  costStates: SalePostingResponse;
  large: SalePostingResponse;
  historical: SalePostingResponse;
  foreign: SalePostingResponse;
  readOnly: SalePostingResponse;
  openingId: string;
}

const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s144-owner-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s144-foreign-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s144-manager-${randomUUID()}@example.test`,
    role: 'manager',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s144-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
];
const owner = identities[0];
const foreignOwner = identities[1];
const manager = identities[2];
const readOnlyOwner = identities[3];
const customers = {
  primary: randomUUID(),
  secondary: randomUUID(),
  foreign: randomUUID(),
};
const accounts = {
  cash: randomUUID(),
  bank: randomUUID(),
  foreign: randomUUID(),
  readOnly: randomUUID(),
};
const LARGE_SALE = '9007199254740993';
const LARGE_OPENING = '9007199254740995';
const CUSTOMER_OUTSTANDING = '18014398509482988';

describe('S14.4 Sale and Customer Receivable operational reads on isolated PostgreSQL', () => {
  jest.setTimeout(240_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let facts: PostedFixtures;
  let knownProduct: ProductFixture;
  let unknownProduct: ProductFixture;
  let pendingProduct: ProductFixture;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S14.4 database is unavailable.');
    return database;
  }

  function apiGet(path: string, identity: Identity = owner): request.Test {
    return request(server).get(`/v1/${path}`).set('authorization', `Bearer ${identity.token}`);
  }

  async function postSale(
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): Promise<SalePostingResponse> {
    const result = await request(server)
      .post('/v1/sales')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body)
      .expect(201);
    return result.body as SalePostingResponse;
  }

  async function postOpening(customerId: string, body: Record<string, unknown>): Promise<string> {
    const result = await request(server)
      .post(`/v1/customers/${customerId}/opening-receivables`)
      .set('authorization', `Bearer ${owner.token}`)
      .send(body)
      .expect(201);
    const response = result.body as { receivable?: { id?: unknown } };
    if (typeof response.receivable?.id !== 'string') {
      throw new Error('Opening Receivable fixture is missing its identity.');
    }
    return response.receivable.id;
  }

  function manualSale(input: {
    occurredAt: string;
    totalMinor: string;
    customerId?: string;
    payments?: { moneyAccountId: string; amountMinor: string }[];
    description?: string;
  }): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      customerId: input.customerId,
      occurredAt: input.occurredAt,
      notes: 'S14.4 read fixture',
      items: [
        {
          isManualLine: true,
          description: input.description ?? 'Manual Sale line',
          unitName: 'service',
          quantityMilli: '1000',
          unitPriceMinor: input.totalMinor,
          lineDiscountMinor: '0',
          roundingMinor: '0',
          lineTotalMinor: input.totalMinor,
        },
      ],
      payments: input.payments ?? [],
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
      totalMinor: input.totalMinor,
    };
  }

  async function createProduct(
    name: string,
    options: { allowNegative?: boolean; tracked?: boolean } = {},
  ): Promise<ProductFixture> {
    const product = { id: randomUUID(), unitId: randomUUID(), name, unitName: `${name} unit` };
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,measurement_type,track_inventory,
        allow_negative_stock_override,status,operation_id
      ) values($1,$2,$3,lower($3),'count',$4,$5,'active',$6)`,
      [
        product.id,
        owner.storeId,
        product.name,
        options.tracked ?? true,
        options.allowNegative ?? null,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,measurement_type,unit_name,is_base,
        factor_num,factor_den,status,operation_id
      ) values($1,$2,$3,'count',$4,true,1,1,'active',$5)`,
      [product.unitId, owner.storeId, product.id, product.unitName, randomUUID()],
    );
    return product;
  }

  async function seedInventory(product: ProductFixture, costMinor?: string): Promise<void> {
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      productId: product.id,
      productUnitId: product.unitId,
      selectedQuantityMilli: '5000',
      occurredAt: '2026-08-01T08:00:00Z',
    };
    if (costMinor !== undefined) body.totalPurchaseCostMinor = costMinor;
    await request(server)
      .post('/v1/inventory/increase')
      .set('authorization', `Bearer ${owner.token}`)
      .send(body)
      .expect(201);
  }

  async function createCostStateSale(): Promise<SalePostingResponse> {
    return postSale({
      operationId: randomUUID(),
      occurredAt: '2026-08-13T10:00:00Z',
      items: [knownProduct, unknownProduct, pendingProduct].map((product) => ({
        isManualLine: false,
        productId: product.id,
        productUnitId: product.unitId,
        quantityMilli: '1000',
        unitPriceMinor: '100',
        lineTotalMinor: '100',
      })),
      payments: [{ moneyAccountId: accounts.cash, amountMinor: '300' }],
      totalMinor: '300',
    });
  }

  async function snapshotBusinessFacts(): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const table of [
      'ledger.sales',
      'ledger.sale_items',
      'ledger.sale_payments',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
      'ledger.stock_balances',
      'sync.processed_operations',
      'sync.change_events',
      'audit.central_audit_logs',
    ]) {
      const row = (
        await db().admin.query<{ hash: string | null }>(
          `select md5(coalesce(string_agg(to_jsonb(t)::text, '' order by to_jsonb(t)::text), '')) as hash from ${table} t`,
        )
      ).rows[0];
      result[table] = row?.hash ?? null;
    }
    return result;
  }

  beforeAll(async () => {
    const environment = readLocalPostgresTestEnvironment();
    if (!environment) throw new Error('Approved non-production local test environment required.');
    database = await createInventoryTestDatabase(migrationFilename);
    const migrator = await db().migration.connect();
    try {
      await verifyMigrationSession(migrator);
      await applyMigration(migrator, db().file);
    } finally {
      await migrator.query('reset role');
      migrator.release();
    }

    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (
      !databaseName ||
      !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName) ||
      databaseName === environment.databaseName
    ) {
      throw new Error('S14.4 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s144-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s144-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S14.4 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S14.4 fixture')`,
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
      const login = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S14.4 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S14.4 token is missing.');
      identity.token = body.accessToken;
    }

    for (const [customerId, identity, name] of [
      [customers.primary, owner, 'Primary Customer'],
      [customers.secondary, owner, 'Historical Customer'],
      [customers.foreign, foreignOwner, 'Foreign Customer'],
    ] as const) {
      await db().admin.query(
        `insert into ledger.customers(
          id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
        ) values($1,$2,$3,lower($3),$1::uuid::text,$1::uuid::text,'active',$4,$5)`,
        [customerId, identity.storeId, name, identity.deviceId, randomUUID()],
      );
    }
    for (const [id, identity, name] of [
      [accounts.cash, owner, 'Cash History'],
      [accounts.bank, owner, 'Bank Transfer'],
      [accounts.foreign, foreignOwner, 'Foreign Account'],
      [accounts.readOnly, readOnlyOwner, 'Read Only Account'],
    ] as const) {
      await db().admin.query(
        `insert into ledger.money_accounts(
          id,store_id,name,normalized_name,account_type,availability,status,operation_id
        ) values($1,$2,$3,lower($3),'transfer','available','active',$4)`,
        [id, identity.storeId, name, randomUUID()],
      );
    }

    knownProduct = await createProduct('Known Product');
    unknownProduct = await createProduct('Unknown Product');
    pendingProduct = await createProduct('Pending Product', { allowNegative: true });
    await seedInventory(knownProduct, '1000');
    await seedInventory(unknownProduct);

    const anonymous = await postSale(
      manualSale({
        occurredAt: '2026-08-10T10:00:00Z',
        totalMinor: '500',
        payments: [{ moneyAccountId: accounts.cash, amountMinor: '500' }],
        description: 'Anonymous paid line',
      }),
    );
    const partial = await postSale(
      manualSale({
        occurredAt: '2026-08-11T10:00:00Z',
        totalMinor: '500',
        customerId: customers.primary,
        payments: [
          { moneyAccountId: accounts.cash, amountMinor: '80' },
          { moneyAccountId: accounts.bank, amountMinor: '120' },
        ],
        description: 'Partial split line',
      }),
    );
    const credit = await postSale(
      manualSale({
        occurredAt: '2026-08-12T10:00:00Z',
        totalMinor: '700',
        customerId: customers.primary,
        description: 'Credit line',
      }),
    );
    const costStates = await createCostStateSale();
    const large = await postSale(
      manualSale({
        occurredAt: '2026-08-14T10:00:00Z',
        totalMinor: LARGE_SALE,
        customerId: customers.primary,
        description: 'Large exact receivable',
      }),
    );
    const historical = await postSale({
      operationId: randomUUID(),
      customerId: customers.secondary,
      occurredAt: '2026-08-15T10:00:00Z',
      items: [
        {
          isManualLine: false,
          productId: knownProduct.id,
          productUnitId: knownProduct.unitId,
          quantityMilli: '1000',
          unitPriceMinor: '250',
          lineTotalMinor: '250',
        },
      ],
      payments: [{ moneyAccountId: accounts.cash, amountMinor: '250' }],
      totalMinor: '250',
    });
    const foreign = await postSale(
      manualSale({
        occurredAt: '2026-08-10T11:00:00Z',
        totalMinor: '111',
        payments: [{ moneyAccountId: accounts.foreign, amountMinor: '111' }],
      }),
      foreignOwner,
    );
    const readOnly = await postSale(
      manualSale({
        occurredAt: '2026-08-10T12:00:00Z',
        totalMinor: '222',
        payments: [{ moneyAccountId: accounts.readOnly, amountMinor: '222' }],
      }),
      readOnlyOwner,
    );
    const openingId = await postOpening(customers.primary, {
      operationId: randomUUID(),
      amountMinor: LARGE_OPENING,
      occurredAt: '2026-08-16T10:00:00Z',
      notes: 'Historical opening receivable',
    });
    facts = {
      anonymous,
      partial,
      credit,
      costStates,
      large,
      historical,
      foreign,
      readOnly,
      openingId,
    };

    await db().admin.query(
      `update ledger.customers set status='archived', archived_at=clock_timestamp()
       where store_id=$1 and id in ($2,$3)`,
      [owner.storeId, customers.primary, customers.secondary],
    );
    await db().admin.query(
      `update ledger.products set status='archived', archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, knownProduct.id],
    );
    await db().admin.query(
      `update ledger.product_units set status='archived'
       where store_id=$1 and id=$2`,
      [owner.storeId, knownProduct.unitId],
    );
    await db().admin.query(
      `update ledger.money_accounts set status='archived', archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, accounts.cash],
    );
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      readOnlyOwner.storeId,
    ]);
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

  it('lists anonymous and Customer Sales with stable descending keyset pagination', async () => {
    const seen: { id: string; occurredAt: string; isAnonymous: boolean }[] = [];
    let cursor: string | null = null;
    do {
      const response = await apiGet('sales')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .expect(200);
      const page = response.body as SaleListResponse;
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((sale) => sale.id)).size).toBe(6);
    expect(seen.map((sale) => sale.occurredAt)).toEqual(
      [...seen.map((sale) => sale.occurredAt)].sort().reverse(),
    );
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: facts.anonymous.sale.id, isAnonymous: true }),
        expect.objectContaining({ id: facts.partial.sale.id, isAnonymous: false }),
      ]),
    );
    await apiGet('sales').query({ cursor: '*' }).expect(400);
    await apiGet('sales').query({ limit: 0 }).expect(400);
  });

  it('reads paid, partial, credit, and split-tender Sale truth exactly', async () => {
    const paid = (await apiGet(`sales/${facts.anonymous.sale.id}`).expect(200))
      .body as SaleDetailResponse;
    expect(paid).toMatchObject({
      sale: {
        id: facts.anonymous.sale.id,
        isAnonymous: true,
        paymentStatus: 'paid',
        totalMinor: '500',
        paidTotalMinor: '500',
        receivableOriginatedMinor: '0',
        receivableOutstandingMinor: '0',
      },
      receivable: null,
    });
    expect(paid.tenders).toHaveLength(1);

    const partial = (await apiGet(`sales/${facts.partial.sale.id}`).expect(200))
      .body as SaleDetailResponse;
    expect(partial.sale).toMatchObject({
      customer: { id: customers.primary, status: 'archived' },
      paymentStatus: 'partial',
      totalMinor: '500',
      paidTotalMinor: '200',
      receivableOriginatedMinor: '300',
      receivableOutstandingMinor: '300',
    });
    expect(partial.tenders.map((tender) => tender.amountMinor).sort()).toEqual(['120', '80']);
    expect(partial.receivable).toMatchObject({
      entryType: 'sale_credit',
      originalAmountMinor: '300',
      outstandingMinor: '300',
      sale: { id: facts.partial.sale.id },
    });

    const credit = (await apiGet(`sales/${facts.credit.sale.id}`).expect(200))
      .body as SaleDetailResponse;
    expect(credit.sale).toMatchObject({
      paymentStatus: 'credit',
      totalMinor: '700',
      paidTotalMinor: '0',
      receivableOriginatedMinor: '700',
      receivableOutstandingMinor: '700',
    });
    expect(credit.tenders).toEqual([]);
  });

  it('presents exact items, archived catalog/account history, and honest cost states', async () => {
    const detail = (await apiGet(`sales/${facts.costStates.sale.id}`).expect(200))
      .body as SaleDetailResponse;
    expect(detail.items).toHaveLength(3);
    expect(detail.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: knownProduct.id,
          productUnitId: knownProduct.unitId,
          productName: knownProduct.name,
          unitName: knownProduct.unitName,
          quantityMilli: '1000',
          baseQuantityMilli: '1000',
          costStatus: 'known',
          unitCostMinor: '200',
          lineCostMinor: '200',
        }),
        expect.objectContaining({
          productId: unknownProduct.id,
          costStatus: 'unknown',
          unitCostMinor: null,
          lineCostMinor: null,
        }),
        expect.objectContaining({
          productId: pendingProduct.id,
          costStatus: 'pending',
          unitCostMinor: null,
          lineCostMinor: null,
        }),
      ]),
    );
    expect(detail.sale).toMatchObject({
      knownCostTotalMinor: '200',
      pendingCostLineCount: 1,
      unknownCostLineCount: 1,
    });
    expect(detail.tenders[0]?.moneyAccount).toMatchObject({
      id: accounts.cash,
      name: 'Cash History',
      status: 'archived',
    });

    const historical = (await apiGet(`sales/${facts.historical.sale.id}`).expect(200))
      .body as SaleDetailResponse;
    expect(historical.sale.customer).toMatchObject({
      id: customers.secondary,
      status: 'archived',
    });
    expect(historical.items[0]).toMatchObject({
      productId: knownProduct.id,
      productUnitId: knownProduct.unitId,
      productName: knownProduct.name,
      unitName: knownProduct.unitName,
    });
  });

  it('keeps Opening Receivables distinct and derives exact Customer outstanding from the ledger', async () => {
    const collected: CustomerReceivableListResponse['receivables'] = [];
    let cursor: string | null = null;
    do {
      const response = await apiGet(`customers/${customers.primary}/receivables`)
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .expect(200);
      const page = response.body as CustomerReceivableListResponse;
      expect(page.customer).toMatchObject({ id: customers.primary, status: 'archived' });
      expect(page.outstandingMinor).toBe(CUSTOMER_OUTSTANDING);
      collected.push(...page.receivables);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toHaveLength(4);
    expect(new Set(collected.map((entry) => entry.id)).size).toBe(4);
    expect(collected[0]).toMatchObject({
      id: facts.openingId,
      entryType: 'opening_balance',
      originalAmountMinor: LARGE_OPENING,
      outstandingMinor: LARGE_OPENING,
      sale: null,
    });
    const partialReceivable = collected.find((entry) => entry.sale?.id === facts.partial.sale.id);
    expect(partialReceivable).toMatchObject({
      entryType: 'sale_credit',
      originalAmountMinor: '300',
    });
  });

  it('preserves bigint money and explicit zero without Number conversion', async () => {
    const detail = (await apiGet(`sales/${facts.large.sale.id}`).expect(200))
      .body as SaleDetailResponse;
    expect(detail.sale).toMatchObject({
      totalMinor: LARGE_SALE,
      paidTotalMinor: '0',
      receivableOriginatedMinor: LARGE_SALE,
      receivableOutstandingMinor: LARGE_SALE,
    });
    expect(detail.tenders).toEqual([]);
    expect(detail.receivable).toMatchObject({
      originalAmountMinor: LARGE_SALE,
      outstandingMinor: LARGE_SALE,
    });
  });

  it('requires owner authority while allowing operational reads for a read_only Store', async () => {
    await request(server).get('/v1/sales').expect(401);
    await apiGet('sales', manager).expect(403);
    const response = await apiGet('sales', readOnlyOwner).expect(200);
    expect(response.body).toMatchObject({
      items: [expect.objectContaining({ id: facts.readOnly.sale.id })],
      nextCursor: null,
    });
  });

  it('fails closed for cross-Store Sale, Receivable, and missing identifiers', async () => {
    const missingSale = await apiGet(`sales/${randomUUID()}`).expect(404);
    const foreignSale = await apiGet(`sales/${facts.foreign.sale.id}`).expect(404);
    const missingSaleBody = missingSale.body as unknown as {
      code: string;
      message: string;
      statusCode: number;
    };
    expect(foreignSale.body).toMatchObject({
      code: missingSaleBody.code,
      message: missingSaleBody.message,
      statusCode: missingSaleBody.statusCode,
    });
    await apiGet(`sales/${facts.partial.sale.id}`, foreignOwner).expect(404);

    const missingCustomer = await apiGet(`customers/${randomUUID()}/receivables`).expect(404);
    const foreignCustomer = await apiGet(`customers/${customers.foreign}/receivables`).expect(404);
    const missingCustomerBody = missingCustomer.body as unknown as {
      code: string;
      message: string;
      statusCode: number;
    };
    expect(foreignCustomer.body).toMatchObject({
      code: missingCustomerBody.code,
      message: missingCustomerBody.message,
      statusCode: missingCustomerBody.statusCode,
    });

    if (!runtimePool) throw new Error('S14.4 runtime pool is unavailable.');
    expect(
      (
        await runtimePool.query(
          `select
            (select count(*)::int from ledger.sales) as sales,
            (select count(*)::int from ledger.customer_ledger_entries) as receivables`,
        )
      ).rows[0],
    ).toEqual({ sales: 0, receivables: 0 });
  });

  it('binds Receivable cursors to the Customer and performs no business writes', async () => {
    const first = (
      await apiGet(`customers/${customers.primary}/receivables`).query({ limit: 1 }).expect(200)
    ).body as CustomerReceivableListResponse;
    expect(first.nextCursor).not.toBeNull();
    await apiGet(`customers/${customers.secondary}/receivables`)
      .query({ limit: 1, cursor: first.nextCursor })
      .expect(400);

    const before = await snapshotBusinessFacts();
    await apiGet('sales').query({ limit: 3 }).expect(200);
    await apiGet(`sales/${facts.partial.sale.id}`).expect(200);
    await apiGet(`customers/${customers.primary}/receivables`).query({ limit: 3 }).expect(200);
    await apiGet('sales', readOnlyOwner).expect(200);
    expect(await snapshotBusinessFacts()).toEqual(before);
  });
});
