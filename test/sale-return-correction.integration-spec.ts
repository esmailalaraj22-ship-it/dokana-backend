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
import type { SaleReturnCorrectionResponse } from '../src/returns/sale-return-correction.types';
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
  storeStatus: 'active' | 'read_only';
  token: string;
}

interface ProductFixture {
  productId: string;
  unitId: string;
}

const primaryStoreId = randomUUID();
const identities: [Identity, Identity, Identity] = [
  {
    storeId: primaryStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s175-owner-${randomUUID()}@example.test`,
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s175-foreign-${randomUUID()}@example.test`,
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s175-read-only-${randomUUID()}@example.test`,
    storeStatus: 'read_only',
    token: '',
  },
];
const [owner, foreignOwner, readOnlyOwner] = identities;

describe('S17.5 immutable Sale Return corrections on isolated PostgreSQL', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let acceptedAt: Date;
  let occurredAt: string;
  let businessDate: string;
  let periodId: string;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S17.5 database is unavailable.');
    return database;
  }

  function authorized(identity: Identity = owner): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  async function createCustomer(status: 'active' | 'archived' = 'active'): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.customers(
         id,store_id,name,normalized_name,phone,normalized_phone,status,archived_at,
         device_id,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,$3,
         case when $3='archived' then clock_timestamp() else null end,$4,$5)`,
      [id, owner.storeId, status, owner.deviceId, randomUUID()],
    );
    return id;
  }

  async function createAccount(status: 'active' | 'archived' = 'active'): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,'transfer','available',$3,
         case when $3='archived' then clock_timestamp() else null end,$4)`,
      [id, owner.storeId, status, randomUUID()],
    );
    return id;
  }

  async function createProduct(allowNegative = false): Promise<ProductFixture> {
    const productId = randomUUID();
    const unitId = randomUUID();
    await db().admin.query(
      `insert into ledger.products(
         id,store_id,name,normalized_name,measurement_type,track_inventory,
         allow_negative_stock_override,status,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,'count',true,$3,'active',$4)`,
      [productId, owner.storeId, allowNegative, randomUUID()],
    );
    await db().admin.query(
      `insert into ledger.product_units(
         id,store_id,product_id,measurement_type,unit_name,is_base,
         factor_num,factor_den,status,operation_id)
       values($1,$2,$3,'count','piece',true,1,1,'active',$4)`,
      [unitId, owner.storeId, productId, randomUUID()],
    );
    return { productId, unitId };
  }

  async function seedInventory(
    product: ProductFixture,
    quantityMilli = '2000',
    totalPurchaseCostMinor?: string,
  ): Promise<void> {
    await request(server)
      .post('/v1/inventory/increase')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        productId: product.productId,
        productUnitId: product.unitId,
        selectedQuantityMilli: quantityMilli,
        ...(totalPurchaseCostMinor === undefined ? {} : { totalPurchaseCostMinor }),
        occurredAt,
      })
      .expect(201);
  }

  async function postManualSale(input: {
    customerId?: string;
    accountId?: string;
    paymentAmountMinor?: string;
    customerCreditAmountMinor?: string;
    quantityMilli?: string;
    lineTotalMinor?: string;
    occurredAtOverride?: string;
  }): Promise<{ body: SalePostingResponse; request: Record<string, unknown> }> {
    const totalMinor = input.lineTotalMinor ?? '500';
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      ...(input.customerId ? { customerId: input.customerId } : {}),
      occurredAt: input.occurredAtOverride ?? occurredAt,
      items: [
        {
          isManualLine: true,
          description: 'S17.5 manual Sale line',
          unitName: 'piece',
          quantityMilli: input.quantityMilli ?? '1000',
          unitPriceMinor: '500',
          lineTotalMinor: totalMinor,
        },
      ],
      payments: input.accountId
        ? [{ moneyAccountId: input.accountId, amountMinor: input.paymentAmountMinor ?? totalMinor }]
        : [],
      ...(input.customerCreditAmountMinor
        ? { customerCreditAmountMinor: input.customerCreditAmountMinor }
        : {}),
      totalMinor,
    };
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized())
      .send(body)
      .expect(201);
    return { body: response.body as SalePostingResponse, request: body };
  }

  async function postTwoLineSale(customerId: string): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set(authorized())
      .send({
        operationId: randomUUID(),
        customerId,
        occurredAt,
        items: ['first', 'second'].map((description) => ({
          isManualLine: true,
          description,
          unitName: 'piece',
          quantityMilli: '1000',
          unitPriceMinor: '500',
          lineTotalMinor: '500',
        })),
        payments: [],
        totalMinor: '1000',
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

  function returnRequest(
    sale: SalePostingResponse,
    options: {
      operationId?: string;
      lineIndex?: number;
      quantityMilli?: string;
      disposition?: 'RESTOCK_SALEABLE' | 'DAMAGED_NO_RESTOCK';
      residualSettlement?: Record<string, unknown>;
    } = {},
  ): Record<string, unknown> {
    const item = sale.items[options.lineIndex ?? 0];
    if (!item) throw new Error('Sale Return fixture requires the requested Sale line.');
    return {
      operationId: options.operationId ?? randomUUID(),
      occurredAt,
      reason: 'S17.5 original commercial Return',
      lines: [
        {
          saleItemId: item.id,
          quantityMilli: options.quantityMilli ?? item.quantityMilli,
          disposition: options.disposition ?? 'DAMAGED_NO_RESTOCK',
        },
      ],
      ...(options.residualSettlement ? { residualSettlement: options.residualSettlement } : {}),
    };
  }

  async function postReturn(
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<SaleReturnPostingResponse> {
    const response = await request(server)
      .post(`/v1/sales/${saleId}/return`)
      .set(authorized())
      .send(body)
      .expect(201);
    return response.body as SaleReturnPostingResponse;
  }

  function cancelReturn(
    returnId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/returns/${returnId}/cancel`)
      .set(authorized(identity))
      .send(body);
  }

  function replaceReturn(
    returnId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/returns/${returnId}/replace`)
      .set(authorized(identity))
      .send(body);
  }

  function cancelBody(operationId = randomUUID(), at = occurredAt): Record<string, unknown> {
    return { operationId, occurredAt: at, reason: 'Correct historical Return' };
  }

  function replaceBody(
    sale: SalePostingResponse,
    operationId = randomUUID(),
    options: {
      lineIndex?: number;
      quantityMilli?: string;
      disposition?: 'RESTOCK_SALEABLE' | 'DAMAGED_NO_RESTOCK';
      residualSettlement?: Record<string, unknown>;
      at?: string;
    } = {},
  ): Record<string, unknown> {
    const item = sale.items[options.lineIndex ?? 0];
    if (!item) throw new Error('Replacement fixture requires the requested Sale line.');
    return {
      operationId,
      occurredAt: options.at ?? occurredAt,
      reason: 'Correct Return root',
      replacement: {
        reason: 'Corrected commercial Return',
        lines: [
          {
            saleItemId: item.id,
            quantityMilli: options.quantityMilli ?? item.quantityMilli,
            disposition: options.disposition ?? 'DAMAGED_NO_RESTOCK',
          },
        ],
        ...(options.residualSettlement ? { residualSettlement: options.residualSettlement } : {}),
      },
    };
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

  async function accountBalance(accountId: string): Promise<string> {
    return (
      (
        await db().admin.query<{ balance: string }>(
          `select coalesce(sum(amount_delta_minor),0)::text as balance
         from ledger.money_movements where store_id=$1 and account_id=$2`,
          [owner.storeId, accountId],
        )
      ).rows[0]?.balance ?? '0'
    );
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

  async function seedCustomerCredit(customerId: string, amountMinor: string): Promise<void> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
         id,store_id,customer_id,accounting_period_id,entry_type,
         receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
         transaction_group_id,occurred_at,device_id,operation_id)
       values($1,$2,$3,$4,'credit_created',0,$5,'customer_advance',$1,$6,$7,$8,$9)`,
      [
        id,
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
    businessDate = clockRow.businessDate;
    const [yearText, monthText] = businessDate.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const boundaries = resolveAccountingPeriodBoundaries(year, month);

    for (const identity of identities) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S17.5 fixture',$2)`,
        [identity.storeId, identity.storeStatus],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
      const id = deriveAccountingPeriodId(identity.storeId, year, month);
      await db().admin.query(
        `insert into ledger.accounting_periods(
           id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id)
         values($1,$2,$3,$4,$5,$6,'open',$7)`,
        [id, identity.storeId, year, month, boundaries.startsAt, boundaries.endsAt, randomUUID()],
      );
      if (identity.storeId === owner.storeId) periodId = id;
    }

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S17.5 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,'owner','active')`,
        [randomUUID(), identity.storeId, identity.userId],
      );
    }

    const databaseName = (
      await db().admin.query<{ name: string }>('select current_database() as name')
    ).rows[0]?.name;
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('S17.5 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s175-runtime', 10);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s175-auth', 3);

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
          deviceName: 'S17.5 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const token = (login.body as { accessToken?: unknown }).accessToken;
      if (typeof token !== 'string') throw new Error('S17.5 login token is missing.');
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

  it('cancels a Receivable Return exactly while preserving a later Customer payment', async () => {
    const customerId = await createCustomer();
    const collectionAccount = await createAccount();
    const sale = await postManualSale({ customerId });
    const original = returnRequest(sale.body, { quantityMilli: '400' });
    const posted = await postReturn(sale.body.sale.id, original);
    expect(await customerBalances(customerId)).toEqual({ receivable: '300', credit: '0' });

    await request(server)
      .post(`/v1/customers/${customerId}/payments`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        allocationMode: 'fifo',
        tenders: [{ moneyAccountId: collectionAccount, amountMinor: '100' }],
      })
      .expect(201);
    const correction = await cancelReturn(posted.return.id, cancelBody()).expect(201);
    expect(correction.body).toMatchObject({
      outcome: { targetReturnId: posted.return.id, status: 'cancelled', activeReturnId: null },
      reversal: {
        customerLedgerEffects: [{ receivableDeltaMinor: '200', creditDeltaMinor: '0' }],
      },
    });
    expect(await customerBalances(customerId)).toEqual({ receivable: '400', credit: '0' });
    const payments = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.customer_payments
       where store_id=$1 and customer_id=$2 and status='posted'`,
      [owner.storeId, customerId],
    );
    expect(payments.rows[0]).toEqual({ count: 1 });
  });

  it('reverses the exact historical refund account after archive and preserves both replays', async () => {
    const saleAccount = await createAccount();
    const refundAccount = await createAccount();
    const sale = await postManualSale({ accountId: saleAccount });
    const originalRequest = returnRequest(sale.body, {
      residualSettlement: { choice: 'REFUND', moneyAccountId: refundAccount },
    });
    const posted = await postReturn(sale.body.sale.id, originalRequest);
    expect(await accountBalance(refundAccount)).toBe('-500');
    await db().admin.query(
      `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, refundAccount],
    );

    const operationId = randomUUID();
    const command = cancelBody(operationId);
    const first = await cancelReturn(posted.return.id, command).expect(201);
    const replay = await cancelReturn(posted.return.id, command).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      reversal: {
        moneyMovements: [
          { accountId: refundAccount, amountDeltaMinor: '500', movementType: 'correction' },
        ],
      },
    });
    expect(await accountBalance(refundAccount)).toBe('0');

    const originalReplay = await request(server)
      .post(`/v1/sales/${sale.body.sale.id}/return`)
      .set(authorized())
      .send(originalRequest)
      .expect(201);
    expect(originalReplay.body).toEqual(posted);
    const detail = await request(server)
      .get(`/v1/returns/${posted.return.id}`)
      .set(authorized())
      .expect(200);
    expect(detail.body).toMatchObject({
      return: {
        lifecycle: { status: 'cancelled', effective: false, activeLeaf: false },
        lineage: { successorReturnId: null },
      },
    });
  });

  it('reverses restored and newly-created Customer Credit exactly when available', async () => {
    const customerId = await createCustomer();
    const accountId = await createAccount();
    await seedCustomerCredit(customerId, '100');
    const sale = await postManualSale({
      customerId,
      accountId,
      paymentAmountMinor: '400',
      customerCreditAmountMinor: '100',
    });
    const posted = await postReturn(
      sale.body.sale.id,
      returnRequest(sale.body, {
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    );
    expect(posted.settlementSummary).toMatchObject({
      originalCustomerCreditRestorationMinor: '100',
      newCustomerCreditMinor: '400',
    });
    expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '500' });

    const corrected = await cancelReturn(posted.return.id, cancelBody()).expect(201);
    const creditDeltas = (
      corrected.body as SaleReturnCorrectionResponse
    ).reversal.customerLedgerEffects
      .map((effect) => effect.creditDeltaMinor)
      .sort();
    expect(creditDeltas).toEqual(['-100', '-400']);
    expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });
  });

  it('blocks correction when Return-created Credit was spent without cascading history', async () => {
    const customerId = await createCustomer();
    const saleAccount = await createAccount();
    const refundAccount = await createAccount();
    const sale = await postManualSale({ customerId, accountId: saleAccount });
    const posted = await postReturn(
      sale.body.sale.id,
      returnRequest(sale.body, {
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    );
    await request(server)
      .post(`/v1/customers/${customerId}/credit/refunds`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        amountMinor: '500',
        moneyAccountId: refundAccount,
      })
      .expect(201);
    expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });

    expect((await cancelReturn(posted.return.id, cancelBody()).expect(409)).body).toMatchObject({
      code: 'SALE_RETURN_CORRECTION_CREDIT_DEPENDENCY',
    });
    expect(await customerBalances(customerId)).toEqual({ receivable: '0', credit: '0' });
    expect(
      (
        await db().admin.query<{ status: string }>(
          `select status from ledger.sale_returns where store_id=$1 and id=$2`,
          [owner.storeId, posted.return.id],
        )
      ).rows[0],
    ).toEqual({ status: 'posted' });
  });

  it('reverses saleable known-cost stock exactly and creates no movement for damaged lines', async () => {
    const accountId = await createAccount();
    const product = await createProduct();
    await seedInventory(product, '2000', '200');
    const sale = await postTrackedSale(product, accountId);
    const restocked = await postReturn(
      sale.sale.id,
      returnRequest(sale, {
        disposition: 'RESTOCK_SALEABLE',
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    expect(await stock(product.productId)).toEqual({
      quantity: '2000',
      value: '200',
      state: 'known',
    });
    const reversed = await cancelReturn(restocked.return.id, cancelBody()).expect(201);
    expect(reversed.body).toMatchObject({
      reversal: {
        inventoryMovements: [
          { quantityDeltaMilli: '-1000', valueDeltaMinor: '-100', costStatus: 'known' },
        ],
      },
    });
    expect(await stock(product.productId)).toEqual({
      quantity: '1000',
      value: '100',
      state: 'known',
    });

    const damagedSale = await postTrackedSale(product, accountId);
    const damaged = await postReturn(
      damagedSale.sale.id,
      returnRequest(damagedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    const damagedCorrection = await cancelReturn(damaged.return.id, cancelBody()).expect(201);
    expect(damagedCorrection.body).toMatchObject({
      reversal: { inventoryMovements: [] },
    });
  });

  it('preserves unknown and pending historical cost states and ignores current catalog cost', async () => {
    const accountId = await createAccount();
    const unknown = await createProduct();
    await seedInventory(unknown);
    const unknownSale = await postTrackedSale(unknown, accountId);
    const unknownReturn = await postReturn(
      unknownSale.sale.id,
      returnRequest(unknownSale, {
        disposition: 'RESTOCK_SALEABLE',
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    const unknownCorrection = await cancelReturn(unknownReturn.return.id, cancelBody()).expect(201);
    expect(unknownCorrection.body).toMatchObject({
      reversal: {
        inventoryMovements: [{ valueDeltaMinor: null, costStatus: 'unknown' }],
      },
    });
    expect(await stock(unknown.productId)).toEqual({
      quantity: '1000',
      value: '0',
      state: 'unknown',
    });

    const pending = await createProduct(true);
    const pendingSale = await postTrackedSale(pending, accountId);
    expect(await stock(pending.productId)).toEqual({
      quantity: '-1000',
      value: '0',
      state: 'pending',
    });
    const pendingReturn = await postReturn(
      pendingSale.sale.id,
      returnRequest(pendingSale, {
        disposition: 'RESTOCK_SALEABLE',
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    const pendingCorrection = await cancelReturn(pendingReturn.return.id, cancelBody()).expect(201);
    expect(pendingCorrection.body).toMatchObject({
      reversal: {
        inventoryMovements: [{ valueDeltaMinor: null, costStatus: 'pending' }],
      },
    });
    expect(await stock(pending.productId)).toEqual({
      quantity: '-1000',
      value: '0',
      state: 'pending',
    });
  });

  it('creates one linear replacement chain and exposes predecessor, successor, and active leaf', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({
      customerId,
      quantityMilli: '2000',
      lineTotalMinor: '1000',
    });
    const original = await postReturn(
      sale.body.sale.id,
      returnRequest(sale.body, { quantityMilli: '1000' }),
    );
    const first = await replaceReturn(
      original.return.id,
      replaceBody(sale.body, randomUUID(), { quantityMilli: '500' }),
    ).expect(201);
    const firstCorrection = first.body as SaleReturnCorrectionResponse;
    const successorId = firstCorrection.replacement?.return.id;
    expect(successorId).toBeDefined();
    if (!successorId) throw new Error('First replacement Return is missing.');

    expect((await cancelReturn(original.return.id, cancelBody()).expect(409)).body).toMatchObject({
      code: 'SALE_RETURN_CORRECTION_TARGET_NOT_ACTIVE',
    });
    const second = await replaceReturn(
      successorId,
      replaceBody(sale.body, randomUUID(), { quantityMilli: '250' }),
    ).expect(201);
    const activeId = (second.body as SaleReturnCorrectionResponse).replacement?.return.id;
    expect(activeId).toBeDefined();
    if (!activeId) throw new Error('Second replacement Return is missing.');

    const predecessor = await request(server)
      .get(`/v1/returns/${original.return.id}`)
      .set(authorized())
      .expect(200);
    expect(predecessor.body).toMatchObject({
      return: {
        lifecycle: { status: 'cancelled', activeLeaf: false, correction: { type: 'REPLACE' } },
        lineage: { predecessorReturnId: null, successorReturnId: successorId },
      },
    });
    const active = await request(server)
      .get(`/v1/returns/${activeId}`)
      .set(authorized())
      .expect(200);
    expect(active.body).toMatchObject({
      return: {
        lifecycle: { status: 'posted', activeLeaf: true, correction: null },
        lineage: { predecessorReturnId: successorId, successorReturnId: null },
      },
    });
    const eligibility = await request(server)
      .get(`/v1/sales/${sale.body.sale.id}/return-eligibility`)
      .set(authorized())
      .expect(200);
    expect(eligibility.body).toMatchObject({
      lines: [
        {
          originalQuantityMilli: '2000',
          returnedQuantityMilli: '250',
          remainingQuantityMilli: '1750',
        },
      ],
    });
    const activeCount = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.sale_returns
       where store_id=$1 and sale_id=$2 and status='posted'`,
      [owner.storeId, sale.body.sale.id],
    );
    expect(activeCount.rows[0]).toEqual({ count: 1 });
  });

  it('rolls back an invalid replacement and distinguishes historical from new account eligibility', async () => {
    const saleAccount = await createAccount();
    const refundAccount = await createAccount();
    const sale = await postManualSale({ accountId: saleAccount });
    const posted = await postReturn(
      sale.body.sale.id,
      returnRequest(sale.body, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: refundAccount },
      }),
    );
    await db().admin.query(
      `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, refundAccount],
    );
    const failedOperation = randomUUID();
    expect(
      (
        await replaceReturn(
          posted.return.id,
          replaceBody(sale.body, failedOperation, {
            residualSettlement: { choice: 'REFUND', moneyAccountId: refundAccount },
          }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_REFUND_ACCOUNT_UNAVAILABLE' });
    expect(await accountBalance(refundAccount)).toBe('-500');
    const rollback = await db().admin.query(
      `select
         (select status from ledger.sale_returns where store_id=$1 and id=$2) as status,
         (select count(*)::int from ledger.money_movements
          where store_id=$1 and transaction_group_id=$3) as reversals,
         (select status from sync.processed_operations
          where store_id=$1 and operation_id=$3) as operation_status`,
      [owner.storeId, posted.return.id, failedOperation],
    );
    expect(rollback.rows[0]).toEqual({
      status: 'posted',
      reversals: 0,
      operation_status: 'rejected',
    });

    await cancelReturn(posted.return.id, cancelBody()).expect(201);
    expect(await accountBalance(refundAccount)).toBe('0');
  });

  it('revalidates replacement Product and Customer Credit eligibility after exact old reversal', async () => {
    const accountId = await createAccount();
    const product = await createProduct();
    await seedInventory(product, '2000', '200');
    const trackedSale = await postTrackedSale(product, accountId);
    const damaged = await postReturn(
      trackedSale.sale.id,
      returnRequest(trackedSale, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    await db().admin.query(
      `update ledger.products set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, product.productId],
    );
    expect(
      (
        await replaceReturn(
          damaged.return.id,
          replaceBody(trackedSale, randomUUID(), {
            disposition: 'RESTOCK_SALEABLE',
            residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
          }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_RESTOCK_UNAVAILABLE' });

    const customerId = await createCustomer();
    const customerSale = await postManualSale({ customerId, accountId });
    const customerReturn = await postReturn(
      customerSale.body.sale.id,
      returnRequest(customerSale.body, {
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, customerId],
    );
    expect(
      (
        await replaceReturn(
          customerReturn.return.id,
          replaceBody(customerSale.body, randomUUID(), {
            residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
          }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_CUSTOMER_RESTORE_REQUIRED' });
    expect(
      (
        await db().admin.query<{ status: string }>(
          `select status from ledger.sale_returns where store_id=$1 and id=any($2::uuid[])
           order by id`,
          [owner.storeId, [damaged.return.id, customerReturn.return.id]],
        )
      ).rows.map((row) => row.status),
    ).toEqual(['posted', 'posted']);
  });

  it('posts correction in the current open S9 period without reopening the closed original period', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(sale.body.sale.id, returnRequest(sale.body));
    const [yearText, monthText] = businessDate.split('-');
    const correctionAt = new Date(
      Date.UTC(Number(yearText), Number(monthText), 15, 10, 0, 0),
    ).toISOString();
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, periodId],
    );
    try {
      const correction = await cancelReturn(
        posted.return.id,
        cancelBody(randomUUID(), correctionAt),
      ).expect(201);
      expect(correction.body).toMatchObject({
        outcome: { status: 'cancelled' },
      });
      expect((correction.body as SaleReturnCorrectionResponse).accountingPeriodId).not.toBe(
        periodId,
      );
      expect(
        (
          await db().admin.query<{ status: string }>(
            `select status from ledger.accounting_periods where store_id=$1 and id=$2`,
            [owner.storeId, periodId],
          )
        ).rows[0],
      ).toEqual({ status: 'closed' });
    } finally {
      await db().admin.query(
        `update ledger.accounting_periods set status='open',closed_at=null
         where store_id=$1 and id=$2`,
        [owner.storeId, periodId],
      );
    }
  });

  it('allows late cancel and only non-expansive late replacement merchandise scope', async () => {
    const customerId = await createCustomer();
    const sale = await postTwoLineSale(customerId);
    const original = await postReturn(sale.sale.id, returnRequest(sale, { quantityMilli: '1000' }));
    await db().admin.query(`update ledger.sales set sale_at=$3 where store_id=$1 and id=$2`, [
      owner.storeId,
      sale.sale.id,
      new Date(acceptedAt.getTime() - 49 * 60 * 60 * 1000).toISOString(),
    ]);

    const reduced = await replaceReturn(
      original.return.id,
      replaceBody(sale, randomUUID(), { quantityMilli: '500' }),
    ).expect(201);
    const activeId = (reduced.body as SaleReturnCorrectionResponse).replacement?.return.id;
    if (!activeId) throw new Error('Late replacement Return is missing.');
    expect(
      (
        await replaceReturn(
          activeId,
          replaceBody(sale, randomUUID(), { quantityMilli: '501' }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_CORRECTION_SCOPE_EXPANDED' });
    expect(
      (
        await replaceReturn(
          activeId,
          replaceBody(sale, randomUUID(), { lineIndex: 1, quantityMilli: '1' }),
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_CORRECTION_SCOPE_EXPANDED' });
    await cancelReturn(activeId, cancelBody()).expect(201);
    expect(
      (
        await request(server)
          .post(`/v1/sales/${sale.sale.id}/return`)
          .set(authorized())
          .send(returnRequest(sale, { quantityMilli: '1' }))
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'SALE_RETURN_WINDOW_EXPIRED' });
  });

  it('fails closed for unauthenticated, foreign-tenant, and read_only correction attempts', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(sale.body.sale.id, returnRequest(sale.body));
    await request(server)
      .post(`/v1/returns/${posted.return.id}/cancel`)
      .send(cancelBody())
      .expect(401);
    expect(
      (await cancelReturn(posted.return.id, cancelBody(), foreignOwner).expect(404)).body,
    ).toMatchObject({ code: 'SALE_RETURN_CORRECTION_TARGET_NOT_FOUND' });
    await cancelReturn(posted.return.id, cancelBody(), readOnlyOwner).expect(403);
    expect(
      (
        await db().admin.query<{ status: string }>(
          `select status from ledger.sale_returns where store_id=$1 and id=$2`,
          [owner.storeId, posted.return.id],
        )
      ).rows[0],
    ).toEqual({ status: 'posted' });
  });

  it('serializes cancel against replace on the same active Return', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(sale.body.sale.id, returnRequest(sale.body));
    const outcomes = await Promise.all([
      cancelReturn(posted.return.id, cancelBody()),
      replaceReturn(posted.return.id, replaceBody(sale.body)),
    ]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([201, 409]);
    const roots = await db().admin.query<{ active: number; cancelled: number }>(
      `select count(*) filter(where status='posted')::int as active,
              count(*) filter(where status='cancelled')::int as cancelled
       from ledger.sale_returns where store_id=$1 and sale_id=$2`,
      [owner.storeId, sale.body.sale.id],
    );
    expect(roots.rows[0]?.active).toBeLessThanOrEqual(1);
    expect(roots.rows[0]?.cancelled).toBe(1);
  });

  it('serializes competing replacements to one successor maximum', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(sale.body.sale.id, returnRequest(sale.body));
    const outcomes = await Promise.all([
      replaceReturn(posted.return.id, replaceBody(sale.body)),
      replaceReturn(posted.return.id, replaceBody(sale.body)),
    ]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([201, 409]);
    const roots = await db().admin.query<{ active: number; total: number }>(
      `select count(*) filter(where status='posted')::int as active,count(*)::int as total
       from ledger.sale_returns where store_id=$1 and sale_id=$2`,
      [owner.storeId, sale.body.sale.id],
    );
    expect(roots.rows[0]).toEqual({ active: 1, total: 2 });
  });

  it('collapses concurrent identical correction operation IDs to one economic effect', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(sale.body.sale.id, returnRequest(sale.body));
    const operationId = randomUUID();
    const command = cancelBody(operationId);
    const outcomes = await Promise.all([
      cancelReturn(posted.return.id, command),
      cancelReturn(posted.return.id, command),
    ]);
    expect(outcomes.map((response) => response.status)).toEqual([201, 201]);
    expect(outcomes[1].body).toEqual(outcomes[0].body);
    const effects = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.customer_ledger_entries
       where store_id=$1 and transaction_group_id=$2`,
      [owner.storeId, operationId],
    );
    expect(effects.rows[0]).toEqual({ count: 1 });
    expect(
      (
        await cancelReturn(posted.return.id, {
          ...command,
          reason: 'Changed correction payload',
        }).expect(409)
      ).body,
    ).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
  });

  it('serializes Return correction against a new Return on the same Sale line', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({
      customerId,
      quantityMilli: '2000',
      lineTotalMinor: '1000',
    });
    const existing = await postReturn(
      sale.body.sale.id,
      returnRequest(sale.body, { quantityMilli: '1000' }),
    );
    const newReturn = returnRequest(sale.body, { quantityMilli: '1000' });
    const outcomes = await Promise.all([
      cancelReturn(existing.return.id, cancelBody()),
      request(server)
        .post(`/v1/sales/${sale.body.sale.id}/return`)
        .set(authorized())
        .send(newReturn),
    ]);
    expect(outcomes.map((response) => response.status)).toEqual([201, 201]);
    const eligibility = await request(server)
      .get(`/v1/sales/${sale.body.sale.id}/return-eligibility`)
      .set(authorized())
      .expect(200);
    expect(eligibility.body).toMatchObject({
      lines: [{ returnedQuantityMilli: '1000', remainingQuantityMilli: '1000' }],
    });
  });

  it('serializes Return correction against Customer Credit consumption without negative Credit', async () => {
    const customerId = await createCustomer();
    const accountId = await createAccount();
    const sourceSale = await postManualSale({ customerId, accountId });
    const posted = await postReturn(
      sourceSale.body.sale.id,
      returnRequest(sourceSale.body, {
        residualSettlement: { choice: 'KEEP_AS_CUSTOMER_CREDIT' },
      }),
    );
    const spend = {
      operationId: randomUUID(),
      customerId,
      occurredAt,
      items: [
        {
          isManualLine: true,
          description: 'Concurrent Customer Credit spend',
          unitName: 'piece',
          quantityMilli: '1000',
          unitPriceMinor: '500',
          lineTotalMinor: '500',
        },
      ],
      payments: [],
      customerCreditAmountMinor: '500',
      totalMinor: '500',
    };
    const outcomes = await Promise.all([
      cancelReturn(posted.return.id, cancelBody()),
      request(server).post('/v1/sales').set(authorized()).send(spend),
    ]);
    expect(outcomes.filter((response) => response.status === 201)).toHaveLength(1);
    expect(outcomes.filter((response) => response.status === 409)).toHaveLength(1);
    const balance = await customerBalances(customerId);
    expect(BigInt(balance.credit)).toBeGreaterThanOrEqual(0n);
  });

  it('serializes Return correction against Customer collection to one valid Receivable outcome', async () => {
    const customerId = await createCustomer();
    const accountId = await createAccount();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(
      sale.body.sale.id,
      returnRequest(sale.body, { quantityMilli: '400' }),
    );
    const outcomes = await Promise.all([
      cancelReturn(posted.return.id, cancelBody()),
      request(server)
        .post(`/v1/customers/${customerId}/payments`)
        .set(authorized())
        .send({
          operationId: randomUUID(),
          occurredAt,
          allocationMode: 'fifo',
          tenders: [{ moneyAccountId: accountId, amountMinor: '300' }],
        }),
    ]);
    expect(outcomes.map((response) => response.status)).toEqual([201, 201]);
    expect(await customerBalances(customerId)).toEqual({ receivable: '200', credit: '0' });
  });

  it('serializes restock correction against inventory activity under S11 projection authority', async () => {
    const accountId = await createAccount();
    const product = await createProduct();
    await seedInventory(product, '2000', '200');
    const sale = await postTrackedSale(product, accountId);
    const posted = await postReturn(
      sale.sale.id,
      returnRequest(sale, {
        disposition: 'RESTOCK_SALEABLE',
        residualSettlement: { choice: 'REFUND', moneyAccountId: accountId },
      }),
    );
    const outcomes = await Promise.all([
      cancelReturn(posted.return.id, cancelBody()),
      request(server).post('/v1/inventory/decrease').set(authorized()).send({
        operationId: randomUUID(),
        productId: product.productId,
        productUnitId: product.unitId,
        selectedQuantityMilli: '1000',
        occurredAt,
        reason: 'Concurrent inventory activity',
      }),
    ]);
    expect(outcomes.filter((response) => response.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(outcomes.every((response) => [201, 409].includes(response.status))).toBe(true);
    const projection = await stock(product.productId);
    expect(['0', '1000']).toContain(projection.quantity);
    expect(BigInt(projection.quantity)).toBeGreaterThanOrEqual(0n);
    const reversals = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.inventory_movements child
       join ledger.inventory_movements original
         on original.store_id=child.store_id and original.id=child.reversal_of_id
       where child.store_id=$1 and original.reference_id=$2`,
      [owner.storeId, posted.return.id],
    );
    expect(reversals.rows[0]?.count).toBeLessThanOrEqual(1);
  });

  it('serializes Return correction against Sale correction without stale dependencies', async () => {
    const customerId = await createCustomer();
    const sale = await postManualSale({ customerId });
    const posted = await postReturn(sale.body.sale.id, returnRequest(sale.body));
    const outcomes = await Promise.all([
      cancelReturn(posted.return.id, cancelBody()),
      request(server)
        .post(`/v1/sales/${sale.body.operationId}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt }),
    ]);
    expect(outcomes[0].status).toBe(201);
    expect([201, 409]).toContain(outcomes[1].status);
    const state = await db().admin.query<{ saleStatus: string; activeReturns: number }>(
      `select sale.status as "saleStatus",
              (select count(*)::int from ledger.sale_returns r
               where r.store_id=sale.store_id and r.sale_id=sale.id and r.status='posted')
                as "activeReturns"
       from ledger.sales sale where sale.store_id=$1 and sale.id=$2`,
      [owner.storeId, sale.body.sale.id],
    );
    expect(state.rows[0]?.activeReturns).toBe(0);
    expect(['posted', 'cancelled']).toContain(state.rows[0]?.saleStatus);
  });
});
