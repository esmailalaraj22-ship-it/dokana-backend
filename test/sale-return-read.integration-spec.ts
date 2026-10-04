import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import type {
  SaleReturnDetailResponse,
  SaleReturnEligibilityResponse,
  SaleReturnListResponse,
} from '../src/returns/sale-return-read.types';
import type { SaleReturnPostingResponse } from '../src/returns/sale-return-posting.types';
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  token: string;
}

interface ProductFixture {
  productId: string;
  unitId: string;
}

interface Fixtures {
  restored: SaleReturnPostingResponse;
  newCredit: SaleReturnPostingResponse;
  anonymous: SaleReturnPostingResponse;
  inventory: SaleReturnPostingResponse;
  multipleSale: SalePostingResponse;
  multiple: SaleReturnPostingResponse[];
  foreign: SaleReturnPostingResponse;
  readOnly: SaleReturnPostingResponse;
  archivedCustomerId: string;
  archivedAccountId: string;
  knownProduct: ProductFixture;
  unknownProduct: ProductFixture;
  pendingProduct: ProductFixture;
}

const primaryStoreId = randomUUID();
const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s174-owner-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s174-manager-${randomUUID()}@example.test`,
    role: 'manager',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s174-foreign-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s174-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    token: '',
  },
];
const [owner, manager, foreignOwner, readOnlyOwner] = identities;

describe('S17.4 tenant-safe Return reads on isolated PostgreSQL', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let occurredAt: string;
  let periodId: string;
  let fixtures: Fixtures;
  let readBaseline: Record<string, string | null>;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S17.4 database is unavailable.');
    return database;
  }

  function authorized(identity: Identity = owner): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  function apiGet(path: string, identity: Identity = owner): request.Test {
    return request(server).get(`/v1/${path}`).set(authorized(identity));
  }

  async function createCustomer(identity: Identity = owner): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.customers(
        id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
      ) values($1,$2,$3,lower($3),$1::uuid::text,$1::uuid::text,'active',$4,$5)`,
      [id, identity.storeId, `S17.4 Customer ${id}`, identity.deviceId, randomUUID()],
    );
    return id;
  }

  async function createAccount(identity: Identity = owner): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
        id,store_id,name,normalized_name,account_type,availability,status,operation_id
      ) values($1,$2,$3,lower($3),'transfer','available','active',$4)`,
      [id, identity.storeId, `S17.4 Account ${id}`, randomUUID()],
    );
    return id;
  }

  async function createProduct(options: { allowNegative?: boolean } = {}): Promise<ProductFixture> {
    const productId = randomUUID();
    const unitId = randomUUID();
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,measurement_type,track_inventory,
        allow_negative_stock_override,status,operation_id
      ) values($1,$2,$3,lower($3),'count',true,$4,'active',$5)`,
      [
        productId,
        owner.storeId,
        `S17.4 Product ${productId}`,
        options.allowNegative ?? null,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,measurement_type,unit_name,is_base,
        factor_num,factor_den,sale_price_minor,status,operation_id
      ) values($1,$2,$3,'count','piece',true,1,1,100,'active',$4)`,
      [unitId, owner.storeId, productId, randomUUID()],
    );
    return { productId, unitId };
  }

  async function seedInventory(product: ProductFixture, costMinor?: string): Promise<void> {
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.unitId,
      selectedQuantityMilli: '5000',
      occurredAt,
    };
    if (costMinor !== undefined) body.totalPurchaseCostMinor = costMinor;
    await request(server).post('/v1/inventory/increase').set(authorized()).send(body).expect(201);
  }

  async function postSale(
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized(identity))
      .send(body)
      .expect(201);
    return response.body as SalePostingResponse;
  }

  function manualSale(input: {
    totalMinor: string;
    quantityMilli?: string;
    customerId?: string;
    accountId?: string;
    customerCreditAmountMinor?: string;
  }): Record<string, unknown> {
    const quantityMilli = input.quantityMilli ?? '1000';
    const unitPriceMinor = ((BigInt(input.totalMinor) * 1_000n) / BigInt(quantityMilli)).toString();
    return {
      operationId: randomUUID(),
      occurredAt,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      items: [
        {
          isManualLine: true,
          description: 'S17.4 immutable manual line',
          unitName: 'service',
          quantityMilli,
          unitPriceMinor,
          lineTotalMinor: input.totalMinor,
        },
      ],
      payments: input.accountId
        ? [{ moneyAccountId: input.accountId, amountMinor: input.totalMinor }]
        : [],
      ...(input.customerCreditAmountMinor
        ? { customerCreditAmountMinor: input.customerCreditAmountMinor }
        : {}),
      totalMinor: input.totalMinor,
    };
  }

  async function postReturn(
    sale: SalePostingResponse,
    lines: {
      saleItemId: string;
      quantityMilli: string;
      disposition: 'RESTOCK_SALEABLE' | 'DAMAGED_NO_RESTOCK';
    }[],
    residualSettlement?:
      { choice: 'REFUND'; moneyAccountId: string } | { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
    identity: Identity = owner,
  ): Promise<SaleReturnPostingResponse> {
    const response = await request(server)
      .post(`/v1/sales/${sale.sale.id}/return`)
      .set(authorized(identity))
      .send({
        operationId: randomUUID(),
        occurredAt,
        reason: 'S17.4 historical read fixture',
        lines,
        ...(residualSettlement ? { residualSettlement } : {}),
      })
      .expect(201);
    return response.body as SaleReturnPostingResponse;
  }

  async function insertCustomerCredit(customerId: string, amountMinor: string): Promise<void> {
    const entryId = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,$5,'customer_advance',$1,$6,$7,$8,$9)`,
      [
        entryId,
        owner.storeId,
        customerId,
        periodId,
        amountMinor,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
  }

  async function snapshotBusinessFacts(): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const table of [
      'ledger.sale_returns',
      'ledger.sale_return_items',
      'ledger.sale_return_settlements',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
      'ledger.sales',
      'sync.processed_operations',
      'sync.change_events',
      'audit.central_audit_logs',
    ]) {
      const row = (
        await db().admin.query<{ hash: string | null }>(
          `select md5(coalesce(string_agg(to_jsonb(t)::text, '' order by to_jsonb(t)::text), '')) as hash
           from ${table} t`,
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

    const clock = await db().admin.query<{ acceptedAt: string; businessDate: string }>(
      `select transaction_timestamp()::text as "acceptedAt",
              (transaction_timestamp() at time zone 'Asia/Hebron')::date::text as "businessDate"`,
    );
    const clockRow = clock.rows[0];
    if (!clockRow) throw new Error('PostgreSQL test clock is unavailable.');
    occurredAt = new Date(clockRow.acceptedAt).toISOString();
    const [yearText, monthText] = clockRow.businessDate.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const boundaries = resolveAccountingPeriodBoundaries(year, month);

    const uniqueStores = new Map<string, Identity>();
    for (const identity of identities) uniqueStores.set(identity.storeId, identity);
    for (const identity of uniqueStores.values()) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S17.4 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
      const id = deriveAccountingPeriodId(identity.storeId, year, month);
      await db().admin.query(
        `insert into ledger.accounting_periods(
          id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
        ) values($1,$2,$3,$4,$5,$6,'open',$7)`,
        [id, identity.storeId, year, month, boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
      if (identity.storeId === owner.storeId) periodId = id;
    }

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S17.4 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }

    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('S17.4 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s174-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s174-auth', 3);

    await upgradeInventoryTestDatabaseToCurrent(db(), [
      ...new Set(identities.map((identity) => identity.storeId)),
    ]);
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
          deviceName: 'S17.4 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const token = (login.body as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string') throw new Error('S17.4 login token is missing.');
      identity.token = token;
    }

    const accountId = await createAccount();

    const restoredCustomer = await createCustomer();
    await insertCustomerCredit(restoredCustomer, '100');
    const restoredSale = await postSale({
      ...manualSale({
        totalMinor: '300',
        customerId: restoredCustomer,
        customerCreditAmountMinor: '100',
      }),
      payments: [],
    });
    const restored = await postReturn(restoredSale, [
      {
        saleItemId: restoredSale.items[0]?.id ?? '',
        quantityMilli: '1000',
        disposition: 'DAMAGED_NO_RESTOCK',
      },
    ]);
    await postSale(
      manualSale({
        totalMinor: '100',
        customerId: restoredCustomer,
        customerCreditAmountMinor: '100',
      }),
    );

    const newCreditCustomer = await createCustomer();
    const newCreditSale = await postSale(
      manualSale({ totalMinor: '200', customerId: newCreditCustomer, accountId }),
    );
    const newCredit = await postReturn(
      newCreditSale,
      [
        {
          saleItemId: newCreditSale.items[0]?.id ?? '',
          quantityMilli: '1000',
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
    );
    await postSale(
      manualSale({
        totalMinor: '200',
        customerId: newCreditCustomer,
        customerCreditAmountMinor: '200',
      }),
    );

    const anonymousSale = await postSale(manualSale({ totalMinor: '500', accountId }));
    const anonymous = await postReturn(
      anonymousSale,
      [
        {
          saleItemId: anonymousSale.items[0]?.id ?? '',
          quantityMilli: '1000',
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      { choice: 'REFUND', moneyAccountId: accountId },
    );

    const knownProduct = await createProduct();
    const unknownProduct = await createProduct();
    const pendingProduct = await createProduct({ allowNegative: true });
    await seedInventory(knownProduct, '500');
    await seedInventory(unknownProduct);
    const archivedCustomerId = await createCustomer();
    const inventorySale = await postSale({
      operationId: randomUUID(),
      customerId: archivedCustomerId,
      occurredAt,
      items: [
        ...[knownProduct, unknownProduct, pendingProduct].map((product) => ({
          isManualLine: false,
          productId: product.productId,
          productUnitId: product.unitId,
          quantityMilli: '1000',
          unitPriceMinor: '100',
          lineTotalMinor: '100',
        })),
        {
          isManualLine: true,
          description: 'Manual historical product',
          unitName: 'service',
          quantityMilli: '1000',
          unitPriceMinor: '100',
          lineTotalMinor: '100',
        },
      ],
      payments: [{ moneyAccountId: accountId, amountMinor: '400' }],
      totalMinor: '400',
    });
    const inventory = await postReturn(
      inventorySale,
      inventorySale.items.map((item, index) => ({
        saleItemId: item.id,
        quantityMilli: item.quantityMilli,
        disposition: index < 2 ? ('RESTOCK_SALEABLE' as const) : ('DAMAGED_NO_RESTOCK' as const),
      })),
      { choice: 'REFUND', moneyAccountId: accountId },
    );

    const multipleSale = await postSale(
      manualSale({ totalMinor: '900', quantityMilli: '3000', accountId }),
    );
    const multiple = [
      await postReturn(
        multipleSale,
        [
          {
            saleItemId: multipleSale.items[0]?.id ?? '',
            quantityMilli: '1000',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
        { choice: 'REFUND', moneyAccountId: accountId },
      ),
      await postReturn(
        multipleSale,
        [
          {
            saleItemId: multipleSale.items[0]?.id ?? '',
            quantityMilli: '1000',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
        { choice: 'REFUND', moneyAccountId: accountId },
      ),
    ];

    const foreignAccount = await createAccount(foreignOwner);
    const foreignSale = await postSale(
      manualSale({ totalMinor: '111', accountId: foreignAccount }),
      foreignOwner,
    );
    const foreign = await postReturn(
      foreignSale,
      [
        {
          saleItemId: foreignSale.items[0]?.id ?? '',
          quantityMilli: '1000',
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      { choice: 'REFUND', moneyAccountId: foreignAccount },
      foreignOwner,
    );

    const readOnlyAccount = await createAccount(readOnlyOwner);
    const readOnlySale = await postSale(
      manualSale({ totalMinor: '222', accountId: readOnlyAccount }),
      readOnlyOwner,
    );
    const readOnly = await postReturn(
      readOnlySale,
      [
        {
          saleItemId: readOnlySale.items[0]?.id ?? '',
          quantityMilli: '1000',
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      { choice: 'REFUND', moneyAccountId: readOnlyAccount },
      readOnlyOwner,
    );

    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, archivedCustomerId],
    );
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id in ($2,$3,$4)`,
      [owner.storeId, knownProduct.productId, unknownProduct.productId, pendingProduct.productId],
    );
    await db().admin.query(
      `update ledger.product_units set status='archived'
       where store_id=$1 and id in ($2,$3,$4)`,
      [owner.storeId, knownProduct.unitId, unknownProduct.unitId, pendingProduct.unitId],
    );
    await db().admin.query(
      `update ledger.product_units set sale_price_minor=999999
       where store_id=$1 and id=$2`,
      [owner.storeId, knownProduct.unitId],
    );
    await db().admin.query(
      `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, accountId],
    );
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      readOnlyOwner.storeId,
    ]);

    fixtures = {
      restored,
      newCredit,
      anonymous,
      inventory,
      multipleSale,
      multiple,
      foreign,
      readOnly,
      archivedCustomerId,
      archivedAccountId: accountId,
      knownProduct,
      unknownProduct,
      pendingProduct,
    };
    readBaseline = await snapshotBusinessFacts();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      else await Promise.all([runtimePool?.end(), authPool?.end()]);
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

  it('lists Return roots with stable pagination and deterministic per-Sale history', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await apiGet(
        `returns?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ).expect(200);
      const page = response.body as SaleReturnListResponse;
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        expect(item.originalSale.displayNumber).toMatch(/^S-/);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(6);

    const history = (await apiGet(`sales/${fixtures.multipleSale.sale.id}/returns`).expect(200))
      .body as SaleReturnListResponse;
    expect(history.items.map((item) => item.id).sort()).toEqual(
      fixtures.multiple.map((item) => item.return.id).sort(),
    );
    expect(history.items.every((item) => item.totalMinor === '300')).toBe(true);
  });

  it('reads immutable Receivable, restored Credit, and new Credit effects after later Credit use', async () => {
    const restored = (await apiGet(`returns/${fixtures.restored.return.id}`).expect(200))
      .body as SaleReturnDetailResponse;
    expect(restored.settlementTrace).toMatchObject({
      receivableReduction: { amountMinor: '200' },
      restoredHistoricalCustomerCredit: { amountMinor: '100' },
      newCustomerCredit: null,
      moneyRefund: null,
      reconciliation: {
        returnTotalMinor: '300',
        settlementTotalMinor: '300',
        reconciled: true,
      },
    });

    const newCredit = (await apiGet(`returns/${fixtures.newCredit.return.id}`).expect(200))
      .body as SaleReturnDetailResponse;
    expect(newCredit.settlementTrace).toMatchObject({
      receivableReduction: null,
      restoredHistoricalCustomerCredit: null,
      newCustomerCredit: { amountMinor: '200' },
      moneyRefund: null,
    });
  });

  it('reads an anonymous refund from its own archived Money Account and Movement lineage', async () => {
    const detail = (await apiGet(`returns/${fixtures.anonymous.return.id}`).expect(200))
      .body as SaleReturnDetailResponse;
    expect(detail.return).toMatchObject({ customer: null, isAnonymous: true });
    expect(detail.settlementTrace).toMatchObject({
      receivableReduction: null,
      restoredHistoricalCustomerCredit: null,
      newCustomerCredit: null,
      moneyRefund: {
        amountMinor: '500',
        moneyAccount: { id: fixtures.archivedAccountId, status: 'archived' },
        moneyMovement: { amountDeltaMinor: '-500' },
      },
    });
  });

  it('preserves multi-line disposition, exact inventory effects, cost states, and archived catalog history', async () => {
    const detail = (await apiGet(`returns/${fixtures.inventory.return.id}`).expect(200))
      .body as SaleReturnDetailResponse;
    expect(detail.return.customer).toMatchObject({
      id: fixtures.archivedCustomerId,
      status: 'archived',
    });
    expect(detail.lines).toHaveLength(4);
    expect(detail.lines.map((line) => line.historicalCost.state).sort()).toEqual([
      'known',
      'pending',
      'unknown',
      'unknown',
    ]);
    const known = detail.lines.find((line) => line.productId === fixtures.knownProduct.productId);
    const unknown = detail.lines.find(
      (line) => line.productId === fixtures.unknownProduct.productId,
    );
    const pending = detail.lines.find(
      (line) => line.productId === fixtures.pendingProduct.productId,
    );
    const manual = detail.lines.find((line) => line.isManualLine);
    expect(known).toMatchObject({
      currentProductStatus: 'archived',
      currentProductUnitStatus: 'archived',
      disposition: 'RESTOCK_SALEABLE',
      inventoryQuantityEffectMilli: '1000',
      historicalReturnValueMinor: '100',
      historicalCost: { returnedCostMinor: '100', cogsReversalMinor: '100' },
    });
    expect(unknown).toMatchObject({
      disposition: 'RESTOCK_SALEABLE',
      inventoryQuantityEffectMilli: '1000',
      historicalCost: { state: 'unknown', returnedCostMinor: null },
    });
    expect(pending).toMatchObject({
      disposition: 'DAMAGED_NO_RESTOCK',
      inventoryQuantityEffectMilli: '0',
      historicalCost: { state: 'pending', returnedCostMinor: null },
    });
    expect(manual).toMatchObject({
      isManualLine: true,
      inventoryQuantityEffectMilli: '0',
    });
  });

  it('derives exact cumulative remaining quantity/value and ignores current catalog price', async () => {
    const response = (
      await apiGet(`sales/${fixtures.multipleSale.sale.id}/return-eligibility`).expect(200)
    ).body as SaleReturnEligibilityResponse;
    expect(response).toMatchObject({
      sale: { id: fixtures.multipleSale.sale.id, activeLeaf: true },
      returnWindowOpen: true,
      currentlyReturnable: true,
      totalRemainingReturnableValueMinor: '300',
      lines: [
        {
          originalQuantityMilli: '3000',
          returnedQuantityMilli: '2000',
          remainingQuantityMilli: '1000',
          historicalNetValueMinor: '900',
          returnedHistoricalValueMinor: '600',
          remainingHistoricalValueMinor: '300',
        },
      ],
    });
  });

  it('fails closed across Stores and actor roles while allowing reads in read_only', async () => {
    await apiGet(`returns/${fixtures.foreign.return.id}`).expect(404);
    await apiGet(`sales/${fixtures.foreign.return.saleId}/returns`).expect(200, {
      items: [],
      nextCursor: null,
    });
    await apiGet(`returns/${fixtures.anonymous.return.id}`, manager).expect(403);
    await apiGet(`returns/${fixtures.readOnly.return.id}`, readOnlyOwner).expect(200);
    await apiGet('returns', readOnlyOwner).expect(200);
  });

  it('rejects malformed, missing-anchor, and cross-scope cursors without leaking foreign data', async () => {
    await apiGet('returns?cursor=not-valid').expect(400);
    const first = (await apiGet('returns?limit=1').expect(200)).body as SaleReturnListResponse;
    expect(first.nextCursor).not.toBeNull();
    await apiGet(
      `sales/${fixtures.multipleSale.sale.id}/returns?cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    ).expect(400);
    const missingCursor = Buffer.from(
      JSON.stringify([1, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', randomUUID(), '1']),
      'utf8',
    ).toString('base64url');
    await apiGet(`returns?cursor=${encodeURIComponent(missingCursor)}`).expect(400);
  });

  it('performs repeated operational reads with zero business side effects', async () => {
    for (let index = 0; index < 3; index += 1) {
      await apiGet('returns?limit=100').expect(200);
      await apiGet(`returns/${fixtures.inventory.return.id}`).expect(200);
      await apiGet(`sales/${fixtures.multipleSale.sale.id}/returns`).expect(200);
      await apiGet(`sales/${fixtures.multipleSale.sale.id}/return-eligibility`).expect(200);
    }
    expect(await snapshotBusinessFacts()).toEqual(readBaseline);
  });
});
