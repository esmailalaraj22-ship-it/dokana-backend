import { randomUUID } from 'node:crypto';
import { captureReplayEvidence } from './stage3b-replay-evidence';
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
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
  upgradeInventoryTestDatabaseToCurrent,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const saleInstant = '2026-08-15T10:00:00Z';

interface Identity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  role: 'owner' | 'manager';
  storeStatus: 'active' | 'read_only';
  token: string;
}

interface ProductFixture {
  productId: string;
  unitId: string;
}

const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s143-owner-a-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s143-owner-b-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s143-manager-${randomUUID()}@example.test`,
    role: 'manager',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s143-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'read_only',
    token: '',
  },
];
const owner = identities[0];
const foreignOwner = identities[1];
const manager = identities[2];
const readOnlyOwner = identities[3];

describe('S14.3 Sale posting and receivable origination on isolated PostgreSQL', () => {
  jest.setTimeout(240_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  const customers = {
    primary: randomUUID(),
    secondary: randomUUID(),
    archived: randomUUID(),
    foreign: randomUUID(),
  };

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S14.3 database is unavailable.');
    return database;
  }

  function postSale(body: Record<string, unknown>, identity: Identity = owner): request.Test {
    return request(server)
      .post('/v1/sales')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function postOpening(
    customerId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/customers/${customerId}/opening-receivables`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function manualSale(
    accountId: string | null,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      occurredAt: saleInstant,
      items: [
        {
          isManualLine: true,
          description: 'Manual service',
          unitName: 'service',
          quantityMilli: '1000',
          unitPriceMinor: '500',
          lineTotalMinor: '500',
        },
      ],
      payments: accountId === null ? [] : [{ moneyAccountId: accountId, amountMinor: '500' }],
      totalMinor: '500',
      ...overrides,
    };
  }

  function productSale(
    product: ProductFixture,
    accountId: string | null,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      occurredAt: saleInstant,
      items: [
        {
          isManualLine: false,
          productId: product.productId,
          productUnitId: product.unitId,
          quantityMilli: '1000',
          unitPriceMinor: '500',
          lineTotalMinor: '500',
        },
      ],
      payments: accountId === null ? [] : [{ moneyAccountId: accountId, amountMinor: '500' }],
      totalMinor: '500',
      ...overrides,
    };
  }

  async function createAccount(
    identity: Identity = owner,
    state: {
      status?: 'active' | 'archived';
      availability?: 'available' | 'held_by_external_party';
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = state.status ?? 'active';
    await db().admin.query(
      `insert into ledger.money_accounts(
        id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,'transfer',$3,$4,
        case when $4='archived' then clock_timestamp() else null end,$5)`,
      [id, identity.storeId, state.availability ?? 'available', status, randomUUID()],
    );
    return id;
  }

  async function createProduct(
    options: {
      identity?: Identity;
      tracked?: boolean;
      allowNegative?: boolean | null;
      factorNum?: number;
      factorDen?: number;
      productStatus?: 'active' | 'archived';
      unitStatus?: 'active' | 'archived';
    } = {},
  ): Promise<ProductFixture> {
    const identity = options.identity ?? owner;
    const productId = randomUUID();
    const unitId = randomUUID();
    const productStatus = options.productStatus ?? 'active';
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,measurement_type,track_inventory,
        allow_negative_stock_override,status,archived_at,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,'count',$3,$4,$5,
        case when $5='archived' then clock_timestamp() else null end,$6)`,
      [
        productId,
        identity.storeId,
        options.tracked ?? true,
        options.allowNegative ?? null,
        productStatus,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,measurement_type,unit_name,is_base,
        factor_num,factor_den,status,operation_id
      ) values($1,$2,$3,'count',$1::uuid::text,false,$4,$5,$6,$7)`,
      [
        unitId,
        identity.storeId,
        productId,
        options.factorNum ?? 1,
        options.factorDen ?? 1,
        options.unitStatus ?? 'active',
        randomUUID(),
      ],
    );
    return { productId, unitId };
  }

  async function seedInventory(
    product: ProductFixture,
    selectedQuantityMilli: string,
    totalPurchaseCostMinor?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.unitId,
      selectedQuantityMilli,
      occurredAt: saleInstant,
    };
    if (totalPurchaseCostMinor !== undefined) body.totalPurchaseCostMinor = totalPurchaseCostMinor;
    await request(server)
      .post('/v1/inventory/increase')
      .set('authorization', `Bearer ${owner.token}`)
      .send(body)
      .expect(201);
  }

  async function factCounts(operationId: string): Promise<Record<string, number>> {
    const row = (
      await db().admin.query<Record<string, number>>(
        `select
          (select count(*)::int from ledger.sales where store_id=$1 and operation_id=$2) as sales,
          (select count(*)::int from ledger.sale_items i join ledger.sales s
             on s.store_id=i.store_id and s.id=i.sale_id
             where s.store_id=$1 and s.operation_id=$2) as items,
          (select count(*)::int from ledger.sale_payments p join ledger.sales s
             on s.store_id=p.store_id and s.id=p.sale_id
             where s.store_id=$1 and s.operation_id=$2) as payments,
          (select count(*)::int from ledger.money_movements
             where store_id=$1 and transaction_group_id=$2) as "moneyMovements",
          (select count(*)::int from ledger.inventory_movements
             where store_id=$1 and transaction_group_id=$2) as "inventoryMovements",
          (select count(*)::int from ledger.customer_ledger_entries
             where store_id=$1 and transaction_group_id=$2) as receivables,
          (select count(*)::int from sync.processed_operations
             where store_id=$1 and operation_id=$2) as operations`,
        [owner.storeId, operationId],
      )
    ).rows[0];
    if (!row) throw new Error('S14.3 fact counts are missing.');
    return row;
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
      throw new Error('S14.3 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s143-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s143-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S14.3 fixture',$2)`,
        [identity.storeId, identity.storeStatus],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S14.3 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }

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
          deviceName: 'S14.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S14.3 login token is missing.');
      identity.token = body.accessToken;
    }

    for (const [customerId, identity, status] of [
      [customers.primary, owner, 'active'],
      [customers.secondary, owner, 'active'],
      [customers.archived, owner, 'archived'],
      [customers.foreign, foreignOwner, 'active'],
    ] as const) {
      await db().admin.query(
        `insert into ledger.customers(
          id,store_id,name,normalized_name,phone,normalized_phone,status,archived_at,
          device_id,operation_id
        ) values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,$3,
          case when $3='archived' then clock_timestamp() else null end,$4,$5)`,
        [customerId, identity.storeId, status, identity.deviceId, randomUUID()],
      );
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

  it('posts an anonymous paid tracked Sale with server totals, exact money, conversion, and known COGS', async () => {
    const accountId = await createAccount();
    const product = await createProduct({ factorNum: 2 });
    await seedInventory(product, '5000', '1000');
    const body = productSale(product, accountId, {
      items: [
        {
          isManualLine: false,
          productId: product.productId,
          productUnitId: product.unitId,
          quantityMilli: '1000',
          unitPriceMinor: '500',
          lineDiscountMinor: '1',
          lineTotalMinor: '499',
        },
      ],
      invoiceDiscountMinor: '1',
      totalMinor: '498',
      payments: [{ moneyAccountId: accountId, amountMinor: '498' }],
    });
    const result = await postSale(body).expect(201);
    const response = result.body as SalePostingResponse;
    expect(response.sale).toMatchObject({
      customerId: null,
      status: 'posted',
      paymentStatus: 'paid',
      itemsSubtotalMinor: '500',
      lineDiscountTotalMinor: '1',
      invoiceDiscountMinor: '1',
      totalMinor: '498',
      paidTotalMinor: '498',
      creditTotalMinor: '0',
      knownCostTotalMinor: '200',
      pendingCostLineCount: 0,
      unknownCostLineCount: 0,
    });
    expect(response.items[0]).toMatchObject({
      baseQuantityMilli: '2000',
      costStatus: 'known',
      unitCostMinor: '100',
      lineCostMinor: '200',
    });
    expect(response.receivable).toBeNull();
    expect(
      (
        await db().admin.query(
          `select b.quantity_milli::text as quantity, b.inventory_value_minor::text as value,
                  m.quantity_delta_milli::text as delta, m.value_delta_minor::text as "valueDelta"
           from ledger.stock_balances b join ledger.inventory_movements m
             on m.store_id=b.store_id and m.id=b.last_movement_id
           where b.store_id=$1 and b.product_id=$2`,
          [owner.storeId, product.productId],
        )
      ).rows[0],
    ).toEqual({ quantity: '8000', value: '800', delta: '-2000', valueDelta: '-200' });
    expect(
      (
        await db().admin.query(
          `select coalesce(sum(amount_delta_minor),0)::text as amount
           from ledger.money_movements where store_id=$1 and transaction_group_id=$2`,
          [owner.storeId, body.operationId],
        )
      ).rows[0],
    ).toEqual({ amount: '498' });
    expect(await factCounts(body.operationId as string)).toEqual({
      sales: 1,
      items: 1,
      payments: 1,
      moneyMovements: 1,
      inventoryMovements: 1,
      receivables: 0,
      operations: 1,
    });
    const factIds = [
      response.sale.id,
      response.items[0]?.id,
      response.items[0]?.inventoryMovementId,
      response.payments[0]?.id,
      response.payments[0]?.moneyMovementId,
    ].filter((value): value is string => typeof value === 'string');
    expect(
      (
        await db().admin.query(
          `select
             (select count(distinct entity_id)::int from audit.central_audit_logs
                where store_id=$1 and entity_id=any($2::uuid[])) as audit,
             (select count(distinct entity_id)::int from sync.change_events
                where store_id=$1 and entity_id=any($2::uuid[])) as changes`,
          [owner.storeId, factIds],
        )
      ).rows[0],
    ).toEqual({ audit: 2, changes: 2 });
  });

  it('posts a Customer split-tender Sale with untracked and manual lines but no inventory movement', async () => {
    const [accountA, accountB] = await Promise.all([createAccount(), createAccount()]);
    const product = await createProduct({ tracked: false });
    const body = {
      operationId: randomUUID(),
      customerId: customers.primary,
      occurredAt: saleInstant,
      items: [
        {
          isManualLine: false,
          productId: product.productId,
          productUnitId: product.unitId,
          quantityMilli: '1000',
          unitPriceMinor: '200',
        },
        {
          isManualLine: true,
          description: 'Service',
          quantityMilli: '1000',
          unitPriceMinor: '300',
        },
      ],
      payments: [
        { moneyAccountId: accountB, amountMinor: '300' },
        { moneyAccountId: accountA, amountMinor: '200' },
      ],
      totalMinor: '500',
    };
    const result = await postSale(body).expect(201);
    const response = result.body as SalePostingResponse;
    expect(response.sale).toMatchObject({
      customerId: customers.primary,
      paymentStatus: 'paid',
      paidTotalMinor: '500',
      creditTotalMinor: '0',
      knownCostTotalMinor: '0',
      unknownCostLineCount: 2,
    });
    expect(response.payments.map((payment) => payment.moneyAccountId)).toEqual(
      [accountA, accountB].sort(),
    );
    expect(response.items.every((item) => item.inventoryMovementId === null)).toBe(true);
    expect(response.receivable).toBeNull();
    expect(await factCounts(body.operationId)).toMatchObject({
      sales: 1,
      items: 2,
      payments: 2,
      moneyMovements: 2,
      inventoryMovements: 0,
      receivables: 0,
    });
  });

  it('originates the exact remaining Customer receivable for partial and credit Sales', async () => {
    const accountId = await createAccount();
    const partial = manualSale(accountId, {
      customerId: customers.primary,
      payments: [{ moneyAccountId: accountId, amountMinor: '200' }],
    });
    const partialResult = await postSale(partial).expect(201);
    expect(partialResult.body).toMatchObject({
      sale: { paymentStatus: 'partial', paidTotalMinor: '200', creditTotalMinor: '300' },
      receivable: {
        customerId: customers.primary,
        entryType: 'sale_credit',
        receivableDeltaMinor: '300',
        creditDeltaMinor: '0',
      },
    });

    const credit = manualSale(null, { customerId: customers.primary });
    const creditResult = await postSale(credit).expect(201);
    expect(creditResult.body).toMatchObject({
      sale: { paymentStatus: 'credit', paidTotalMinor: '0', creditTotalMinor: '500' },
      payments: [],
      receivable: { entryType: 'sale_credit', receivableDeltaMinor: '500' },
    });
  });

  it('rejects anonymous debt, overpayment, missing required price, and zero total before claiming', async () => {
    const accountId = await createAccount();
    const invalid = [
      manualSale(null),
      manualSale(accountId, {
        payments: [{ moneyAccountId: accountId, amountMinor: '501' }],
      }),
      manualSale(accountId, {
        items: [{ isManualLine: true, description: 'Missing price', quantityMilli: '1000' }],
      }),
      manualSale(null, {
        customerId: customers.primary,
        items: [
          {
            isManualLine: true,
            description: 'Zero total',
            quantityMilli: '1000',
            unitPriceMinor: '0',
          },
        ],
        totalMinor: '0',
      }),
    ];
    for (const body of invalid) {
      await postSale(body).expect(400);
      expect(await factCounts(body.operationId as string)).toEqual({
        sales: 0,
        items: 0,
        payments: 0,
        moneyMovements: 0,
        inventoryMovements: 0,
        receivables: 0,
        operations: 0,
      });
    }
  });

  it('fails closed for unavailable and cross-store Money Accounts', async () => {
    const unavailable = await createAccount(owner, { status: 'archived' });
    const foreign = await createAccount(foreignOwner);
    for (const [accountId, status, code] of [
      [unavailable, 409, 'MONEY_ACCOUNT_UNAVAILABLE'],
      [foreign, 404, 'MONEY_ACCOUNT_NOT_FOUND'],
    ] as const) {
      const body = manualSale(accountId);
      const result = await postSale(body).expect(status);
      expect(result.body).toMatchObject({ code });
      expect(await factCounts(body.operationId as string)).toMatchObject({
        sales: 0,
        moneyMovements: 0,
        operations: 1,
      });
    }
  });

  it('enforces the locked Customer credit policy without partial Sale facts', async () => {
    const customerId = randomUUID();
    await db().admin.query(
      `insert into ledger.customers(
        id,store_id,name,normalized_name,phone,normalized_phone,
        credit_policy,credit_limit_minor,device_id,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,
        'block',400,$3,$4)`,
      [customerId, owner.storeId, owner.deviceId, randomUUID()],
    );
    const body = manualSale(null, { customerId });
    expect((await postSale(body).expect(409)).body).toMatchObject({
      code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
    });
    expect(await factCounts(body.operationId as string)).toMatchObject({
      sales: 0,
      moneyMovements: 0,
      inventoryMovements: 0,
      receivables: 0,
      operations: 1,
    });
  });

  it('posts a bigint Customer opening receivable with no Sale, money, inventory, or COGS effect', async () => {
    const operationId = randomUUID();
    const result = await postOpening(customers.primary, {
      operationId,
      amountMinor: '9007199254740993',
      occurredAt: saleInstant,
      notes: 'Imported opening debt',
    }).expect(201);
    expect(result.body).toMatchObject({
      operationId,
      customerId: customers.primary,
      receivable: {
        entryType: 'opening_balance',
        receivableDeltaMinor: '9007199254740993',
        sourceSaleId: null,
      },
    });
    expect(await factCounts(operationId)).toEqual({
      sales: 0,
      items: 0,
      payments: 0,
      moneyMovements: 0,
      inventoryMovements: 0,
      receivables: 1,
      operations: 1,
    });
  });

  it('preserves UNKNOWN and PENDING tracked cost without fabricating known zero COGS', async () => {
    const unknown = await createProduct();
    await seedInventory(unknown, '2000');
    const unknownSale = productSale(unknown, null, { customerId: customers.primary });
    const unknownResult = await postSale(unknownSale).expect(201);
    expect(unknownResult.body).toMatchObject({
      sale: { knownCostTotalMinor: '0', pendingCostLineCount: 0, unknownCostLineCount: 1 },
      items: [{ costStatus: 'unknown', unitCostMinor: null, lineCostMinor: null }],
    });

    const pending = await createProduct({ allowNegative: true });
    const accountId = await createAccount();
    const pendingSale = productSale(pending, accountId);
    const pendingResult = await postSale(pendingSale).expect(201);
    expect(pendingResult.body).toMatchObject({
      sale: { knownCostTotalMinor: '0', pendingCostLineCount: 1, unknownCostLineCount: 0 },
      items: [{ costStatus: 'pending', unitCostMinor: null, lineCostMinor: null }],
    });
    expect(
      (
        await db().admin.query(
          `select quantity_milli::text as quantity, cost_state as state,
                  inventory_value_minor::text as value
           from ledger.stock_balances where store_id=$1 and product_id=$2`,
          [owner.storeId, pending.productId],
        )
      ).rows[0],
    ).toEqual({ quantity: '-1000', state: 'pending', value: '0' });
  });

  it('rejects forbidden negative stock atomically after the draft Sale was attempted', async () => {
    const product = await createProduct({ allowNegative: false });
    const accountId = await createAccount();
    const body = productSale(product, accountId);
    const result = await postSale(body).expect(409);
    expect(result.body).toMatchObject({ code: 'SALE_NEGATIVE_STOCK_NOT_ALLOWED' });
    expect(await factCounts(body.operationId as string)).toEqual({
      sales: 0,
      items: 0,
      payments: 0,
      moneyMovements: 0,
      inventoryMovements: 0,
      receivables: 0,
      operations: 1,
    });
  });

  it('rejects closed periods and archived/cross-store Customer or Product references', async () => {
    const boundaries = resolveAccountingPeriodBoundaries(2026, 9);
    await db().admin.query(
      `insert into ledger.accounting_periods(
        id,store_id,period_year,period_month,starts_at,ends_at,status,closed_at,operation_id
      ) values($1,$2,2026,9,$3,$4,'closed',clock_timestamp(),$5)`,
      [
        deriveAccountingPeriodId(owner.storeId, 2026, 9),
        owner.storeId,
        boundaries.startsAt,
        boundaries.endsAt,
        randomUUID(),
      ],
    );
    const closed = manualSale(null, {
      customerId: customers.primary,
      occurredAt: '2026-09-15T10:00:00Z',
    });
    expect((await postSale(closed).expect(409)).body).toMatchObject({
      code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    });

    const accountId = await createAccount();
    for (const customerId of [customers.archived, customers.foreign]) {
      const body = manualSale(null, { customerId });
      const response = await postSale(body).expect(customerId === customers.archived ? 409 : 404);
      expect(response.body).toMatchObject({
        code: customerId === customers.archived ? 'CUSTOMER_UNAVAILABLE' : 'CUSTOMER_NOT_FOUND',
      });
    }
    const archivedProduct = await createProduct({ productStatus: 'archived' });
    const archivedUnit = await createProduct({ unitStatus: 'archived' });
    const foreignProduct = await createProduct({ identity: foreignOwner });
    for (const [product, status, code] of [
      [archivedProduct, 409, 'PRODUCT_UNAVAILABLE'],
      [archivedUnit, 409, 'PRODUCT_UNIT_UNAVAILABLE'],
      [foreignProduct, 404, 'PRODUCT_NOT_FOUND'],
    ] as const) {
      const response = await postSale(productSale(product, accountId)).expect(status);
      expect(response.body).toMatchObject({ code });
    }
  });

  it('Stage 3B B03 replays exactly across tender order and conflicts on a changed material request', async () => {
    const [accountA, accountB] = await Promise.all([createAccount(), createAccount()]);
    const body = manualSale(accountA, {
      customerId: customers.primary,
      payments: [
        { moneyAccountId: accountB, amountMinor: '300' },
        { moneyAccountId: accountA, amountMinor: '200' },
      ],
    });
    const first = await postSale(body).expect(201);
    const reordered = {
      ...body,
      payments: [...(body.payments as Record<string, unknown>[])].reverse(),
    };
    const replay = await postSale(reordered).expect(201);
    expect(replay.body).toEqual(first.body);
    const changed = {
      ...body,
      payments: [
        { moneyAccountId: accountA, amountMinor: '199' },
        { moneyAccountId: accountB, amountMinor: '300' },
      ],
    };
    expect((await postSale(changed).expect(409)).body).toMatchObject({
      code: 'OPERATION_ID_CONFLICT',
    });
    expect(await factCounts(body.operationId as string)).toMatchObject({
      sales: 1,
      payments: 2,
      moneyMovements: 2,
      operations: 1,
    });
  });

  it('Stage 3B B03 binds quantity, price, discounts, customer and semantic instant without second facts', async () => {
    const line = {
      isManualLine: true,
      description: 'Canonical review Sale',
      unitName: 'service',
      quantityMilli: '1000',
      unitPriceMinor: '500',
    };
    const body = {
      operationId: randomUUID(),
      occurredAt: saleInstant,
      customerId: customers.primary,
      items: [line],
      payments: [],
    };
    const first = await postSale(body).expect(201);
    const tables = [
      'ledger.sales',
      'ledger.sale_items',
      'ledger.sale_payments',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
    ];
    const before = await captureReplayEvidence(db().admin, owner.storeId, tables);
    const equivalent = {
      ...body,
      operationId: body.operationId.toUpperCase(),
      customerId: body.customerId.toUpperCase(),
      occurredAt: new Date(saleInstant).toISOString(),
      items: [{ ...line, lineDiscountMinor: '0' }],
      invoiceDiscountMinor: '0',
      roundingMinor: '0',
    };
    expect((await postSale(equivalent).expect(201)).body).toEqual(first.body);
    for (const changed of [
      { ...body, items: [{ ...line, quantityMilli: '2000' }] },
      { ...body, items: [{ ...line, unitPriceMinor: '501' }] },
      { ...body, items: [{ ...line, lineDiscountMinor: '1' }] },
      { ...body, invoiceDiscountMinor: '1' },
      { ...body, customerId: customers.secondary },
      { ...body, occurredAt: new Date(Date.parse(saleInstant) + 60_000).toISOString() },
    ]) {
      expect((await postSale(changed).expect(409)).body).toMatchObject({
        code: 'OPERATION_ID_CONFLICT',
      });
      const after = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of [...tables, 'sync.processed_operations'])
        expect(after[table]).toEqual(before[table]);
    }
    expect(await factCounts(body.operationId)).toMatchObject({
      sales: 1,
      payments: 0,
      moneyMovements: 0,
      operations: 1,
    });
  });

  it('Stage 3B B01 Sale serializes duplicate operation IDs and concurrent tracked Sales without duplicate effects', async () => {
    const accountId = await createAccount();
    const duplicate = manualSale(accountId);
    const duplicateResults = await Promise.all([postSale(duplicate), postSale(duplicate)]);
    expect(duplicateResults.map((result) => result.status)).toEqual([201, 201]);
    expect(duplicateResults[0].body).toEqual(duplicateResults[1].body);
    expect(await factCounts(duplicate.operationId as string)).toMatchObject({
      sales: 1,
      payments: 1,
      moneyMovements: 1,
    });

    const product = await createProduct();
    await seedInventory(product, '2000', '200');
    const first = productSale(product, null, { customerId: customers.primary });
    const second = productSale(product, null, { customerId: customers.secondary });
    const results = await Promise.all([postSale(first), postSale(second)]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    const tables = [
      'ledger.sales',
      'ledger.sale_items',
      'ledger.sale_payments',
      'ledger.sale_customer_credit_applications',
      'ledger.customer_ledger_entries',
      'ledger.money_movements',
      'ledger.inventory_movements',
      'ledger.stock_balances',
    ];
    const beforeReplay = await captureReplayEvidence(db().admin, owner.storeId, tables);
    expect((await postSale(first).expect(201)).body).toEqual(results[0].body);
    expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(beforeReplay);
    expect(
      (
        await db().admin.query(
          `select quantity_milli::text as quantity, inventory_value_minor::text as value
           from ledger.stock_balances where store_id=$1 and product_id=$2`,
          [owner.storeId, product.productId],
        )
      ).rows[0],
    ).toEqual({ quantity: '0', value: '0' });
  });

  // Stage 4A uses this existing isolated, fully migrated HTTP fixture. The
  // assertions compare PostgreSQL JSON text, preserving bigint precision.
  const stage4HistoryTables = [
    'ledger.sales',
    'ledger.sale_items',
    'ledger.sale_payments',
    'ledger.customer_ledger_entries',
    'ledger.customer_payments',
    'ledger.customer_payment_allocations',
    'ledger.supplier_ledger_entries',
    'ledger.purchase_invoices',
    'ledger.purchase_items',
    'ledger.supplier_payments',
    'ledger.supplier_payment_allocations',
    'ledger.owner_ledger_entries',
    'ledger.expenses',
    'ledger.money_movements',
    'ledger.inventory_movements',
    'ledger.manual_inventory_entries',
    'ledger.stock_balances',
    'ledger.accounting_periods',
  ];

  async function stage4Evidence(): Promise<Record<string, string[]>> {
    return captureReplayEvidence(db().admin, owner.storeId, stage4HistoryTables);
  }

  async function stage4Preserved(before: Record<string, string[]>): Promise<void> {
    const after = await stage4Evidence();
    for (const table of stage4HistoryTables) expect(after[table]).toEqual(before[table]);
    // New commands append operations/audit/events; no pre-existing row may change.
    for (const table of Object.keys(before).filter((key) => !stage4HistoryTables.includes(key))) {
      expect(after[table]).toEqual(expect.arrayContaining(before[table] ?? []));
    }
  }

  async function stage4Row(table: string, id: string): Promise<Record<string, unknown>> {
    if (
      ![
        'products',
        'product_units',
        'customers',
        'suppliers',
        'money_accounts',
        'app_settings',
      ].includes(table)
    )
      throw new Error('Invalid Stage 4A master table');
    const key = table === 'app_settings' ? 'store_id' : 'id';
    const row = (
      await db().admin.query<{ value: Record<string, unknown> }>(
        `select to_jsonb(t) || jsonb_build_object('version', version::text) as value
       from ledger.${table} t where ${key}=$1`,
        [id],
      )
    ).rows[0]?.value;
    if (!row) throw new Error('Stage 4A master is missing');
    return row;
  }

  function stage4Http(method: 'get' | 'post' | 'patch' | 'delete', path: string): request.Test {
    return request(server)[method](`/v1/${path}`).set('authorization', `Bearer ${owner.token}`);
  }

  async function stage4Patch(
    table: string,
    id: string,
    path: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const row = await stage4Row(table, id);
    await stage4Http('patch', path)
      .send({ operationId: randomUUID(), expectedVersion: row.version, ...fields })
      .expect(200);
  }

  it('S4A2-01 preserves full posted history, unknown versus zero, and rejects structural master changes', async () => {
    const account = await createAccount();
    for (const cost of ['1000', '0', undefined, 'pending', 'estimated'] as const) {
      const product = await createProduct({ factorNum: 2, allowNegative: cost === 'pending' });
      if (cost !== 'pending')
        await seedInventory(product, '5000', cost === 'estimated' ? '1000' : cost);
      const posted = (await postSale(productSale(product, account)).expect(201))
        .body as SalePostingResponse;
      expect(posted.items[0]).toMatchObject(
        cost === undefined
          ? { costStatus: 'unknown', unitCostMinor: null, lineCostMinor: null }
          : cost === 'pending'
            ? { costStatus: 'pending', unitCostMinor: null, lineCostMinor: null }
            : { costStatus: 'known', lineCostMinor: cost === '0' ? '0' : '200' },
      );
      if (cost === 'estimated') {
        // Compatibility fixture: the schema accepts estimated historical items,
        // but the current Sale producer emits only known/unknown/pending.
        // Prepare this state BEFORE the preservation boundary, never as remediation.
        await db().admin.query(
          "update ledger.sale_items set cost_status='estimated' where store_id=$1 and sale_id=$2",
          [owner.storeId, posted.sale.id],
        );
        expect(
          (
            await db().admin.query('select cost_status from ledger.sale_items where sale_id=$1', [
              posted.sale.id,
            ])
          ).rows,
        ).toEqual([{ cost_status: 'estimated' }]);
      }
      const before = await stage4Evidence();
      await stage4Patch('products', product.productId, `products/${product.productId}`, {
        name: `Renamed ${product.productId}`,
        sku: `sku-${product.productId}`,
        description: 'Edited catalog',
      });
      await stage4Patch('product_units', product.unitId, `products/units/${product.unitId}`, {
        unitName: 'Renamed pack',
        unitCode: 'PACK',
        salePriceMinor: '9876',
        purchasePriceMinor: '0',
      });
      await stage4Preserved(before);
      await stage4Patch('product_units', product.unitId, `products/units/${product.unitId}`, {
        salePriceMinor: null,
        purchasePriceMinor: null,
      });
      await stage4Preserved(before);
      const master = await stage4Row('products', product.productId);
      const unit = await stage4Row('product_units', product.unitId);
      expect(master.name).toBe(`Renamed ${product.productId}`);
      expect(unit).toMatchObject({
        unit_name: 'Renamed pack',
        sale_price_minor: null,
        purchase_price_minor: null,
      });
      const beforeInvalid = await stage4Evidence();
      for (const fields of [{ measurementType: 'weight' }, { trackInventory: false }]) {
        await stage4Http('patch', `products/${product.productId}`)
          .send({
            operationId: randomUUID(),
            expectedVersion: master.version,
            ...fields,
          })
          .expect(400);
      }
      for (const fields of [
        { productId: randomUUID() },
        { isBase: true },
        { factorNum: 7 },
        { factorDen: 3 },
        { measurementType: 'weight' },
      ]) {
        await stage4Http('patch', `products/units/${product.unitId}`)
          .send({
            operationId: randomUUID(),
            expectedVersion: unit.version,
            ...fields,
          })
          .expect(400);
      }
      expect(await stage4Row('products', product.productId)).toEqual(master);
      expect(await stage4Row('product_units', product.unitId)).toEqual(unit);
      expect(await stage4Evidence()).toEqual(beforeInvalid);
      await stage4Preserved(before);
    }
  });

  let stage4Phone = 1000000;
  async function stage4Party(
    kind: 'customers' | 'suppliers',
  ): Promise<{ id: string; phone: string }> {
    const id = randomUUID();
    const phone = `059${String(++stage4Phone)}`;
    await stage4Http('post', kind)
      .send({ id, operationId: randomUUID(), name: `Stage 4A ${id}`, phone })
      .expect(201);
    return { id, phone };
  }

  async function stage4Lifecycle(
    table: string,
    id: string,
    path: string,
    action: 'archive' | 'restore',
    status = 200,
    code?: string,
  ): Promise<void> {
    const row = await stage4Row(table, id);
    const result = await stage4Http('post', `${path}/${action}`)
      .send({ operationId: randomUUID(), expectedVersion: row.version })
      .expect(status);
    if (code !== undefined) expect(result.body).toMatchObject({ code });
  }

  it('S4A2-02 preserves referenced masters through archive/restore with independent financial guards', async () => {
    const account = await createAccount();
    const cashId = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(id,store_id,name,normalized_name,account_type,is_default,status,operation_id)
      values($1,$2,'Cash','cash','cash',true,'active',$3)`,
      [cashId, owner.storeId, randomUUID()],
    );
    const customer = await stage4Party('customers');
    const supplier = await stage4Party('suppliers');
    const productId = randomUUID();
    const baseId = randomUUID();
    const unitId = randomUUID();
    const sku = `s4a-${productId}`;
    await stage4Http('post', 'products')
      .send({
        id: productId,
        operationId: randomUUID(),
        name: 'Stage 4A lifecycle',
        sku,
        measurementType: 'count',
        trackInventory: true,
        initialBaseUnit: { id: baseId, unitName: 'piece' },
      })
      .expect(201);
    await stage4Http('post', 'products/units')
      .send({
        id: unitId,
        operationId: randomUUID(),
        productId,
        unitName: 'pair',
        factorNum: 2,
        factorDen: 1,
      })
      .expect(201);
    const product = { productId, unitId };
    await seedInventory(product, '5000', '1000');
    const sale = (
      await postSale(productSale(product, account, { customerId: customer.id })).expect(201)
    ).body as SalePostingResponse;
    const invoiceResult = await stage4Http('post', `suppliers/${supplier.id}/invoices`)
      .send({
        operationId: randomUUID(),
        occurredAt: saleInstant,
        totalMinor: '500',
        items: [
          {
            description: 'Stage 4A invoice',
            unitName: 'piece',
            quantityMilli: '1000',
            unitCostMinor: '500',
          },
        ],
      })
      .expect(201);
    const invoice = invoiceResult.body as { invoice: { id: string } };
    await stage4Http('post', `suppliers/${supplier.id}/payments`)
      .send({
        operationId: randomUUID(),
        occurredAt: saleInstant,
        paymentSource: 'money_account',
        moneyAccountId: account,
        amountMinor: '500',
        allocations: [
          { targetType: 'purchase_invoice', targetId: invoice.invoice.id, amountMinor: '500' },
        ],
      })
      .expect(201);
    const before = await stage4Evidence();
    expect(
      (
        await db().admin.query(
          'select balance_minor::text as balance from ledger.v_money_account_balances where store_id=$1 and account_id=$2',
          [owner.storeId, account],
        )
      ).rows[0],
    ).toEqual({ balance: '0' });

    // Base cannot be archived while its conversion unit remains active.
    const baseBefore = await stage4Row('product_units', baseId);
    await stage4Lifecycle('product_units', baseId, `products/units/${baseId}`, 'archive', 409);
    expect(await stage4Row('product_units', baseId)).toEqual(baseBefore);
    await stage4Preserved(before);
    await stage4Lifecycle('product_units', unitId, `products/units/${unitId}`, 'archive');
    const archivedDetail = (await stage4Http('get', `products/${productId}`).expect(200)).body as {
      units: { id: string; status: string }[];
    };
    expect(archivedDetail.units).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: unitId, status: 'archived' })]),
    );
    await stage4Http('post', 'products/units')
      .send({
        id: randomUUID(),
        operationId: randomUUID(),
        productId,
        unitName: 'pair',
        factorNum: 2,
        factorDen: 1,
      })
      .expect(409);
    await stage4Lifecycle('product_units', baseId, `products/units/${baseId}`, 'archive');
    const unitBefore = await stage4Row('product_units', unitId);
    await stage4Lifecycle('product_units', unitId, `products/units/${unitId}`, 'restore', 409);
    expect(await stage4Row('product_units', unitId)).toEqual(unitBefore);
    await stage4Lifecycle('product_units', baseId, `products/units/${baseId}`, 'restore');
    await stage4Lifecycle('product_units', unitId, `products/units/${unitId}`, 'restore');
    expect(await stage4Row('product_units', unitId)).toMatchObject({
      id: unitId,
      status: 'active',
      factor_num: 2,
    });

    for (const [table, id, path] of [
      ['customers', customer.id, `customers/${customer.id}`],
      ['suppliers', supplier.id, `suppliers/${supplier.id}`],
      ['products', productId, `products/${productId}`],
      ['money_accounts', account, `money-accounts/${account}`],
    ]) {
      if (!table || !id || !path) throw new Error('Missing lifecycle case');
      const unitsBefore = await stage4Row('product_units', unitId);
      await stage4Lifecycle(table, id, path, 'archive');
      expect(await stage4Row('product_units', unitId)).toEqual(unitsBefore);
      expect(await stage4Row(table, id)).toMatchObject({ id, status: 'archived' });
      const list = (await stage4Http('get', path.split('/')[0] ?? '').expect(200)).body as {
        items: { id: string }[];
      };
      expect(list.items.map((item) => item.id)).not.toContain(id);
      await stage4Http('get', path).expect(200);
      await stage4Http('get', `sales/${sale.sale.id}`).expect(200);
      await stage4Http('get', `suppliers/${supplier.id}/invoices/${invoice.invoice.id}`).expect(
        200,
      );
      await stage4Preserved(before);
      if (table === 'customers' || table === 'suppliers') {
        await stage4Http('post', table)
          .send({
            id: randomUUID(),
            operationId: randomUUID(),
            name: 'Reserved duplicate',
            phone: table === 'customers' ? customer.phone : supplier.phone,
          })
          .expect(409);
      }
      if (table === 'products') {
        await stage4Http('post', 'products')
          .send({
            id: randomUUID(),
            operationId: randomUUID(),
            name: 'Reserved SKU',
            sku,
            measurementType: 'count',
            trackInventory: true,
            initialBaseUnit: { id: randomUUID(), unitName: 'piece' },
          })
          .expect(409);
      }
      if (table === 'money_accounts') {
        const archived = await stage4Row(table, id);
        await stage4Http('post', 'money-accounts')
          .send({
            id: randomUUID(),
            operationId: randomUUID(),
            name: archived.name,
          })
          .expect(409);
      }
      await stage4Http('delete', path).expect(404);
      await stage4Lifecycle(table, id, path, 'restore');
      expect(await stage4Row(table, id)).toMatchObject({ id, status: 'active', archived_at: null });
      const active = (await stage4Http('get', path.split('/')[0] ?? '').expect(200)).body as {
        items: { id: string }[];
      };
      expect(active.items.map((item) => item.id)).toContain(id);
      await stage4Preserved(before);
    }

    // Seed independent financial dimensions, then exercise the real HTTP guard.
    // These fixtures isolate archive policy; posting/credit formulas are Stage 4C/4D.
    for (const kind of ['customers', 'suppliers'] as const) {
      for (const [debt, credit] of [
        ['10', '0'],
        ['0', '10'],
      ]) {
        const party = await stage4Party(kind);
        const isCustomer = kind === 'customers';
        const ledger = isCustomer ? 'customer_ledger_entries' : 'supplier_ledger_entries';
        const partyColumn = isCustomer ? 'customer_id' : 'supplier_id';
        const debtColumn = isCustomer ? 'receivable_delta_minor' : 'payable_delta_minor';
        await db().admin.query(
          `insert into ledger.${ledger} (
          id,store_id,${partyColumn},accounting_period_id,entry_type,${debtColumn},credit_delta_minor,
          reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
        ) values ($1,$2,$3,$4,$5,$6,$7,'stage4a_fixture',$1,$1,$8,$9,$1)`,
          [
            randomUUID(),
            owner.storeId,
            party.id,
            deriveAccountingPeriodId(owner.storeId, 2026, 8),
            credit === '0' ? 'opening_balance' : 'credit_created',
            debt,
            credit,
            saleInstant,
            owner.deviceId,
          ],
        );
        const evidence = await stage4Evidence();
        const row = await stage4Row(kind, party.id);
        await stage4Lifecycle(
          kind,
          party.id,
          `${kind}/${party.id}`,
          'archive',
          409,
          isCustomer
            ? 'CUSTOMER_FINANCIAL_BALANCE_NONZERO'
            : 'SUPPLIER_FINANCIAL_BALANCE_OUTSTANDING',
        );
        expect(await stage4Row(kind, party.id)).toEqual(row);
        await stage4Preserved(evidence);
      }
    }
    const nonzeroAccount = await createAccount();
    await postSale(manualSale(nonzeroAccount)).expect(201);
    const nonzero = await stage4Row('money_accounts', nonzeroAccount);
    const financialBefore = await stage4Evidence();
    await stage4Lifecycle(
      'money_accounts',
      nonzeroAccount,
      `money-accounts/${nonzeroAccount}`,
      'archive',
      409,
      'MONEY_ACCOUNT_NON_ZERO_BALANCE',
    );
    expect(await stage4Row('money_accounts', nonzeroAccount)).toEqual(nonzero);
    const cash = await stage4Row('money_accounts', cashId);
    await stage4Lifecycle(
      'money_accounts',
      cashId,
      `money-accounts/${cashId}`,
      'archive',
      409,
      'MONEY_ACCOUNT_CASH_IMMUTABLE',
    );
    expect(await stage4Row('money_accounts', cashId)).toEqual(cash);
    await stage4Preserved(financialBefore);
  });

  it('S4A2-02 rejects foreign-Store and wrong-Product references with live constraints and no effect', async () => {
    const customer = await stage4Party('customers');
    const supplier = await stage4Party('suppliers');
    await postOpening(customer.id, {
      operationId: randomUUID(),
      occurredAt: saleInstant,
      amountMinor: '100',
    }).expect(201);
    await stage4Http('post', `suppliers/${supplier.id}/opening-payables`)
      .send({
        operationId: randomUUID(),
        occurredAt: saleInstant,
        amountMinor: '100',
      })
      .expect(201);
    const account = await createAccount();
    const product = await createProduct();
    await seedInventory(product, '2000', '100');
    await postSale(productSale(product, account)).expect(201);
    const foreignProduct = await createProduct({ identity: foreignOwner });
    const wrongProduct = await createProduct();
    const foreignAccount = await createAccount(foreignOwner);
    const foreignSupplier = randomUUID();
    await db().admin.query(
      `insert into ledger.suppliers(id,store_id,name,normalized_name,operation_id)
      values($1,$2,'Foreign fixture','foreign fixture',$3)`,
      [foreignSupplier, foreignOwner.storeId, randomUUID()],
    );
    const before = await stage4Evidence();
    const cases = [
      ['customer_ledger_entries', 'customer_id', customers.foreign, 'customer_id'],
      ['supplier_ledger_entries', 'supplier_id', foreignSupplier, 'supplier_id'],
      ['inventory_movements', 'product_unit_id', foreignProduct.unitId, 'product_unit'],
      ['inventory_movements', 'product_unit_id', wrongProduct.unitId, 'product_unit'],
      ['inventory_movements', 'product_id', foreignProduct.productId, 'product'],
      ['money_movements', 'account_id', foreignAccount, 'account_id'],
    ];
    for (const [table, column, foreignId, constraintPart] of cases) {
      if (!table || !column || !foreignId || !constraintPart) throw new Error('Invalid FK case');
      const source = (
        await db().admin.query<{ id: string }>(
          `select id from ledger.${table} where store_id=$1 order by id limit 1`,
          [owner.storeId],
        )
      ).rows[0];
      if (!source) throw new Error('FK source fact is missing');
      const client = await db().runtime.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.store_id',$1,true),set_config('app.user_id',$2,true),
          set_config('app.device_id',$3,true),set_config('app.request_id',$4,true)`,
          [owner.storeId, owner.userId, owner.deviceId, randomUUID()],
        );
        expect((await client.query('show session_replication_role')).rows[0]).toEqual({
          session_replication_role: 'origin',
        });
        const attempt = async (): Promise<void> => {
          await client.query(
            `insert into ledger.${table}
            select (jsonb_populate_record(null::ledger.${table},to_jsonb(t) || $2::jsonb)).*
            from ledger.${table} t where id=$1`,
            [
              source.id,
              JSON.stringify({ id: randomUUID(), operation_id: randomUUID(), [column]: foreignId }),
            ],
          );
          await client.query('set constraints all immediate');
        };
        // Inventory's BEFORE trigger rejects invalid lineage before the FK runs.
        // Assert its exact domain rejection, never accept an arbitrary SQL error.
        await expect(attempt()).rejects.toMatchObject(
          table === 'inventory_movements'
            ? {
                code: '23514',
                message:
                  column === 'product_id'
                    ? 'Inventory Product is unavailable'
                    : 'Inventory ProductUnit is unavailable or stale',
              }
            : { code: '23503', constraint: expect.stringContaining(constraintPart) as unknown },
        );
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect(await stage4Evidence()).toEqual(before);
    }
    for (const [table, id] of [
      ['customers', customer.id],
      ['suppliers', supplier.id],
      ['products', product.productId],
      ['product_units', product.unitId],
      ['money_accounts', account],
    ] as const) {
      const client = await db().runtime.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.store_id',$1,true),set_config('app.user_id',$2,true),
          set_config('app.device_id',$3,true)`,
          [owner.storeId, owner.userId, owner.deviceId],
        );
        await expect(
          client.query(`delete from ledger.${table} where id=$1`, [id]),
        ).rejects.toMatchObject({ code: '55000' });
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect(await stage4Evidence()).toEqual(before);
      expect(await stage4Row(table, id)).toMatchObject({ id });
    }
  });

  it('S4A2-03 keeps historical dates/facts immutable while settings affect future decisions and stale updates fail', async () => {
    const customer = await stage4Party('customers');
    const product = await createProduct();
    await seedInventory(product, '5000');
    await stage4Patch('app_settings', owner.storeId, 'settings', {
      defaultCreditPolicy: 'warn',
      defaultCreditLimitMinor: null,
    });
    const operation = productSale(product, null, { customerId: customer.id });
    const posted = (await postSale(operation).expect(201)).body as SalePostingResponse;
    expect(posted.items[0]).toMatchObject({
      costStatus: 'unknown',
      unitCostMinor: null,
      lineCostMinor: null,
    });
    const history = await stage4Evidence();
    await stage4Patch('app_settings', owner.storeId, 'settings', {
      defaultCreditPolicy: 'block',
      defaultCreditLimitMinor: '1',
      allowNegativeStock: true,
      lowStockAlertEnabled: false,
      debtAgeAlertDays: 45,
      customerDebtAmountAlertMinor: '12345',
      dailyReportTimeMinutes: 1260,
      backupEnabled: false,
      backupIntervalHours: 48,
    });
    const settings = await stage4Row('app_settings', owner.storeId);
    expect(settings).toMatchObject({
      default_credit_policy: 'block',
      default_credit_limit_minor: 1,
      allow_negative_stock: true,
      daily_report_time_minutes: 1260,
      backup_interval_hours: 48,
    });
    await stage4Preserved(history);
    const rejectedOperation = productSale(product, null, { customerId: customer.id });
    const rejected = await postSale(rejectedOperation).expect(409);
    expect(rejected.body).toMatchObject({ code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' });
    expect(await factCounts(rejectedOperation.operationId as string)).toMatchObject({
      sales: 0,
      items: 0,
      payments: 0,
      moneyMovements: 0,
      inventoryMovements: 0,
      receivables: 0,
    });
    await stage4Preserved(history);
    // A replay remains the original response after a policy change.
    expect((await postSale(operation).expect(201)).body).toEqual(posted);
    for (const fields of [
      { timezoneName: 'UTC' },
      { businessDayMode: 'custom' },
      { businessDayStartMinutes: 0 },
      { businessDayEndMinutes: 0 },
    ]) {
      const beforeReject = await stage4Evidence();
      await stage4Http('patch', 'settings')
        .send({ operationId: randomUUID(), expectedVersion: settings.version, ...fields })
        .expect(400);
      expect(await stage4Row('app_settings', owner.storeId)).toEqual(settings);
      expect(await stage4Evidence()).toEqual(beforeReject);
    }
    const initial = await stage4Row('products', product.productId);
    await stage4Patch('products', product.productId, `products/${product.productId}`, {
      name: 'Current label',
    });
    const current = await stage4Row('products', product.productId);
    await stage4Http('patch', `products/${product.productId}`)
      .send({
        operationId: randomUUID(),
        expectedVersion: initial.version,
        name: 'Stale overwrite',
      })
      .expect(409);
    expect(await stage4Row('products', product.productId)).toEqual(current);
    await stage4Preserved(history);
  });

  it('requires an authenticated active-store owner and ignores forged tenant headers', async () => {
    const accountId = await createAccount();
    await request(server).post('/v1/sales').send(manualSale(accountId)).expect(401);
    await postSale(manualSale(accountId), manager).expect(403);
    await postSale(manualSale(accountId), readOnlyOwner).expect(403);
    const result = await postSale(manualSale(accountId)).set('x-store-id', foreignOwner.storeId);
    expect(result.status).toBe(201);
  });
});
