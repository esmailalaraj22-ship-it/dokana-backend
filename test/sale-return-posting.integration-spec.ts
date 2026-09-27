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
import type { SaleReturnPostingResponse } from '../src/returns/sale-return-posting.types';
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';

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

const primaryStoreId = randomUUID();
const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-owner-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-manager-${randomUUID()}@example.test`,
    role: 'manager',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-foreign-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s173-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'read_only',
    token: '',
  },
];
const [owner, manager, foreignOwner, readOnlyOwner] = identities;

describe('S17.3 atomic Customer Sale Return posting on isolated PostgreSQL', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let acceptedAt: Date;
  let occurredAt: string;
  let periodId: string;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S17.3 database is unavailable.');
    return database;
  }

  function authorized(identity: Identity = owner): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  function postReturn(
    saleId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server).post(`/v1/sales/${saleId}/return`).set(authorized(identity)).send(body);
  }

  function returnRequest(
    sale: SalePostingResponse,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const item = sale.items[0];
    if (!item) throw new Error('Sale Return fixture requires a Sale line.');
    return {
      operationId: randomUUID(),
      occurredAt,
      reason: 'Customer returned the Sale line',
      lines: [
        {
          saleItemId: item.id,
          quantityMilli: item.quantityMilli,
          disposition: 'DAMAGED_NO_RESTOCK',
        },
      ],
      ...overrides,
    };
  }

  async function createCustomer(
    identity: Identity = owner,
    status: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.customers(
        id,store_id,name,normalized_name,phone,normalized_phone,status,archived_at,
        device_id,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,$3,
        case when $3='archived' then clock_timestamp() else null end,$4,$5)`,
      [id, identity.storeId, status, identity.deviceId, randomUUID()],
    );
    return id;
  }

  async function createAccount(
    identity: Identity = owner,
    status: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
        id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,'transfer','available',$3,
        case when $3='archived' then clock_timestamp() else null end,$4)`,
      [id, identity.storeId, status, randomUUID()],
    );
    return id;
  }

  async function createProduct(): Promise<ProductFixture> {
    const productId = randomUUID();
    const unitId = randomUUID();
    await db().admin.query(
      `insert into ledger.products(
        id,store_id,name,normalized_name,measurement_type,track_inventory,status,operation_id
      ) values($1,$2,$1::uuid::text,$1::uuid::text,'count',true,'active',$3)`,
      [productId, owner.storeId, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
        id,store_id,product_id,measurement_type,unit_name,is_base,
        factor_num,factor_den,status,operation_id
      ) values($1,$2,$3,'count','piece',true,1,1,'active',$4)`,
      [unitId, owner.storeId, productId, randomUUID()],
    );
    return { productId, unitId };
  }

  async function seedInventory(
    product: ProductFixture,
    costMinor?: string,
    quantityMilli = '2000',
  ): Promise<void> {
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.unitId,
      selectedQuantityMilli: quantityMilli,
      occurredAt,
    };
    if (costMinor !== undefined) body.totalPurchaseCostMinor = costMinor;
    await request(server).post('/v1/inventory/increase').set(authorized()).send(body).expect(201);
  }

  async function postManualSale(input: {
    identity?: Identity;
    customerId?: string;
    accountId?: string;
    saleAt?: string;
    customerCreditAmountMinor?: string;
    paymentAmountMinor?: string;
  }): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized(input.identity ?? owner))
      .send({
        operationId: randomUUID(),
        ...(input.customerId ? { customerId: input.customerId } : {}),
        occurredAt: input.saleAt ?? occurredAt,
        items: [
          {
            isManualLine: true,
            description: 'S17.3 manual Sale line',
            unitName: 'service',
            quantityMilli: '1000',
            unitPriceMinor: '500',
            lineTotalMinor: '500',
          },
        ],
        payments: input.accountId
          ? [{ moneyAccountId: input.accountId, amountMinor: input.paymentAmountMinor ?? '500' }]
          : [],
        ...(input.customerCreditAmountMinor
          ? { customerCreditAmountMinor: input.customerCreditAmountMinor }
          : {}),
        totalMinor: '500',
      })
      .expect(201);
    return response.body as SalePostingResponse;
  }

  async function postTrackedSale(
    product: ProductFixture,
    accountId: string,
  ): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
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
        payments: [{ moneyAccountId: accountId, amountMinor: '500' }],
        totalMinor: '500',
      })
      .expect(201);
    return response.body as SalePostingResponse;
  }

  async function customerBalances(
    customerId: string,
  ): Promise<{ receivable: string; credit: string }> {
    const row = (
      await db().admin.query<{ receivable: string; credit: string }>(
        `select receivable_minor::text as receivable,credit_minor::text as credit
         from ledger.v_customer_balances where store_id=$1 and customer_id=$2`,
        [owner.storeId, customerId],
      )
    ).rows[0];
    return row ?? { receivable: '0', credit: '0' };
  }

  async function stock(
    productId: string,
  ): Promise<{ quantity: string; value: string; state: string }> {
    const row = (
      await db().admin.query<{ quantity: string; value: string; state: string }>(
        `select quantity_milli::text as quantity,inventory_value_minor::text as value,
                cost_state as state
         from ledger.stock_balances where store_id=$1 and product_id=$2`,
        [owner.storeId, productId],
      )
    ).rows[0];
    if (!row) throw new Error('Stock projection is missing.');
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

    const clock = await db().admin.query<{ acceptedAt: string; businessDate: string }>(
      `select transaction_timestamp()::text as "acceptedAt",
              (transaction_timestamp() at time zone 'Asia/Hebron')::date::text as "businessDate"`,
    );
    const clockRow = clock.rows[0];
    if (!clockRow) throw new Error('PostgreSQL test clock is unavailable.');
    acceptedAt = new Date(clockRow.acceptedAt);
    occurredAt = acceptedAt.toISOString();
    const [yearText, monthText] = clockRow.businessDate.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const boundaries = resolveAccountingPeriodBoundaries(year, month);

    const uniqueStores = new Map<string, Identity>();
    for (const identity of identities) uniqueStores.set(identity.storeId, identity);
    for (const identity of uniqueStores.values()) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S17.3 fixture',$2)`,
        [identity.storeId, identity.storeStatus],
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
         values($1,$2,$2,$3,'S17.3 fixture')`,
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
      throw new Error('S17.3 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s173-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s173-auth', 3);

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
          deviceName: 'S17.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const token = (login.body as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string') throw new Error('S17.3 login token is missing.');
      identity.token = token;
    }
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

  it('refunds an anonymous paid Sale with one exact negative Money Movement and no debt effect', async () => {
    const accountId = await createAccount();
    const sale = await postManualSale({ accountId });
    const body = returnRequest(sale, {
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    const result = await postReturn(sale.sale.id, body).expect(201);
    const posted = result.body as SaleReturnPostingResponse;
    expect(posted).toMatchObject({
      operationId: body.operationId,
      return: { saleId: sale.sale.id, customerId: null, totalMinor: '500', status: 'posted' },
      settlementSummary: {
        receivableReductionMinor: '0',
        originalCustomerCreditRestorationMinor: '0',
        refundMinor: '500',
        newCustomerCreditMinor: '0',
        residualChoice: 'REFUND',
      },
      settlements: [
        {
          kind: 'money_refund',
          amountMinor: '500',
          moneyAccountId: accountId,
          moneyMovement: { movementType: 'customer_refund', amountDeltaMinor: '-500' },
        },
      ],
    });
    const facts = await db().admin.query(
      `select
        (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as returns,
        (select count(*)::int from ledger.customer_ledger_entries where store_id=$1 and transaction_group_id=$2) as ledger,
        (select coalesce(sum(amount_delta_minor),0)::text from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
        (select count(*)::int from ledger.inventory_movements where store_id=$1 and transaction_group_id=$2) as inventory`,
      [owner.storeId, body.operationId],
    );
    expect(facts.rows[0]).toEqual({ returns: 1, ledger: 0, money: '-500', inventory: 0 });
    const unchangedSale = await request(server)
      .get(`/v1/sales/${sale.sale.id}`)
      .set(authorized())
      .expect(200);
    expect(unchangedSale.body).toMatchObject({
      sale: { id: sale.sale.id, status: 'posted', totalMinor: '500' },
    });
  });

  it('applies receivable-first then restores only historical Customer Credit tender', async () => {
    const customerId = await createCustomer();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,300,'customer_advance',$1,$5,$6,$7,$8)`,
      [
        randomUUID(),
        owner.storeId,
        customerId,
        periodId,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
    const sale = await postManualSale({ customerId, customerCreditAmountMinor: '300' });
    expect(await customerBalances(customerId)).toEqual({ receivable: '200', credit: '0' });

    const result = await postReturn(sale.sale.id, returnRequest(sale)).expect(201);
    expect(result.body).toMatchObject({
      settlementSummary: {
        receivableReductionMinor: '200',
        originalCustomerCreditRestorationMinor: '300',
        refundMinor: '0',
        newCustomerCreditMinor: '0',
        residualChoice: null,
      },
      settlements: [
        { kind: 'receivable_reduction', amountMinor: '200' },
        { kind: 'original_customer_credit_restoration', amountMinor: '300' },
      ],
    });
    expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '300' });
  });

  it('handles partial Receivable reduction and explicit residual Customer Credit exactly', async () => {
    const accountId = await createAccount();

    const partialCustomer = await createCustomer();
    const partialSale = await postManualSale({
      customerId: partialCustomer,
      accountId,
      paymentAmountMinor: '300',
    });
    const partial = await postReturn(
      partialSale.sale.id,
      returnRequest(partialSale, {
        lines: [
          {
            saleItemId: partialSale.items[0]?.id,
            quantityMilli: '300',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
      }),
    ).expect(201);
    expect(partial.body).toMatchObject({
      return: { totalMinor: '150' },
      settlementSummary: {
        receivableReductionMinor: '150',
        refundMinor: '0',
        newCustomerCreditMinor: '0',
      },
    });
    expect(await customerBalances(partialCustomer)).toEqual({ receivable: '50', credit: '0' });

    const residualCustomer = await createCustomer();
    const residualSale = await postManualSale({
      customerId: residualCustomer,
      accountId,
      paymentAmountMinor: '400',
    });
    const residual = await postReturn(
      residualSale.sale.id,
      returnRequest(residualSale, {
        lines: [
          {
            saleItemId: residualSale.items[0]?.id,
            quantityMilli: '500',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    ).expect(201);
    expect(residual.body).toMatchObject({
      return: { totalMinor: '250' },
      settlementSummary: {
        receivableReductionMinor: '100',
        refundMinor: '0',
        newCustomerCreditMinor: '150',
        residualChoice: 'KEEP_AS_CUSTOMER_CREDIT',
      },
    });
    expect(await customerBalances(residualCustomer)).toEqual({ receivable: '0', credit: '150' });

    const paidCustomer = await createCustomer();
    const paidSale = await postManualSale({ customerId: paidCustomer, accountId });
    await postReturn(
      paidSale.sale.id,
      returnRequest(paidSale, {
        lines: [
          {
            saleItemId: paidSale.items[0]?.id,
            quantityMilli: '400',
            disposition: 'DAMAGED_NO_RESTOCK',
          },
        ],
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    ).expect(201);
    expect(await customerBalances(paidCustomer)).toEqual({ receivable: '0', credit: '200' });
  });

  it('restocks saleable tracked quantity at historical known/unknown cost and never restocks damage', async () => {
    const accountId = await createAccount();
    const known = await createProduct();
    await seedInventory(known, '200');
    const knownSale = await postTrackedSale(known, accountId);
    expect(await stock(known.productId)).toEqual({
      quantity: '1000',
      value: '100',
      state: 'known',
    });
    const knownBody = returnRequest(knownSale, {
      lines: [
        {
          saleItemId: knownSale.items[0]?.id,
          quantityMilli: '1000',
          disposition: 'RESTOCK_SALEABLE',
        },
      ],
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    const knownReturn = await postReturn(knownSale.sale.id, knownBody).expect(201);
    expect(knownReturn.body).toMatchObject({
      lines: [
        {
          costStatus: 'known',
          historicalCostMinor: '100',
          cogsReversalMinor: '100',
          inventoryMovement: { quantityDeltaMilli: '1000', valueDeltaMinor: '100' },
        },
      ],
    });
    expect(await stock(known.productId)).toEqual({
      quantity: '2000',
      value: '200',
      state: 'known',
    });

    const damagedSale = await postTrackedSale(known, accountId);
    const damaged = await postReturn(
      damagedSale.sale.id,
      returnRequest(damagedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);
    expect(damaged.body).toMatchObject({
      lines: [{ itemCondition: 'damaged', cogsReversalMinor: null, inventoryMovement: null }],
    });
    expect(await stock(known.productId)).toEqual({
      quantity: '1000',
      value: '100',
      state: 'known',
    });

    const unknown = await createProduct();
    await seedInventory(unknown);
    const unknownSale = await postTrackedSale(unknown, accountId);
    const unknownResult = await postReturn(
      unknownSale.sale.id,
      returnRequest(unknownSale, {
        lines: [
          {
            saleItemId: unknownSale.items[0]?.id,
            quantityMilli: '1000',
            disposition: 'RESTOCK_SALEABLE',
          },
        ],
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);
    expect(unknownResult.body).toMatchObject({
      lines: [
        {
          costStatus: 'unknown',
          historicalCostMinor: null,
          cogsReversalMinor: null,
          inventoryMovement: { valueDeltaMinor: null },
        },
      ],
    });
    expect(await stock(unknown.productId)).toEqual({
      quantity: '2000',
      value: '0',
      state: 'unknown',
    });
  });

  it('replays exactly, rejects changed identity, and serializes competing over-returns', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const body = returnRequest(sale);
    const [first, duplicate] = await Promise.all([
      postReturn(sale.sale.id, body),
      postReturn(sale.sale.id, body),
    ]);
    expect([first.status, duplicate.status]).toEqual([201, 201]);
    expect(duplicate.body).toEqual(first.body);
    expect(
      (await postReturn(sale.sale.id, { ...body, reason: 'Changed request' }).expect(409)).body,
    ).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });

    const competingSale = await postManualSale({ customerId: await createCustomer() });
    const responses = await Promise.all([
      postReturn(competingSale.sale.id, returnRequest(competingSale)),
      postReturn(competingSale.sale.id, returnRequest(competingSale)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toMatchObject({
      code: 'SALE_RETURN_QUANTITY_EXCEEDED',
    });
    const count = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.sale_returns
       where store_id=$1 and sale_id=$2 and status='posted'`,
      [owner.storeId, competingSale.sale.id],
    );
    expect(count.rows[0]).toEqual({ count: 1 });
    expect(
      (
        await request(server)
          .post(`/v1/sales/${sale.operationId}/cancel`)
          .set(authorized())
          .send({ operationId: randomUUID(), occurredAt })
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_CORRECTION_DEPENDENT_FACTS' });
  });

  it('rejects a new Return when the current S9 posting period is closed', async () => {
    const accountId = await createAccount();
    const sale = await postManualSale({ accountId });
    const body = returnRequest(sale, {
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    await db().admin.query(
      `update ledger.accounting_periods
       set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, periodId],
    );
    try {
      expect((await postReturn(sale.sale.id, body).expect(409)).body).toMatchObject({
        code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
      });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [owner.storeId, periodId],
      );
    }
    const facts = await db().admin.query(
      `select
        (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as returns,
        (select count(*)::int from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
        (select status from sync.processed_operations where store_id=$1 and operation_id=$2) as status`,
      [owner.storeId, body.operationId],
    );
    expect(facts.rows[0]).toEqual({ returns: 0, money: 0, status: 'rejected' });
  });

  it('fails closed for authentication, actor role, tenant RLS, read_only, expiry, and inactive Sales', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const body = returnRequest(sale);
    await request(server).post(`/v1/sales/${sale.sale.id}/return`).send(body).expect(401);
    await postReturn(sale.sale.id, body, manager).expect(403);
    expect((await postReturn(sale.sale.id, body, foreignOwner).expect(404)).body).toMatchObject({
      code: 'SALE_RETURN_SALE_NOT_FOUND',
    });
    await postReturn(sale.sale.id, body, readOnlyOwner).expect(403);

    const expiredSale = await postManualSale({
      customerId: await createCustomer(),
      saleAt: new Date(acceptedAt.getTime() - 49 * 60 * 60 * 1000).toISOString(),
    });
    expect(
      (await postReturn(expiredSale.sale.id, returnRequest(expiredSale)).expect(409)).body,
    ).toMatchObject({ code: 'SALE_RETURN_WINDOW_EXPIRED' });

    const inactiveSale = await postManualSale({ customerId: await createCustomer() });
    await request(server)
      .post(`/v1/sales/${inactiveSale.operationId}/cancel`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt })
      .expect(201);
    expect(
      (await postReturn(inactiveSale.sale.id, returnRequest(inactiveSale)).expect(409)).body,
    ).toMatchObject({ code: 'SALE_RETURN_SALE_INACTIVE' });

    const accountId = await createAccount();
    const archivedCustomer = await createCustomer();
    const archivedSale = await postManualSale({ customerId: archivedCustomer, accountId });
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, archivedCustomer],
    );
    expect(
      (
        await postReturn(
          archivedSale.sale.id,
          returnRequest(archivedSale, {
            residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
          }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_CUSTOMER_RESTORE_REQUIRED' });
    await postReturn(
      archivedSale.sale.id,
      returnRequest(archivedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);

    const historicalCreditCustomer = await createCustomer();
    const historicalCreditId = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,100,'customer_advance',$1,$5,$6,$7,$8)`,
      [
        historicalCreditId,
        owner.storeId,
        historicalCreditCustomer,
        periodId,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
    const historicalCreditSale = await postManualSale({
      customerId: historicalCreditCustomer,
      accountId,
      paymentAmountMinor: '400',
      customerCreditAmountMinor: '100',
    });
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, historicalCreditCustomer],
    );
    const historicalCreditReturn = await postReturn(
      historicalCreditSale.sale.id,
      returnRequest(historicalCreditSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    ).expect(201);
    expect(historicalCreditReturn.body).toMatchObject({
      settlementSummary: {
        originalCustomerCreditRestorationMinor: '100',
        refundMinor: '400',
        newCustomerCreditMinor: '0',
      },
    });
    expect(await customerBalances(historicalCreditCustomer)).toEqual({
      receivable: '0',
      credit: '100',
    });
  });

  it('serializes Return against collection, Sale correction, refund-account archive, and Product archive', async () => {
    const collectionAccount = await createAccount();
    const collectionCustomer = await createCustomer();
    const collectionSale = await postManualSale({ customerId: collectionCustomer });
    const collectionRace = await Promise.all([
      postReturn(collectionSale.sale.id, returnRequest(collectionSale)),
      request(server)
        .post(`/v1/customers/${collectionCustomer}/payments`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          allocationMode: 'fifo',
          tenders: [{ moneyAccountId: collectionAccount, amountMinor: '500' }],
        }),
    ]);
    expect(collectionRace.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await customerBalances(collectionCustomer)).toEqual({ receivable: '0', credit: '0' });

    const correctionCustomer = await createCustomer();
    const correctionSale = await postManualSale({ customerId: correctionCustomer });
    const correctionRace = await Promise.all([
      postReturn(correctionSale.sale.id, returnRequest(correctionSale)),
      request(server)
        .post(`/v1/sales/${correctionSale.operationId}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt }),
    ]);
    expect(correctionRace.map((response) => response.status).sort()).toEqual([201, 409]);

    const paidAccount = await createAccount();
    const refundAccount = await createAccount();
    const refundSale = await postManualSale({ accountId: paidAccount });
    const refundRace = await Promise.all([
      postReturn(
        refundSale.sale.id,
        returnRequest(refundSale, {
          residualSettlement: { choice: 'REFUND', moneyAccountId: refundAccount },
        }),
      ),
      request(server)
        .post(`/v1/money-accounts/${refundAccount}/archive`)
        .set(authorized())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    expect(refundRace.filter((response) => response.status < 300)).toHaveLength(1);
    expect(refundRace.filter((response) => response.status === 409)).toHaveLength(1);

    const product = await createProduct();
    await seedInventory(product, '100', '1000');
    const productSale = await postTrackedSale(product, paidAccount);
    expect(await stock(product.productId)).toEqual({ quantity: '0', value: '0', state: 'known' });
    const productRace = await Promise.all([
      postReturn(
        productSale.sale.id,
        returnRequest(productSale, {
          lines: [
            {
              saleItemId: productSale.items[0]?.id,
              quantityMilli: '1000',
              disposition: 'RESTOCK_SALEABLE',
            },
          ],
          residualSettlement: { choice: 'REFUND', moneyAccountId: paidAccount },
        }),
      ),
      request(server)
        .post(`/v1/products/${product.productId}/archive`)
        .set(authorized())
        .send({ operationId: randomUUID(), expectedVersion: '1' }),
    ]);
    expect(productRace.filter((response) => response.status < 300)).toHaveLength(1);
    expect(productRace.filter((response) => response.status === 409)).toHaveLength(1);

    const creditCustomer = await createCustomer();
    const creditAccount = await createAccount();
    const creditSeedId = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
        id,store_id,customer_id,accounting_period_id,entry_type,
        receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
        transaction_group_id,occurred_at,device_id,operation_id
      ) values($1,$2,$3,$4,'credit_created',0,100,'customer_advance',$1,$5,$6,$7,$8)`,
      [
        creditSeedId,
        owner.storeId,
        creditCustomer,
        periodId,
        randomUUID(),
        occurredAt,
        owner.deviceId,
        randomUUID(),
      ],
    );
    const creditSale = await postManualSale({
      customerId: creditCustomer,
      accountId: paidAccount,
      paymentAmountMinor: '400',
      customerCreditAmountMinor: '100',
    });
    const creditRace = await Promise.all([
      postReturn(
        creditSale.sale.id,
        returnRequest(creditSale, {
          residualSettlement: { choice: 'REFUND', moneyAccountId: paidAccount },
        }),
      ),
      request(server)
        .post(`/v1/customers/${creditCustomer}/credit/refunds`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          amountMinor: '100',
          moneyAccountId: creditAccount,
        }),
    ]);
    expect(creditRace[0].status).toBe(201);
    expect([201, 409]).toContain(creditRace[1].status);
    const creditBalance = await customerBalances(creditCustomer);
    expect(creditBalance.receivable).toBe('0');
    expect(['0', '100']).toContain(creditBalance.credit);
  });

  it('rolls back every Return fact when restock eligibility changes and records successful audit/change effects', async () => {
    const accountId = await createAccount();
    const product = await createProduct();
    await seedInventory(product, '200');
    const sale = await postTrackedSale(product, accountId);
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, product.productId],
    );
    const body = returnRequest(sale, {
      lines: [
        {
          saleItemId: sale.items[0]?.id,
          quantityMilli: '1000',
          disposition: 'RESTOCK_SALEABLE',
        },
      ],
      residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
    });
    expect((await postReturn(sale.sale.id, body).expect(409)).body).toMatchObject({
      code: 'SALE_RETURN_RESTOCK_UNAVAILABLE',
    });
    const rejected = await db().admin.query(
      `select
        (select count(*)::int from ledger.sale_returns where store_id=$1 and operation_id=$2) as returns,
        (select count(*)::int from ledger.inventory_movements where store_id=$1 and transaction_group_id=$2) as inventory,
        (select count(*)::int from ledger.money_movements where store_id=$1 and transaction_group_id=$2) as money,
        (select status from sync.processed_operations where store_id=$1 and operation_id=$2) as status`,
      [owner.storeId, body.operationId],
    );
    expect(rejected.rows[0]).toEqual({ returns: 0, inventory: 0, money: 0, status: 'rejected' });

    const successfulSale = await postManualSale({ customerId: await createCustomer() });
    const success = await postReturn(successfulSale.sale.id, returnRequest(successfulSale)).expect(
      201,
    );
    const returnId = (success.body as SaleReturnPostingResponse).return.id;
    const evidence = await db().admin.query(
      `select
        (select count(*)::int from audit.central_audit_logs where store_id=$1 and entity_id=$2) as audit,
        (select count(*)::int from sync.change_events where store_id=$1 and entity_id=$2) as changes`,
      [owner.storeId, returnId],
    );
    expect(evidence.rows[0]).toEqual({ audit: 2, changes: 2 });
  });
});
