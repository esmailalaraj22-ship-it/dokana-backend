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
import type { SaleCorrectionResponse } from '../src/sales/sale-correction.types';
import type { SalePostingResponse } from '../src/sales/sale-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0015_sale_customer_credit_tender.sql';
const augustInstant = '2026-08-15T10:00:00Z';
const augustCorrectionInstant = '2026-08-16T10:00:00Z';

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

const ownerStoreId = randomUUID();
const owner: Identity = {
  storeId: ownerStoreId,
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s145-owner-${randomUUID()}@example.test`,
  role: 'owner',
  token: '',
};
const manager: Identity = {
  storeId: ownerStoreId,
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s145-manager-${randomUUID()}@example.test`,
  role: 'manager',
  token: '',
};
const foreignOwner: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s145-foreign-${randomUUID()}@example.test`,
  role: 'owner',
  token: '',
};
const readOnlyOwner: Identity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s145-read-only-${randomUUID()}@example.test`,
  role: 'owner',
  token: '',
};
const identities = [owner, manager, foreignOwner, readOnlyOwner];
const customers = {
  active: randomUUID(),
  archivedHistory: randomUUID(),
  foreign: randomUUID(),
};

describe('S14.5 Sale corrections on isolated PostgreSQL', () => {
  jest.setTimeout(240_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S14.5 database is unavailable.');
    return database;
  }

  function postSale(body: Record<string, unknown>, identity: Identity = owner): request.Test {
    return request(server)
      .post('/v1/sales')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function cancelSale(
    targetOperationId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/sales/${targetOperationId}/cancel`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function editSale(
    targetOperationId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/sales/${targetOperationId}/edit`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function manualSale(input: {
    operationId?: string;
    customerId?: string;
    totalMinor?: string;
    customerCreditAmountMinor?: string;
    payments?: { moneyAccountId: string; amountMinor: string }[];
    occurredAt?: string;
  }): Record<string, unknown> {
    const totalMinor = input.totalMinor ?? '500';
    return {
      operationId: input.operationId ?? randomUUID(),
      customerId: input.customerId,
      occurredAt: input.occurredAt ?? augustInstant,
      items: [
        {
          isManualLine: true,
          description: 'S14.5 manual line',
          unitName: 'service',
          quantityMilli: '1000',
          unitPriceMinor: totalMinor,
          lineTotalMinor: totalMinor,
        },
      ],
      payments: input.payments ?? [],
      totalMinor,
      ...(input.customerCreditAmountMinor === undefined
        ? {}
        : { customerCreditAmountMinor: input.customerCreditAmountMinor }),
    };
  }

  async function createCustomer(): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.customers(
         id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
       ) values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,
         'active',$3,$4)`,
      [id, owner.storeId, owner.deviceId, randomUUID()],
    );
    return id;
  }

  async function createCustomerCredit(
    customerId: string,
    accountId: string,
    amountMinor: string,
  ): Promise<void> {
    await request(server)
      .post(`/v1/customers/${customerId}/payments`)
      .set('authorization', `Bearer ${owner.token}`)
      .send({
        operationId: randomUUID(),
        occurredAt: '2026-08-14T10:00:00Z',
        intent: 'customer_advance',
        tenders: [{ moneyAccountId: accountId, amountMinor }],
      })
      .expect(201);
  }

  function productSale(input: {
    product: ProductFixture;
    operationId?: string;
    customerId?: string;
    quantityMilli?: string;
    unitPriceMinor?: string;
    totalMinor?: string;
    payments?: { moneyAccountId: string; amountMinor: string }[];
  }): Record<string, unknown> {
    const quantityMilli = input.quantityMilli ?? '1000';
    const unitPriceMinor = input.unitPriceMinor ?? '500';
    const totalMinor = input.totalMinor ?? unitPriceMinor;
    return {
      operationId: input.operationId ?? randomUUID(),
      customerId: input.customerId,
      occurredAt: augustInstant,
      items: [
        {
          isManualLine: false,
          productId: input.product.productId,
          productUnitId: input.product.unitId,
          quantityMilli,
          unitPriceMinor,
          lineTotalMinor: totalMinor,
        },
      ],
      payments: input.payments ?? [],
      totalMinor,
    };
  }

  function replacementBody(command: Record<string, unknown>): Record<string, unknown> {
    const replacement = { ...command };
    delete replacement.operationId;
    delete replacement.occurredAt;
    return replacement;
  }

  async function createAccount(
    identity: Identity = owner,
    status: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,'transfer','available',$3,
         case when $3='archived' then clock_timestamp() else null end,$4)`,
      [id, identity.storeId, status, randomUUID()],
    );
    return id;
  }

  async function createProduct(
    options: {
      tracked?: boolean;
      allowNegative?: boolean;
      identity?: Identity;
      status?: 'active' | 'archived';
    } = {},
  ): Promise<ProductFixture> {
    const identity = options.identity ?? owner;
    const productId = randomUUID();
    const unitId = randomUUID();
    const status = options.status ?? 'active';
    await db().admin.query(
      `insert into ledger.products(
         id,store_id,name,normalized_name,measurement_type,track_inventory,
         allow_negative_stock_override,status,archived_at,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,'count',$3,$4,$5,
         case when $5='archived' then clock_timestamp() else null end,$6)`,
      [
        productId,
        identity.storeId,
        options.tracked ?? true,
        options.allowNegative ?? null,
        status,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.product_units(
         id,store_id,product_id,measurement_type,unit_name,is_base,
         factor_num,factor_den,status,operation_id)
       values($1,$2,$3,'count',$1::uuid::text,true,1,1,$4,$5)`,
      [unitId, identity.storeId, productId, status, randomUUID()],
    );
    return { productId, unitId };
  }

  async function seedInventory(
    product: ProductFixture,
    quantityMilli: string,
    costMinor?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      operationId: randomUUID(),
      productId: product.productId,
      productUnitId: product.unitId,
      selectedQuantityMilli: quantityMilli,
      occurredAt: '2026-08-01T10:00:00Z',
    };
    if (costMinor !== undefined) body.totalPurchaseCostMinor = costMinor;
    await request(server)
      .post('/v1/inventory/increase')
      .set('authorization', `Bearer ${owner.token}`)
      .send(body)
      .expect(201);
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
      throw new Error('S14.5 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s145-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s145-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const storeId of new Set(identities.map((identity) => identity.storeId))) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S14.5 fixture','active')`,
        [storeId],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [storeId]);
    }
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S14.5 fixture')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,$4,'active')`,
        [randomUUID(), identity.storeId, identity.userId, identity.role],
      );
    }
    for (const [customerId, identity] of [
      [customers.active, owner],
      [customers.archivedHistory, owner],
      [customers.foreign, foreignOwner],
    ] as const) {
      await db().admin.query(
        `insert into ledger.customers(
           id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id)
         values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,
           'active',$3,$4)`,
        [customerId, identity.storeId, identity.deviceId, randomUUID()],
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
          deviceName: 'S14.5 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S14.5 login token is missing.');
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

  it('cancels paid, partial, credit, split-tender, tracked, and bigint Sales exactly once', async () => {
    const [accountA, accountB] = await Promise.all([createAccount(), createAccount()]);
    const product = await createProduct();
    await seedInventory(product, '5000', '1000');

    const paidCommand = productSale({
      product,
      payments: [
        { moneyAccountId: accountA, amountMinor: '200' },
        { moneyAccountId: accountB, amountMinor: '300' },
      ],
    });
    const partialCommand = manualSale({
      customerId: customers.active,
      payments: [{ moneyAccountId: accountA, amountMinor: '200' }],
    });
    const creditCommand = manualSale({
      customerId: customers.active,
      totalMinor: '9007199254740993',
    });
    const paid = (await postSale(paidCommand).expect(201)).body as SalePostingResponse;
    const partial = (await postSale(partialCommand).expect(201)).body as SalePostingResponse;
    const credit = (await postSale(creditCommand).expect(201)).body as SalePostingResponse;
    const commands = [paidCommand, partialCommand, creditCommand];
    const posted = [paid, partial, credit];
    const corrections: Record<string, unknown>[] = [];

    for (const source of commands) {
      const correction = { operationId: randomUUID(), occurredAt: augustCorrectionInstant };
      corrections.push(correction);
      const response = await cancelSale(source.operationId as string, correction).expect(201);
      expect(response.body).toMatchObject({
        operationId: correction.operationId,
        targetOperationId: source.operationId,
        intent: 'cancel',
        outcome: { status: 'cancelled' },
        currentSale: null,
      });
      expect(JSON.stringify(response.body)).not.toContain('reversalOfId');
    }

    const state = await db().admin.query<{ status: string }>(
      `select status from ledger.sales where store_id=$1 and id=any($2::uuid[]) order by id`,
      [owner.storeId, posted.map((item) => item.sale.id)],
    );
    expect(state.rows.map((row) => row.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    const money = await db().admin.query<{ original: string; reversed: string; count: number }>(
      `select coalesce(sum(origin.amount_delta_minor),0)::text as original,
              coalesce(sum(reversal.amount_delta_minor),0)::text as reversed,
              count(reversal.id)::int as count
       from ledger.money_movements origin
       left join ledger.money_movements reversal
         on reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id
       where origin.store_id=$1 and origin.id=any($2::uuid[])`,
      [owner.storeId, [...paid.payments, ...partial.payments].map((item) => item.moneyMovementId)],
    );
    expect(money.rows[0]).toEqual({ original: '700', reversed: '-700', count: 3 });
    const receivables = await db().admin.query<{
      original: string;
      reversed: string;
      count: number;
    }>(
      `select sum(origin.receivable_delta_minor)::text as original,
              sum(reversal.receivable_delta_minor)::text as reversed,
              count(reversal.id)::int as count
       from ledger.customer_ledger_entries origin
       join ledger.customer_ledger_entries reversal
         on reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id
       where origin.store_id=$1 and origin.id=any($2::uuid[])`,
      [owner.storeId, [partial.receivable?.id, credit.receivable?.id]],
    );
    expect(receivables.rows[0]).toEqual({
      original: '9007199254741293',
      reversed: '-9007199254741293',
      count: 2,
    });
    expect(
      (
        await db().admin.query(
          `select quantity_milli::text as quantity, inventory_value_minor::text as value,
                  cost_state as "costState"
           from ledger.stock_balances where store_id=$1 and product_id=$2`,
          [owner.storeId, product.productId],
        )
      ).rows[0],
    ).toEqual({ quantity: '5000', value: '1000', costState: 'known' });

    const replay = await cancelSale(
      commands[0]?.operationId as string,
      corrections[0] ?? {},
    ).expect(201);
    expect(replay.body).toMatchObject({ operationId: corrections[0]?.operationId });
    await cancelSale(commands[0]?.operationId as string, {
      ...corrections[0],
      occurredAt: '2026-08-17T10:00:00Z',
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    await request(server)
      .get(`/v1/sales/${paid.sale.id}`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ sale: { status: 'cancelled' } }));
  });

  it('edits by reversing first, posts a larger replacement, and preserves one linear leaf', async () => {
    const [accountA, accountB] = await Promise.all([createAccount(), createAccount()]);
    const product = await createProduct();
    await seedInventory(product, '1000', '100');
    const sourceCommand = productSale({
      product,
      quantityMilli: '800',
      unitPriceMinor: '500',
      totalMinor: '400',
      payments: [{ moneyAccountId: accountA, amountMinor: '400' }],
    });
    const source = (await postSale(sourceCommand).expect(201)).body as SalePostingResponse;
    const editOperationId = randomUUID();
    const edited = (
      await editSale(sourceCommand.operationId as string, {
        operationId: editOperationId,
        occurredAt: augustCorrectionInstant,
        replacement: {
          customerId: customers.active,
          items: [
            {
              isManualLine: false,
              productId: product.productId,
              productUnitId: product.unitId,
              quantityMilli: '1000',
              unitPriceMinor: '700',
              lineTotalMinor: '700',
            },
          ],
          payments: [{ moneyAccountId: accountB, amountMinor: '200' }],
          totalMinor: '700',
        },
      }).expect(201)
    ).body as SaleCorrectionResponse;
    expect(edited).toMatchObject({
      intent: 'edit',
      outcome: { status: 'posted' },
      currentSale: {
        operationId: editOperationId,
        sale: { paymentStatus: 'partial', paidTotalMinor: '200', creditTotalMinor: '500' },
      },
    });
    if (edited.currentSale === null) throw new Error('Expected S14.5 replacement Sale.');
    const replacement = edited.currentSale;
    expect(
      (
        await db().admin.query(
          `select old.status,old.reversed_by_id as "reversedById",
                  current.correction_of_id as "correctionOfId",current.status as "currentStatus"
           from ledger.sales old join ledger.sales current on current.id=$3
           where old.store_id=$1 and old.id=$2`,
          [owner.storeId, source.sale.id, replacement.sale.id],
        )
      ).rows[0],
    ).toEqual({
      status: 'corrected',
      reversedById: replacement.sale.id,
      correctionOfId: source.sale.id,
      currentStatus: 'posted',
    });
    expect(
      (
        await db().admin.query(
          `select quantity_milli::text as quantity,inventory_value_minor::text as value
           from ledger.stock_balances where store_id=$1 and product_id=$2`,
          [owner.storeId, product.productId],
        )
      ).rows[0],
    ).toEqual({ quantity: '0', value: '0' });
    expect(
      (
        await db().admin.query(
          `select
             coalesce(sum(amount_delta_minor) filter(where account_id=$2),0)::text as first,
             coalesce(sum(amount_delta_minor) filter(where account_id=$3),0)::text as second
           from ledger.money_movements where store_id=$1`,
          [owner.storeId, accountA, accountB],
        )
      ).rows[0],
    ).toEqual({ first: '0', second: '200' });

    await cancelSale(sourceCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SALE_CORRECTION_TARGET_NOT_ACTIVE' }),
      );
    await request(server)
      .get(`/v1/sales/${replacement.sale.id}`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          sale: { correctionOfId: source.sale.id, status: 'posted' },
          receivable: { outstandingMinor: '500' },
        }),
      );
  });

  it('preserves unknown and pending inventory cost semantics during cancellation', async () => {
    const account = await createAccount();
    const unknownProduct = await createProduct();
    const pendingProduct = await createProduct({ allowNegative: true });
    await seedInventory(unknownProduct, '2000');
    const command = {
      operationId: randomUUID(),
      occurredAt: augustInstant,
      items: [unknownProduct, pendingProduct].map((product) => ({
        isManualLine: false,
        productId: product.productId,
        productUnitId: product.unitId,
        quantityMilli: '1000',
        unitPriceMinor: '100',
        lineTotalMinor: '100',
      })),
      payments: [{ moneyAccountId: account, amountMinor: '200' }],
      totalMinor: '200',
    };
    const posted = (await postSale(command).expect(201)).body as SalePostingResponse;
    expect(posted.items.map((item) => item.costStatus).sort()).toEqual(['pending', 'unknown']);
    await cancelSale(command.operationId, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    }).expect(201);
    const reversals = await db().admin.query<{
      origin: string;
      reversal: string;
      value: string;
    }>(
      `select origin.cost_status as origin,reversal.cost_status as reversal,
              reversal.value_delta_minor::text as value
       from ledger.inventory_movements origin
       join ledger.inventory_movements reversal
         on reversal.store_id=origin.store_id and reversal.reversal_of_id=origin.id
       where origin.store_id=$1 and origin.id=any($2::uuid[]) order by origin.cost_status`,
      [
        owner.storeId,
        posted.items.flatMap((item) =>
          item.inventoryMovementId ? [item.inventoryMovementId] : [],
        ),
      ],
    );
    expect(reversals.rows).toEqual([
      { origin: 'pending', reversal: 'pending', value: '0' },
      { origin: 'unknown', reversal: 'unknown', value: '0' },
    ]);
    const balances = await db().admin.query<{ productId: string; quantity: string; state: string }>(
      `select product_id as "productId",quantity_milli::text as quantity,cost_state as state
       from ledger.stock_balances where store_id=$1 and product_id=any($2::uuid[])
       order by product_id`,
      [owner.storeId, [unknownProduct.productId, pendingProduct.productId]],
    );
    const byProduct = new Map(balances.rows.map((row) => [row.productId, row]));
    expect(byProduct.get(unknownProduct.productId)).toMatchObject({
      quantity: '2000',
      state: 'unknown',
    });
    expect(byProduct.get(pendingProduct.productId)).toMatchObject({
      quantity: '0',
      state: 'known',
    });
  });

  it('reverses archived historical entities but rolls back an unavailable replacement', async () => {
    const historicalAccount = await createAccount();
    const replacementAccount = await createAccount();
    const historicalProduct = await createProduct();
    await seedInventory(historicalProduct, '2000', '200');
    const historicalCommand = productSale({
      product: historicalProduct,
      customerId: customers.archivedHistory,
      payments: [{ moneyAccountId: historicalAccount, amountMinor: '200' }],
    });
    const historical = (await postSale(historicalCommand).expect(201)).body as SalePostingResponse;
    await Promise.all([
      db().admin.query(
        `update ledger.customers set status='archived',archived_at=clock_timestamp() where id=$1`,
        [customers.archivedHistory],
      ),
      db().admin.query(
        `update ledger.products set status='archived',archived_at=clock_timestamp() where id=$1`,
        [historicalProduct.productId],
      ),
      db().admin.query(`update ledger.product_units set status='archived' where id=$1`, [
        historicalProduct.unitId,
      ]),
      db().admin.query(
        `update ledger.money_accounts set status='archived',archived_at=clock_timestamp() where id=$1`,
        [historicalAccount],
      ),
    ]);
    await editSale(historicalCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
      replacement: replacementBody(
        manualSale({
          payments: [{ moneyAccountId: replacementAccount, amountMinor: '500' }],
        }),
      ),
    }).expect(201);
    expect(
      (await db().admin.query(`select status from ledger.sales where id=$1`, [historical.sale.id]))
        .rows[0],
    ).toEqual({ status: 'corrected' });

    const rollbackAccount = await createAccount();
    const rollbackCommand = manualSale({
      payments: [{ moneyAccountId: rollbackAccount, amountMinor: '500' }],
    });
    const rollbackSale = (await postSale(rollbackCommand).expect(201)).body as SalePostingResponse;
    const archivedReplacement = await createProduct({ status: 'archived' });
    const failedOperationId = randomUUID();
    await editSale(rollbackCommand.operationId as string, {
      operationId: failedOperationId,
      occurredAt: augustCorrectionInstant,
      replacement: replacementBody(
        productSale({
          product: archivedReplacement,
          payments: [{ moneyAccountId: rollbackAccount, amountMinor: '500' }],
        }),
      ),
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'PRODUCT_UNAVAILABLE' }));
    expect(
      (
        await db().admin.query<{ status: string; reversals: number }>(
          `select sale.status,
             (select count(*)::int from ledger.money_movements
                where store_id=sale.store_id and reversal_of_id=$2) as reversals
           from ledger.sales sale where sale.id=$1`,
          [rollbackSale.sale.id, rollbackSale.payments[0]?.moneyMovementId],
        )
      ).rows[0],
    ).toEqual({ status: 'posted', reversals: 0 });
  });

  it('reverses Sale-owned Customer Credit tenders exactly through cancellation and replacement', async () => {
    const account = await createAccount();

    const fullCustomer = await createCustomer();
    await createCustomerCredit(fullCustomer, account, '500');
    const fullCommand = manualSale({
      customerId: fullCustomer,
      customerCreditAmountMinor: '500',
    });
    const full = (await postSale(fullCommand).expect(201)).body as SalePostingResponse;
    const fullCorrection = { operationId: randomUUID(), occurredAt: augustCorrectionInstant };
    const cancelled = await cancelSale(fullCommand.operationId as string, fullCorrection).expect(
      201,
    );
    expect(cancelled.body).toMatchObject({ intent: 'cancel', outcome: { status: 'cancelled' } });
    await cancelSale(fullCommand.operationId as string, fullCorrection).expect(201);
    expect(
      (
        await db().admin.query(
          `select credit_minor::text as credit from ledger.v_customer_balances
           where store_id=$1 and customer_id=$2`,
          [owner.storeId, fullCustomer],
        )
      ).rows[0],
    ).toEqual({ credit: '500' });
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.customer_ledger_entries
           where store_id=$1 and reversal_of_id=$2`,
          [owner.storeId, full.customerCreditTender?.customerLedgerEntryId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const cashCreditCustomer = await createCustomer();
    await createCustomerCredit(cashCreditCustomer, account, '200');
    const cashCreditCommand = manualSale({
      customerId: cashCreditCustomer,
      customerCreditAmountMinor: '200',
      payments: [{ moneyAccountId: account, amountMinor: '300' }],
    });
    const cashCredit = (await postSale(cashCreditCommand).expect(201)).body as SalePostingResponse;
    await cancelSale(cashCreditCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    }).expect(201);

    const creditDebtCustomer = await createCustomer();
    await createCustomerCredit(creditDebtCustomer, account, '200');
    const creditDebtCommand = manualSale({
      customerId: creditDebtCustomer,
      customerCreditAmountMinor: '200',
    });
    const creditDebt = (await postSale(creditDebtCommand).expect(201)).body as SalePostingResponse;
    await cancelSale(creditDebtCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    }).expect(201);

    const mixedCustomer = await createCustomer();
    await createCustomerCredit(mixedCustomer, account, '200');
    const mixedCommand = manualSale({
      customerId: mixedCustomer,
      customerCreditAmountMinor: '200',
      payments: [{ moneyAccountId: account, amountMinor: '100' }],
    });
    const mixed = (await postSale(mixedCommand).expect(201)).body as SalePostingResponse;
    await cancelSale(mixedCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    }).expect(201);

    const reversalFacts = (
      await db().admin.query<{
        money: number;
        credit: number;
        receivable: number;
      }>(
        `select
          (select count(*)::int from ledger.money_movements
             where store_id=$1 and reversal_of_id=any($2::uuid[])) as money,
          (select count(*)::int from ledger.customer_ledger_entries
             where store_id=$1 and reversal_of_id=any($3::uuid[])) as credit,
          (select count(*)::int from ledger.customer_ledger_entries
             where store_id=$1 and reversal_of_id=any($4::uuid[])) as receivable`,
        [
          owner.storeId,
          [cashCredit.payments[0]?.moneyMovementId, mixed.payments[0]?.moneyMovementId],
          [
            cashCredit.customerCreditTender?.customerLedgerEntryId,
            creditDebt.customerCreditTender?.customerLedgerEntryId,
            mixed.customerCreditTender?.customerLedgerEntryId,
          ],
          [creditDebt.receivable?.id, mixed.receivable?.id],
        ],
      )
    ).rows[0];
    expect(reversalFacts).toEqual({ money: 2, credit: 3, receivable: 2 });

    const replacementCustomer = await createCustomer();
    await createCustomerCredit(replacementCustomer, account, '100');
    const replacementSource = manualSale({
      customerId: replacementCustomer,
      totalMinor: '100',
      customerCreditAmountMinor: '100',
    });
    const replacementOriginal = (await postSale(replacementSource).expect(201))
      .body as SalePostingResponse;
    const replacementOperationId = randomUUID();
    const replaced = (
      await editSale(replacementSource.operationId as string, {
        operationId: replacementOperationId,
        occurredAt: augustCorrectionInstant,
        replacement: replacementBody(
          manualSale({
            customerId: replacementCustomer,
            totalMinor: '50',
            customerCreditAmountMinor: '50',
          }),
        ),
      }).expect(201)
    ).body as SaleCorrectionResponse;
    expect(replaced).toMatchObject({
      intent: 'edit',
      currentSale: {
        operationId: replacementOperationId,
        customerCreditTender: { amountMinor: '50' },
      },
    });
    expect(
      (
        await db().admin.query(
          `select credit_minor::text as credit from ledger.v_customer_balances
           where store_id=$1 and customer_id=$2`,
          [owner.storeId, replacementCustomer],
        )
      ).rows[0],
    ).toEqual({ credit: '50' });
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.customer_ledger_entries
           where store_id=$1 and reversal_of_id=$2`,
          [owner.storeId, replacementOriginal.customerCreditTender?.customerLedgerEntryId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const archivedCustomer = await createCustomer();
    await createCustomerCredit(archivedCustomer, account, '100');
    const archivedCommand = manualSale({
      customerId: archivedCustomer,
      totalMinor: '100',
      customerCreditAmountMinor: '100',
    });
    const archivedSale = (await postSale(archivedCommand).expect(201)).body as SalePostingResponse;
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp() where id=$1`,
      [archivedCustomer],
    );
    await cancelSale(archivedCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    }).expect(201);
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.customer_ledger_entries
           where store_id=$1 and reversal_of_id=$2`,
          [owner.storeId, archivedSale.customerCreditTender?.customerLedgerEntryId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const dependentCustomer = await createCustomer();
    await createCustomerCredit(dependentCustomer, account, '100');
    const dependentCommand = manualSale({
      customerId: dependentCustomer,
      totalMinor: '200',
      customerCreditAmountMinor: '100',
    });
    await postSale(dependentCommand).expect(201);
    await request(server)
      .post(`/v1/customers/${dependentCustomer}/payments`)
      .set('authorization', `Bearer ${owner.token}`)
      .send({
        operationId: randomUUID(),
        occurredAt: augustCorrectionInstant,
        allocationMode: 'fifo',
        tenders: [{ moneyAccountId: account, amountMinor: '1' }],
      })
      .expect(201);
    await cancelSale(dependentCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SALE_CORRECTION_DEPENDENT_FACTS' }),
      );
  });

  it('fails closed for dependent facts and preserves closed-period rejection replay', async () => {
    const dependentCommand = manualSale({ customerId: customers.active });
    const dependent = (await postSale(dependentCommand).expect(201)).body as SalePostingResponse;
    if (!dependent.receivable) throw new Error('Expected dependent Sale receivable.');
    const dependencyAccount = await createAccount();
    const customerPaymentId = randomUUID();
    await db().admin.query(
      `insert into ledger.customer_payments(
         id,store_id,customer_id,accounting_period_id,money_account_id,amount_minor,
         allocated_total_minor,payment_at,status,device_id,operation_id)
       values($1,$2,$3,$4,$5,1,1,$6,'draft',$7,$8)`,
      [
        customerPaymentId,
        owner.storeId,
        customers.active,
        dependent.accountingPeriodId,
        dependencyAccount,
        augustInstant,
        owner.deviceId,
        randomUUID(),
      ],
    );
    await db().admin.query(
      `insert into ledger.customer_payment_allocations(
         id,store_id,customer_payment_id,sale_id,amount_minor)
       values($1,$2,$3,$4,1)`,
      [randomUUID(), owner.storeId, customerPaymentId, dependent.sale.id],
    );
    await cancelSale(dependentCommand.operationId as string, {
      operationId: randomUUID(),
      occurredAt: augustCorrectionInstant,
    })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SALE_CORRECTION_DEPENDENT_FACTS' }),
      );

    const account = await createAccount();
    const closedSource = manualSale({
      payments: [{ moneyAccountId: account, amountMinor: '500' }],
    });
    const posted = (await postSale(closedSource).expect(201)).body as SalePostingResponse;
    const boundaries = resolveAccountingPeriodBoundaries(2026, 9);
    const periodId = deriveAccountingPeriodId(owner.storeId, 2026, 9);
    await db().admin.query(
      `insert into ledger.accounting_periods(
         id,store_id,period_year,period_month,starts_at,ends_at,status,closed_at,operation_id)
       values($1,$2,2026,9,$3,$4,'closed',clock_timestamp(),$5)`,
      [periodId, owner.storeId, boundaries.startsAt, boundaries.endsAt, randomUUID()],
    );
    const correction = { operationId: randomUUID(), occurredAt: '2026-09-15T10:00:00Z' };
    await cancelSale(closedSource.operationId as string, correction)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await db().admin.query(
      `update ledger.accounting_periods set status='open',closed_at=null where id=$1`,
      [periodId],
    );
    await cancelSale(closedSource.operationId as string, correction)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await cancelSale(closedSource.operationId as string, {
      ...correction,
      occurredAt: '2026-09-16T10:00:00Z',
    })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    expect(
      (
        await db().admin.query<{ status: string; reversals: number }>(
          `select sale.status,
             (select count(*)::int from ledger.money_movements where reversal_of_id=$2) as reversals
           from ledger.sales sale where sale.id=$1`,
          [posted.sale.id, posted.payments[0]?.moneyMovementId],
        )
      ).rows[0],
    ).toEqual({ status: 'posted', reversals: 0 });
  });

  it('serializes competing corrections and enforces owner, Store, read_only, and RLS boundaries', async () => {
    const account = await createAccount();
    const sourceCommand = manualSale({
      payments: [{ moneyAccountId: account, amountMinor: '500' }],
    });
    const source = (await postSale(sourceCommand).expect(201)).body as SalePostingResponse;
    await cancelSale(
      sourceCommand.operationId as string,
      { operationId: randomUUID(), occurredAt: augustCorrectionInstant },
      foreignOwner,
    )
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SALE_CORRECTION_TARGET_NOT_FOUND' }),
      );
    await cancelSale(
      sourceCommand.operationId as string,
      { operationId: randomUUID(), occurredAt: augustCorrectionInstant },
      manager,
    )
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'SALE_WRITE_NOT_ALLOWED' }));

    const [cancelled, edited] = await Promise.all([
      cancelSale(sourceCommand.operationId as string, {
        operationId: randomUUID(),
        occurredAt: augustCorrectionInstant,
      }),
      editSale(sourceCommand.operationId as string, {
        operationId: randomUUID(),
        occurredAt: augustCorrectionInstant,
        replacement: replacementBody(
          manualSale({
            payments: [{ moneyAccountId: account, amountMinor: '500' }],
          }),
        ),
      }),
    ]);
    expect([cancelled.status, edited.status].sort()).toEqual([201, 409]);
    expect([cancelled, edited].find((response) => response.status === 409)?.body).toMatchObject({
      code: 'SALE_CORRECTION_TARGET_NOT_ACTIVE',
    });
    expect(
      (
        await db().admin.query<{ count: number }>(
          `select count(*)::int as count from ledger.money_movements where reversal_of_id=$1`,
          [source.payments[0]?.moneyMovementId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const readOnlyAccount = await createAccount(readOnlyOwner);
    const readOnlyCommand = manualSale({
      payments: [{ moneyAccountId: readOnlyAccount, amountMinor: '500' }],
    });
    await postSale(readOnlyCommand, readOnlyOwner).expect(201);
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      readOnlyOwner.storeId,
    ]);
    await cancelSale(
      readOnlyCommand.operationId as string,
      { operationId: randomUUID(), occurredAt: augustCorrectionInstant },
      readOnlyOwner,
    )
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' }));

    if (!runtimePool) throw new Error('S14.5 runtime pool is unavailable.');
    expect(
      (
        await runtimePool.query<{ count: number }>(
          `select count(*)::int as count from sync.processed_operations where operation_id=$1`,
          [sourceCommand.operationId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    await request(server)
      .post(`/v1/customers/${customers.active}/opening-receivables/${randomUUID()}/cancel`)
      .set('authorization', `Bearer ${owner.token}`)
      .send({ operationId: randomUUID(), occurredAt: augustCorrectionInstant })
      .expect(404);
  });
});
