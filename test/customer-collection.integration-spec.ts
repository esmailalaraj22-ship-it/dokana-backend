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
import {
  deriveMoneyFactId,
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../src/money-movements/money-movement-identity';
import type {
  CustomerCreditHistoryResponse,
  CustomerFinancialResponse,
} from '../src/sales/customer-credit.types';
import type { CustomerFinancialCorrectionResponse } from '../src/sales/customer-financial-correction.types';
import type { CustomerCollectionPostingResponse } from '../src/sales/customer-payment-posting.types';
import type {
  CustomerPaymentDetailResponse,
  CustomerPaymentListResponse,
} from '../src/sales/customer-payment-read.types';
import type {
  CustomerReceivableListResponse,
  SaleDetailResponse,
} from '../src/sales/sale-read.types';
import type {
  CustomerOpeningReceivableResponse,
  SalePostingResponse,
} from '../src/sales/sale-posting.types';
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

const ownerStoreId = randomUUID();
const identities: [Identity, Identity, Identity, Identity] = [
  {
    storeId: ownerStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s153-owner-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s153-foreign-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: ownerStoreId,
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s153-manager-${randomUUID()}@example.test`,
    role: 'manager',
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s153-read-only-${randomUUID()}@example.test`,
    role: 'owner',
    storeStatus: 'read_only',
    token: '',
  },
];
const owner = identities[0];
const foreignOwner = identities[1];
const manager = identities[2];
const readOnlyOwner = identities[3];

describe('S15.3-S15.4 Customer collections and credit on isolated PostgreSQL', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S15.3 database is unavailable.');
    return database;
  }

  function postCollection(
    customerId: string,
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/customers/${customerId}/payments`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function getCustomerPayments(customerId: string, identity: Identity = owner): request.Test {
    return request(server)
      .get(`/v1/customers/${customerId}/payments`)
      .set('authorization', `Bearer ${identity.token}`);
  }

  function postCustomerFinancial(
    customerId: string,
    path: 'credit/applications' | 'credit/refunds' | 'settlements',
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/customers/${customerId}/${path}`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function postCustomerFinancialCorrection(
    customerId: string,
    path: 'payments' | 'credit/applications' | 'credit/refunds' | 'settlements',
    targetOperationId: string,
    intent: 'cancel' | 'edit',
    body: Record<string, unknown>,
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/customers/${customerId}/${path}/${targetOperationId}/${intent}`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function correctionRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      occurredAt: '2026-09-20T12:00:00Z',
      reason: 'Correct posted Customer settlement',
      ...overrides,
    };
  }

  async function customerBalances(
    customerId: string,
    identity: Identity = owner,
  ): Promise<{ receivable: string; credit: string }> {
    const row = (
      await db().admin.query<{ receivable: string; credit: string }>(
        `select receivable_minor::text as receivable,credit_minor::text as credit
         from ledger.v_customer_balances where store_id=$1 and customer_id=$2`,
        [identity.storeId, customerId],
      )
    ).rows[0];
    return row ?? { receivable: '0', credit: '0' };
  }

  async function moneyBalance(accountId: string, identity: Identity = owner): Promise<string> {
    return (
      (
        await db().admin.query<{ balance: string }>(
          `select coalesce(balance_minor,0)::text as balance
         from ledger.v_money_account_balances where store_id=$1 and account_id=$2`,
          [identity.storeId, accountId],
        )
      ).rows[0]?.balance ?? '0'
    );
  }

  function customerFinancialRequest(
    amountMinor: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T12:00:00Z',
      amountMinor,
      allocationMode: 'fifo',
      ...overrides,
    };
  }

  function expectResponseCode(expectedCode: string): (response: { body: unknown }) => void {
    return (response) => {
      expect(response.body).toEqual(expect.objectContaining({ code: expectedCode }));
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

  async function postOpening(
    customerId: string,
    amountMinor: string,
    occurredAt: string,
    identity: Identity = owner,
  ): Promise<CustomerOpeningReceivableResponse> {
    const response = await request(server)
      .post(`/v1/customers/${customerId}/opening-receivables`)
      .set('authorization', `Bearer ${identity.token}`)
      .send({ operationId: randomUUID(), amountMinor, occurredAt })
      .expect(201);
    return response.body as CustomerOpeningReceivableResponse;
  }

  async function postCreditSale(
    customerId: string,
    amountMinor: string,
    occurredAt: string,
    identity: Identity = owner,
    payments: { moneyAccountId: string; amountMinor: string }[] = [],
  ): Promise<SalePostingResponse> {
    const response = await request(server)
      .post('/v1/sales')
      .set('authorization', `Bearer ${identity.token}`)
      .send({
        operationId: randomUUID(),
        customerId,
        occurredAt,
        items: [
          {
            isManualLine: true,
            description: 'Receivable fixture',
            unitName: 'service',
            quantityMilli: '1000',
            unitPriceMinor: amountMinor,
            lineTotalMinor: amountMinor,
          },
        ],
        payments,
        totalMinor: amountMinor,
      })
      .expect(201);
    return response.body as SalePostingResponse;
  }

  function customerCreditSaleRequest(input: {
    customerId?: string;
    totalMinor: string;
    customerCreditAmountMinor?: string;
    payments?: { moneyAccountId: string; amountMinor: string }[];
    operationId?: string;
  }): Record<string, unknown> {
    return {
      operationId: input.operationId ?? randomUUID(),
      customerId: input.customerId,
      occurredAt: '2026-09-15T13:00:00Z',
      items: [
        {
          isManualLine: true,
          description: 'Customer Credit Sale tender fixture',
          unitName: 'service',
          quantityMilli: '1000',
          unitPriceMinor: input.totalMinor,
          lineTotalMinor: input.totalMinor,
        },
      ],
      payments: input.payments ?? [],
      totalMinor: input.totalMinor,
      ...(input.customerCreditAmountMinor === undefined
        ? {}
        : { customerCreditAmountMinor: input.customerCreditAmountMinor }),
    };
  }

  function postSale(body: Record<string, unknown>, identity: Identity = owner): request.Test {
    return request(server)
      .post('/v1/sales')
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  async function createCustomerCredit(
    customerId: string,
    accountId: string,
    amountMinor: string,
    identity: Identity = owner,
  ): Promise<CustomerCollectionPostingResponse> {
    const response = await postCollection(
      customerId,
      {
        operationId: randomUUID(),
        occurredAt: '2026-09-15T11:00:00Z',
        intent: 'customer_advance',
        tenders: [{ moneyAccountId: accountId, amountMinor }],
      },
      identity,
    ).expect(201);
    return response.body as CustomerCollectionPostingResponse;
  }

  function fifoRequest(
    tenders: { moneyAccountId: string; amountMinor: string; [key: string]: unknown }[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      occurredAt: '2026-09-14T12:00:00Z',
      allocationMode: 'fifo',
      tenders,
      ...overrides,
    };
  }

  function customRequest(
    tenders: { moneyAccountId: string; amountMinor: string }[],
    allocations: { targetType: string; targetId: string; amountMinor: string }[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      occurredAt: '2026-09-14T12:00:00Z',
      allocationMode: 'custom',
      tenders,
      allocations,
      ...overrides,
    };
  }

  async function allocatedTo(
    storeId: string,
    targetType: 'sale' | 'opening',
    targetId: string,
  ): Promise<bigint> {
    const column = targetType === 'sale' ? 'sale_id' : 'opening_receivable_ledger_entry_id';
    const row = (
      await db().admin.query<{ amount: string }>(
        `select coalesce(sum(a.amount_minor),0)::text as amount
         from ledger.customer_payment_allocations a
         inner join ledger.customer_payments p
           on p.store_id=a.store_id and p.id=a.customer_payment_id
         where a.store_id=$1 and a.${column}=$2 and p.status='posted'`,
        [storeId, targetId],
      )
    ).rows[0];
    return BigInt(row?.amount ?? '0');
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
    if (!databaseName || !/^dokana_s112_[0-9a-f]{32}$/.test(databaseName)) {
      throw new Error('S15.3 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s153-runtime', 12);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s153-auth', 4);

    const stores = new Map<string, Identity>();
    for (const identity of identities) stores.set(identity.storeId, identity);
    for (const identity of stores.values()) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S15.3 fixture',$2)`,
        [identity.storeId, identity.storeStatus],
      );
      await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
        identity.storeId,
      ]);
    }

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of identities) {
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S15.3 fixture')`,
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
          deviceName: 'S15.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S15.3 token is missing.');
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

  it('posts mixed-tender FIFO across Opening and Sale Receivables with exact accounting effects', async () => {
    const customerId = await createCustomer();
    const accountA = await createAccount();
    const accountB = await createAccount();
    const opening = await postOpening(customerId, '50', '2026-01-01T10:00:00Z');
    const saleA = await postCreditSale(customerId, '100', '2026-01-05T10:00:00Z');
    const saleB = await postCreditSale(customerId, '200', '2026-01-10T10:00:00Z');
    const salesBefore = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.sales where store_id=$1`,
      [owner.storeId],
    );
    const inventoryBefore = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.inventory_movements where store_id=$1`,
      [owner.storeId],
    );
    const operationId = randomUUID();
    const response = await postCollection(
      customerId,
      fifoRequest(
        [
          { moneyAccountId: accountB, amountMinor: '80', externalReference: 'B-80' },
          { moneyAccountId: accountA, amountMinor: '100', notes: 'Cash portion' },
        ],
        { operationId },
      ),
    ).expect(201);
    const body = response.body as CustomerCollectionPostingResponse;
    expect(body).toMatchObject({
      operationId,
      collectionId: operationId,
      customerId,
      allocationMode: 'fifo',
      amountMinor: '180',
    });
    expect(body.payments).toHaveLength(2);
    expect(body.moneyMovements.map((movement) => movement.amountDeltaMinor).sort()).toEqual([
      '100',
      '80',
    ]);
    expect(
      body.moneyMovements.every((movement) => movement.movementType === 'customer_payment'),
    ).toBe(true);
    expect(await allocatedTo(owner.storeId, 'opening', opening.receivable.id)).toBe(50n);
    expect(await allocatedTo(owner.storeId, 'sale', saleA.sale.id)).toBe(100n);
    expect(await allocatedTo(owner.storeId, 'sale', saleB.sale.id)).toBe(30n);

    const facts = (
      await db().admin.query<{
        money: string;
        receivable: string;
        credit: string;
        payments: number;
        allocations: number;
      }>(
        `select
          (select coalesce(sum(amount_delta_minor),0)::text from ledger.money_movements
            where store_id=$1 and transaction_group_id=$2) as money,
          (select coalesce(sum(receivable_delta_minor),0)::text from ledger.customer_ledger_entries
            where store_id=$1 and transaction_group_id=$2) as receivable,
          (select coalesce(sum(credit_delta_minor),0)::text from ledger.customer_ledger_entries
            where store_id=$1 and transaction_group_id=$2) as credit,
          (select count(*)::int from ledger.customer_payments payment
            inner join ledger.money_movements movement on movement.store_id=payment.store_id
              and movement.id=payment.money_movement_id
            where payment.store_id=$1 and movement.transaction_group_id=$2) as payments,
          (select count(*)::int from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment on payment.store_id=allocation.store_id
              and payment.id=allocation.customer_payment_id
            inner join ledger.money_movements movement on movement.store_id=payment.store_id
              and movement.id=payment.money_movement_id
            where allocation.store_id=$1 and movement.transaction_group_id=$2) as allocations`,
        [owner.storeId, operationId],
      )
    ).rows[0];
    expect(facts).toEqual({
      money: '180',
      receivable: '-180',
      credit: '0',
      payments: 2,
      allocations: 4,
    });
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.sales where store_id=$1`,
          [owner.storeId],
        )
      ).rows[0],
    ).toEqual(salesBefore.rows[0]);
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.inventory_movements where store_id=$1`,
          [owner.storeId],
        )
      ).rows[0],
    ).toEqual(inventoryBefore.rows[0]);
  });

  it('posts CUSTOM allocations across Sale and Opening origins and supports partial/full settlement', async () => {
    const customerId = await createCustomer();
    const accountA = await createAccount();
    const accountB = await createAccount();
    const opening = await postOpening(customerId, '100', '2026-02-01T10:00:00Z');
    const sale = await postCreditSale(customerId, '200', '2026-02-02T10:00:00Z');
    const response = await postCollection(
      customerId,
      customRequest(
        [
          { moneyAccountId: accountB, amountMinor: '80' },
          { moneyAccountId: accountA, amountMinor: '100' },
        ],
        [
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '130' },
          { targetType: 'opening_receivable', targetId: opening.receivable.id, amountMinor: '50' },
        ],
      ),
    ).expect(201);
    const body = response.body as CustomerCollectionPostingResponse;
    expect(body.allocations.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n)).toBe(180n);
    expect(await allocatedTo(owner.storeId, 'opening', opening.receivable.id)).toBe(50n);
    expect(await allocatedTo(owner.storeId, 'sale', sale.sale.id)).toBe(130n);

    await postCollection(
      customerId,
      customRequest(
        [{ moneyAccountId: accountA, amountMinor: '120' }],
        [
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '70' },
          { targetType: 'opening_receivable', targetId: opening.receivable.id, amountMinor: '50' },
        ],
      ),
    ).expect(201);
    expect(await allocatedTo(owner.storeId, 'opening', opening.receivable.id)).toBe(100n);
    expect(await allocatedTo(owner.storeId, 'sale', sale.sale.id)).toBe(200n);
  });

  it('uses authoritative origin time then origin UUID for FIFO ties across origin kinds', async () => {
    const customerId = await createCustomer();
    const account = await createAccount();
    const occurredAt = '2026-02-10T10:00:00Z';
    const opening = await postOpening(customerId, '50', occurredAt);
    const sale = await postCreditSale(customerId, '50', occurredAt);
    await postCollection(
      customerId,
      fifoRequest([{ moneyAccountId: account, amountMinor: '50' }]),
    ).expect(201);
    const openingFirst = opening.receivable.id < (sale.receivable?.id ?? '');
    expect(await allocatedTo(owner.storeId, 'opening', opening.receivable.id)).toBe(
      openingFirst ? 50n : 0n,
    );
    expect(await allocatedTo(owner.storeId, 'sale', sale.sale.id)).toBe(openingFirst ? 0n : 50n);
  });

  it('uses the collection receiving account instead of inheriting the original Sale account', async () => {
    const customerId = await createCustomer();
    const originalAccount = await createAccount();
    const collectionAccount = await createAccount();
    const sale = await postCreditSale(customerId, '200', '2026-02-11T10:00:00Z', owner, [
      { moneyAccountId: originalAccount, amountMinor: '50' },
    ]);
    const operationId = randomUUID();
    await postCollection(
      customerId,
      customRequest(
        [{ moneyAccountId: collectionAccount, amountMinor: '50' }],
        [{ targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '50' }],
        { operationId },
      ),
    ).expect(201);
    const movements = await db().admin.query<{ accountId: string; amountMinor: string }>(
      `select account_id as "accountId",amount_delta_minor::text as "amountMinor"
       from ledger.money_movements where store_id=$1 and transaction_group_id=$2`,
      [owner.storeId, operationId],
    );
    expect(movements.rows).toEqual([{ accountId: collectionAccount, amountMinor: '50' }]);
  });

  it('rejects overpayment, zero debt, stale CUSTOM amounts, duplicate intent, and unavailable actors/resources', async () => {
    const account = await createAccount();
    const archivedAccount = await createAccount(owner, 'archived');
    const customerId = await createCustomer();
    const otherCustomer = await createCustomer();
    const archivedCustomer = await createCustomer(owner, 'archived');
    const sale = await postCreditSale(customerId, '100', '2026-03-01T10:00:00Z');

    await postCollection(customerId, fifoRequest([{ moneyAccountId: account, amountMinor: '101' }]))
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_OVERPAYMENT_CHOICE_REQUIRED'));
    await postCollection(
      otherCustomer,
      fifoRequest([{ moneyAccountId: account, amountMinor: '1' }]),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_COLLECTION_EXCEEDS_OUTSTANDING'));
    await postCollection(
      customerId,
      customRequest(
        [{ moneyAccountId: account, amountMinor: '101' }],
        [{ targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '101' }],
      ),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_COLLECTION_ALLOCATION_EXCEEDS_OUTSTANDING'));
    await postCollection(
      otherCustomer,
      customRequest(
        [{ moneyAccountId: account, amountMinor: '1' }],
        [{ targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '1' }],
      ),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_COLLECTION_TARGET_CUSTOMER_MISMATCH'));
    await postCollection(
      archivedCustomer,
      fifoRequest([{ moneyAccountId: account, amountMinor: '1' }]),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_UNAVAILABLE'));
    await postCollection(
      customerId,
      fifoRequest([{ moneyAccountId: archivedAccount, amountMinor: '10' }]),
    )
      .expect(409)
      .expect(expectResponseCode('MONEY_ACCOUNT_UNAVAILABLE'));
    await postCollection(
      customerId,
      fifoRequest([{ moneyAccountId: account, amountMinor: '10' }]),
      manager,
    ).expect(403);

    const malformed = customRequest(
      [{ moneyAccountId: account, amountMinor: '100' }],
      [{ targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '99' }],
    );
    await postCollection(customerId, malformed).expect(400);
    await postCollection(
      customerId,
      customRequest(
        [{ moneyAccountId: account, amountMinor: '100' }],
        [
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '50' },
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '50' },
        ],
      ),
    ).expect(400);
  });

  it('enforces RLS, cross-Store privacy, read_only, and closed-period rejection', async () => {
    const account = await createAccount();
    const foreignAccount = await createAccount(foreignOwner);
    const foreignCustomer = await createCustomer(foreignOwner);
    const foreignSale = await postCreditSale(
      foreignCustomer,
      '100',
      '2026-04-01T10:00:00Z',
      foreignOwner,
    );
    const customerId = await createCustomer();
    await postOpening(customerId, '100', '2026-04-01T10:00:00Z');
    await postCollection(
      customerId,
      customRequest(
        [{ moneyAccountId: account, amountMinor: '1' }],
        [{ targetType: 'sale_receivable', targetId: foreignSale.sale.id, amountMinor: '1' }],
      ),
    ).expect(404);
    await postCollection(
      customerId,
      fifoRequest([{ moneyAccountId: foreignAccount, amountMinor: '1' }]),
    )
      .expect(404)
      .expect(expectResponseCode('MONEY_ACCOUNT_NOT_FOUND'));
    await getCustomerPayments(foreignCustomer).expect(404);

    const readOnlyCustomer = await createCustomer(readOnlyOwner);
    const readOnlyAccount = await createAccount(readOnlyOwner);
    await db().admin.query(
      `insert into ledger.accounting_periods(
        id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id
      ) values($1,$2,2026,9,'2026-08-31T21:00:00Z','2026-09-30T21:00:00Z','open',$3)`,
      [randomUUID(), readOnlyOwner.storeId, randomUUID()],
    );
    await postCollection(
      readOnlyCustomer,
      fifoRequest([{ moneyAccountId: readOnlyAccount, amountMinor: '1' }]),
      readOnlyOwner,
    ).expect(403);

    const closedCustomer = await createCustomer();
    const opening = await postOpening(closedCustomer, '10', '2026-10-01T10:00:00Z');
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, opening.accountingPeriodId],
    );
    await postCollection(
      closedCustomer,
      fifoRequest([{ moneyAccountId: account, amountMinor: '10' }], {
        occurredAt: '2026-10-02T10:00:00Z',
      }),
    )
      .expect(409)
      .expect(expectResponseCode('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'));

    const runtime = await db().runtime.query<{ count: number }>(
      `select count(*)::int as count from ledger.customer_payments`,
    );
    expect(runtime.rows[0]).toEqual({ count: 0 });
  });

  it('replays exactly, rejects changed reuse, and creates one economic effect', async () => {
    const customerId = await createCustomer();
    const account = await createAccount();
    await postOpening(customerId, '100', '2026-06-01T10:00:00Z');
    const operationId = randomUUID();
    const body = fifoRequest([{ moneyAccountId: account, amountMinor: '60' }], { operationId });
    const first = await postCollection(customerId, body).expect(201);
    const replay = await postCollection(customerId, body).expect(201);
    expect(replay.body).toEqual(first.body);
    await postCollection(customerId, { ...body, occurredAt: '2026-06-01T12:01:00Z' })
      .expect(409)
      .expect(expectResponseCode('OPERATION_ID_CONFLICT'));
    const counts = (
      await db().admin.query<{
        payments: number;
        movements: number;
        allocations: number;
        ledger: number;
      }>(
        `select
          (select count(*)::int from ledger.customer_payments payment
            inner join ledger.money_movements movement on movement.store_id=payment.store_id
              and movement.id=payment.money_movement_id
            where payment.store_id=$1 and movement.transaction_group_id=$2) as payments,
          (select count(*)::int from ledger.money_movements
            where store_id=$1 and transaction_group_id=$2) as movements,
          (select count(*)::int from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment on payment.store_id=allocation.store_id
              and payment.id=allocation.customer_payment_id
            inner join ledger.money_movements movement on movement.store_id=payment.store_id
              and movement.id=payment.money_movement_id
            where allocation.store_id=$1 and movement.transaction_group_id=$2) as allocations,
          (select count(*)::int from ledger.customer_ledger_entries
            where store_id=$1 and transaction_group_id=$2) as ledger`,
        [owner.storeId, operationId],
      )
    ).rows[0];
    expect(counts).toEqual({ payments: 1, movements: 1, allocations: 1, ledger: 1 });
  });

  it('rolls back root claim and all newly inserted facts after a child movement failure', async () => {
    const customerId = await createCustomer();
    const account = await createAccount();
    const opening = await postOpening(customerId, '100', '2026-07-01T10:00:00Z');
    const operationId = randomUUID();
    const discriminator = `customer-collection-money:${account}`;
    await db().admin.query(
      `insert into ledger.money_movements(
        id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
        reference_type,reference_id,transaction_group_id,occurred_at,operation_id
      ) values($1,$2,$3,$4,'other',1,'fixture',$5,$5,'2026-07-01T10:00:00Z',$6)`,
      [
        deriveMoneyFactId(operationId, discriminator),
        owner.storeId,
        account,
        opening.accountingPeriodId,
        randomUUID(),
        deriveMoneyFactOperationId(operationId, discriminator),
      ],
    );
    await postCollection(
      customerId,
      fifoRequest([{ moneyAccountId: account, amountMinor: '50' }], { operationId }),
    ).expect(500);
    const residue = (
      await db().admin.query<{
        payments: number;
        allocations: number;
        ledger: number;
        operation: number;
      }>(
        `select
          (select count(*)::int from ledger.customer_payments where store_id=$1
            and operation_id=$2) as payments,
          (select count(*)::int from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment on payment.store_id=allocation.store_id
              and payment.id=allocation.customer_payment_id
            where allocation.store_id=$1 and payment.operation_id=$2) as allocations,
          (select count(*)::int from ledger.customer_ledger_entries
            where store_id=$1 and transaction_group_id=$3) as ledger,
          (select count(*)::int from sync.processed_operations
            where store_id=$1 and operation_id=$3) as operation`,
        [
          owner.storeId,
          deriveMoneyFactOperationId(operationId, `customer-payment:${account}`),
          operationId,
        ],
      )
    ).rows[0];
    expect(residue).toEqual({ payments: 0, allocations: 0, ledger: 0, operation: 0 });
  });

  it('serializes concurrent FIFO/CUSTOM collection and concurrent exact replay without over-allocation', async () => {
    const account = await createAccount();
    const customerId = await createCustomer();
    const sale = await postCreditSale(customerId, '100', '2026-08-01T10:00:00Z');
    const fifo = fifoRequest([{ moneyAccountId: account, amountMinor: '100' }]);
    const custom = customRequest(
      [{ moneyAccountId: account, amountMinor: '100' }],
      [{ targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' }],
    );
    const competing = await Promise.all([
      postCollection(customerId, fifo),
      postCollection(customerId, custom),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await allocatedTo(owner.storeId, 'sale', sale.sale.id)).toBe(100n);

    const replayCustomer = await createCustomer();
    await postOpening(replayCustomer, '100', '2026-08-02T10:00:00Z');
    const replayBody = fifoRequest([{ moneyAccountId: account, amountMinor: '100' }]);
    const replayResponses = await Promise.all([
      postCollection(replayCustomer, replayBody),
      postCollection(replayCustomer, replayBody),
    ]);
    expect(
      replayResponses.filter((response) => response.status === 201).length,
    ).toBeGreaterThanOrEqual(1);
    expect(replayResponses.every((response) => [201, 409].includes(response.status))).toBe(true);
    const operationId = replayBody.operationId as string;
    const count = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.money_movements
       where store_id=$1 and transaction_group_id=$2`,
      [owner.storeId, operationId],
    );
    expect(count.rows[0]).toEqual({ count: 1 });
  });

  it('rejects a fixed concurrent request rather than silently shrinking it after debt changes', async () => {
    const account = await createAccount();
    const customerId = await createCustomer();
    const opening = await postOpening(customerId, '150', '2026-08-02T11:00:00Z');
    const responses = await Promise.all([
      postCollection(customerId, fifoRequest([{ moneyAccountId: account, amountMinor: '100' }])),
      postCollection(customerId, fifoRequest([{ moneyAccountId: account, amountMinor: '100' }])),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await allocatedTo(owner.storeId, 'opening', opening.receivable.id)).toBe(100n);
  });

  it('uses canonical account locking for opposite mixed-tender order without deadlock', async () => {
    const accountA = await createAccount();
    const accountB = await createAccount();
    const customerId = await createCustomer();
    await postOpening(customerId, '200', '2026-08-03T10:00:00Z');
    const responses = await Promise.all([
      postCollection(
        customerId,
        fifoRequest([
          { moneyAccountId: accountA, amountMinor: '50' },
          { moneyAccountId: accountB, amountMinor: '50' },
        ]),
      ),
      postCollection(
        customerId,
        fifoRequest([
          { moneyAccountId: accountB, amountMinor: '50' },
          { moneyAccountId: accountA, amountMinor: '50' },
        ]),
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
  });

  it('serializes collection against Sale correction so only a valid dependency state commits', async () => {
    const account = await createAccount();
    const customerId = await createCustomer();
    const sale = await postCreditSale(customerId, '100', '2026-08-04T10:00:00Z');
    const responses = await Promise.all([
      postCollection(customerId, fifoRequest([{ moneyAccountId: account, amountMinor: '100' }])),
      request(server)
        .post(`/v1/sales/${sale.operationId}/cancel`)
        .set('authorization', `Bearer ${owner.token}`)
        .send({ operationId: randomUUID(), occurredAt: '2026-09-14T12:00:00Z' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const state = (
      await db().admin.query<{ status: string; allocated: string }>(
        `select sale.status,
          coalesce((select sum(allocation.amount_minor)
            from ledger.customer_payment_allocations allocation
            inner join ledger.customer_payments payment on payment.store_id=allocation.store_id
              and payment.id=allocation.customer_payment_id
            where allocation.store_id=sale.store_id and allocation.sale_id=sale.id
              and payment.status='posted'),0)::text as allocated
         from ledger.sales sale where sale.store_id=$1 and sale.id=$2`,
        [owner.storeId, sale.sale.id],
      )
    ).rows[0];
    expect(state).toBeDefined();
    expect(
      state?.status === 'posted'
        ? state.allocated === '100'
        : state?.status === 'cancelled' && state.allocated === '0',
    ).toBe(true);
  });

  it('returns tenant-safe payment list/detail and updated Sale, Opening, and Customer outstanding reads', async () => {
    const customerId = await createCustomer();
    const account = await createAccount();
    const opening = await postOpening(customerId, '50', '2026-08-05T10:00:00Z');
    const sale = await postCreditSale(customerId, '100', '2026-08-06T10:00:00Z');
    const posted = await postCollection(
      customerId,
      fifoRequest([{ moneyAccountId: account, amountMinor: '120' }]),
    ).expect(201);
    const collection = posted.body as CustomerCollectionPostingResponse;

    const list = await getCustomerPayments(customerId).expect(200);
    const listBody = list.body as CustomerPaymentListResponse;
    expect(listBody).toMatchObject({ outstandingMinor: '30' });
    expect(listBody.payments).toHaveLength(1);
    expect(listBody.payments[0]).toMatchObject({
      collectionId: collection.collectionId,
      amountMinor: '120',
      allocatedTotalMinor: '120',
      creditCreatedMinor: '0',
      allocationCount: 2,
    });

    const paymentId = collection.payments[0]?.id;
    if (!paymentId) throw new Error('Customer Payment response is incomplete.');
    const detail = await request(server)
      .get(`/v1/customers/${customerId}/payments/${paymentId}`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    const detailBody = detail.body as CustomerPaymentDetailResponse;
    expect(detailBody.outstandingMinor).toBe('30');
    expect(detailBody.allocations).toHaveLength(2);
    expect(
      detailBody.allocations.every(
        (allocation) =>
          typeof allocation.paymentEffect.receivableDeltaMinor === 'string' &&
          allocation.paymentEffect.receivableDeltaMinor.startsWith('-'),
      ),
    ).toBe(true);

    const receivables = await request(server)
      .get(`/v1/customers/${customerId}/receivables`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    const receivablesBody = receivables.body as CustomerReceivableListResponse;
    expect(receivablesBody.outstandingMinor).toBe('30');
    const byId = new Map(
      receivablesBody.receivables.map((item) => [item.id, item.outstandingMinor]),
    );
    expect(byId.get(opening.receivable.id)).toBe('0');
    expect(byId.get(sale.receivable?.id ?? '')).toBe('30');

    const saleRead = await request(server)
      .get(`/v1/sales/${sale.sale.id}`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    const saleReadBody = saleRead.body as SaleDetailResponse;
    expect(saleReadBody.sale.receivableOutstandingMinor).toBe('30');
  });

  it('posts deterministic overpayment Credit, explicit Advance, and immediate excess refund', async () => {
    const cash = await createAccount();
    const bank = await createAccount();
    const refundAccount = await createAccount();

    const retainedCustomer = await createCustomer();
    await postCreditSale(retainedCustomer, '300', '2026-09-01T10:00:00Z');
    const retained = await postCollection(
      retainedCustomer,
      fifoRequest(
        [
          { moneyAccountId: bank, amountMinor: '200' },
          { moneyAccountId: cash, amountMinor: '200' },
        ],
        { overpaymentHandling: 'keep_as_customer_credit' },
      ),
    ).expect(201);
    const retainedBody = retained.body as CustomerCollectionPostingResponse;
    expect(retainedBody).toMatchObject({
      intent: 'collect_receivable',
      overpaymentHandling: 'keep_as_customer_credit',
      amountMinor: '400',
      excessMinor: '100',
      refundMovement: null,
    });
    expect(
      retainedBody.payments.map((payment) => ({
        account: payment.moneyAccountId,
        allocated: payment.allocatedTotalMinor,
        credit: payment.creditCreatedMinor,
      })),
    ).toEqual([
      { account: [cash, bank].sort()[0], allocated: '200', credit: '0' },
      { account: [cash, bank].sort()[1], allocated: '100', credit: '100' },
    ]);

    const advanceCustomer = await createCustomer();
    const advance = await postCollection(advanceCustomer, {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T12:00:00Z',
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: cash, amountMinor: '200' }],
    }).expect(201);
    expect(advance.body).toMatchObject({
      intent: 'customer_advance',
      amountMinor: '200',
      excessMinor: '200',
      allocations: [],
      payments: [expect.objectContaining({ allocatedTotalMinor: '0', creditCreatedMinor: '200' })],
    });

    const refundedCustomer = await createCustomer();
    await postCreditSale(refundedCustomer, '300', '2026-09-02T10:00:00Z');
    const refunded = await postCollection(
      refundedCustomer,
      fifoRequest([{ moneyAccountId: cash, amountMinor: '400' }], {
        overpaymentHandling: 'refund_excess',
        refundMoneyAccountId: refundAccount,
      }),
    ).expect(201);
    const refundedBody = refunded.body as CustomerCollectionPostingResponse;
    expect(refundedBody.refundMovement).toMatchObject({
      accountId: refundAccount,
      movementType: 'customer_refund',
      amountDeltaMinor: '-100',
    });

    const balances = await db().admin.query<{
      customerId: string;
      receivable: string;
      credit: string;
    }>(
      `select customer_id as "customerId",receivable_minor::text as receivable,
         credit_minor::text as credit
       from ledger.v_customer_balances where store_id=$1 and customer_id=any($2::uuid[])
       order by customer_id`,
      [owner.storeId, [retainedCustomer, advanceCustomer, refundedCustomer]],
    );
    const byCustomer = new Map(
      balances.rows.map((row) => [
        row.customerId,
        { receivable: row.receivable, credit: row.credit },
      ]),
    );
    expect(byCustomer.get(retainedCustomer)).toEqual({ receivable: '0', credit: '100' });
    expect(byCustomer.get(advanceCustomer)).toEqual({ receivable: '0', credit: '200' });
    expect(byCustomer.get(refundedCustomer)).toEqual({ receivable: '0', credit: '0' });
    const refundMoney = await db().admin.query<{ total: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as total
       from ledger.money_movements where store_id=$1 and transaction_group_id=$2`,
      [owner.storeId, refundedBody.collectionId],
    );
    expect(refundMoney.rows[0]).toEqual({ total: '300' });
  });

  it('applies Credit and non-cash Settlement to Sale and Opening targets and exposes history', async () => {
    const customerId = await createCustomer();
    const account = await createAccount();
    const opening = await postOpening(customerId, '100', '2026-01-01T10:00:00Z');
    const sale = await postCreditSale(customerId, '200', '2026-01-02T10:00:00Z');
    await postCollection(customerId, {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T09:00:00Z',
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: account, amountMinor: '200' }],
    }).expect(201);

    const applicationOperation = randomUUID();
    const application = await postCustomerFinancial(
      customerId,
      'credit/applications',
      customerFinancialRequest('150', {
        operationId: applicationOperation,
        allocationMode: 'custom',
        allocations: [
          {
            targetType: 'opening_receivable',
            targetId: opening.receivable.id,
            amountMinor: '50',
          },
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' },
        ],
      }),
    ).expect(201);
    const applicationBody = application.body as CustomerFinancialResponse;
    expect(applicationBody.moneyMovement).toBeNull();
    expect(applicationBody.ledgerEffects).toHaveLength(2);
    expect(
      applicationBody.ledgerEffects.every(
        (effect) =>
          effect.entryType === 'credit_used' &&
          effect.receivableDeltaMinor === effect.creditDeltaMinor,
      ),
    ).toBe(true);

    const settlementOperation = randomUUID();
    const settlement = await postCustomerFinancial(
      customerId,
      'settlements',
      customerFinancialRequest('50', {
        operationId: settlementOperation,
        reason: 'commercial settlement',
      }),
    ).expect(201);
    expect(settlement.body).toMatchObject({
      action: 'settle_receivable',
      moneyMovement: null,
      ledgerEffects: [
        expect.objectContaining({
          entryType: 'settlement',
          targetType: 'opening_receivable',
          targetId: opening.receivable.id,
          receivableDeltaMinor: '-50',
          creditDeltaMinor: '0',
          reason: 'commercial settlement',
        }),
      ],
    });

    const refundOperation = randomUUID();
    const refund = await postCustomerFinancial(customerId, 'credit/refunds', {
      operationId: refundOperation,
      occurredAt: '2026-09-15T12:10:00Z',
      amountMinor: '50',
      moneyAccountId: account,
      notes: 'Customer requested balance refund',
    }).expect(201);
    const refundBody = refund.body as CustomerFinancialResponse;
    expect(refundBody.action).toBe('refund_customer_credit');
    expect(refundBody.moneyMovement).toMatchObject({
      accountId: account,
      movementType: 'customer_refund',
      amountDeltaMinor: '-50',
    });

    const noMoney = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.money_movements
       where store_id=$1 and transaction_group_id=any($2::uuid[])`,
      [owner.storeId, [applicationOperation, settlementOperation]],
    );
    expect(noMoney.rows[0]).toEqual({ count: 0 });

    const history = await request(server)
      .get(`/v1/customers/${customerId}/credit-history?limit=2`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    const historyBody = history.body as CustomerCreditHistoryResponse;
    expect(historyBody).toMatchObject({
      customerId,
      receivableOutstandingMinor: '100',
      creditBalanceMinor: '0',
    });
    expect(historyBody.entries).toHaveLength(2);
    expect(historyBody.nextCursor).toEqual(expect.any(String));
    const next = await request(server)
      .get(
        `/v1/customers/${customerId}/credit-history?limit=2&cursor=${encodeURIComponent(
          historyBody.nextCursor ?? '',
        )}`,
      )
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect((next.body as CustomerCreditHistoryResponse).entries.length).toBeGreaterThan(0);

    const receivables = await request(server)
      .get(`/v1/customers/${customerId}/receivables`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(200);
    const byId = new Map(
      (receivables.body as CustomerReceivableListResponse).receivables.map((item) => [
        item.id,
        item.outstandingMinor,
      ]),
    );
    expect(byId.get(opening.receivable.id)).toBe('0');
    expect(byId.get(sale.receivable?.id ?? '')).toBe('100');
  });

  it('rejects invalid Credit/Settlement operations and preserves owner, tenant, period, and Sale guards', async () => {
    const account = await createAccount();
    const customerId = await createCustomer();
    const archivedCustomer = await createCustomer(owner, 'archived');
    const sale = await postCreditSale(customerId, '100', '2026-03-01T10:00:00Z');

    await postCustomerFinancial(customerId, 'credit/applications', customerFinancialRequest('1'))
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_CREDIT_INSUFFICIENT'));
    await postCustomerFinancial(customerId, 'settlements', customerFinancialRequest('10')).expect(
      400,
    );
    await postCustomerFinancial(archivedCustomer, 'credit/refunds', {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T12:00:00Z',
      amountMinor: '1',
      moneyAccountId: account,
    })
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_UNAVAILABLE'));
    await postCustomerFinancial(
      customerId,
      'settlements',
      customerFinancialRequest('1', { reason: 'manager attempt' }),
      manager,
    ).expect(403);

    const foreignCustomer = await createCustomer(foreignOwner);
    const foreignSale = await postCreditSale(
      foreignCustomer,
      '10',
      '2026-03-02T10:00:00Z',
      foreignOwner,
    );
    await request(server)
      .get(`/v1/customers/${foreignCustomer}/credit-history`)
      .set('authorization', `Bearer ${owner.token}`)
      .expect(404);

    await postCollection(customerId, {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T09:00:00Z',
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: account, amountMinor: '100' }],
    }).expect(201);
    await postCustomerFinancial(
      customerId,
      'credit/applications',
      customerFinancialRequest('1', {
        allocationMode: 'custom',
        allocations: [
          {
            targetType: 'sale_receivable',
            targetId: foreignSale.sale.id,
            amountMinor: '1',
          },
        ],
      }),
    ).expect(404);
    await postCustomerFinancial(
      customerId,
      'credit/applications',
      customerFinancialRequest('50', {
        allocationMode: 'custom',
        allocations: [{ targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '50' }],
      }),
    ).expect(201);
    await request(server)
      .post(`/v1/sales/${sale.operationId}/cancel`)
      .set('authorization', `Bearer ${owner.token}`)
      .send({ operationId: randomUUID(), occurredAt: '2026-09-15T12:20:00Z' })
      .expect(409);

    const readOnlyCustomer = await createCustomer(readOnlyOwner);
    await postCustomerFinancial(
      readOnlyCustomer,
      'settlements',
      customerFinancialRequest('1', { reason: 'read-only attempt' }),
      readOnlyOwner,
    ).expect(403);

    const closedCustomer = await createCustomer();
    const opening = await postOpening(closedCustomer, '10', '2026-05-01T10:00:00Z');
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, opening.accountingPeriodId],
    );
    await postCustomerFinancial(
      closedCustomer,
      'settlements',
      customerFinancialRequest('1', {
        occurredAt: '2026-05-02T10:00:00Z',
        reason: 'closed period attempt',
      }),
    )
      .expect(409)
      .expect(expectResponseCode('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'));
  });

  it('serializes competing Credit consumption and Receivable reductions with exact replay', async () => {
    const account = await createAccount();
    const customerId = await createCustomer();
    const sale = await postCreditSale(customerId, '100', '2026-08-01T10:00:00Z');
    await postCollection(customerId, {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T09:00:00Z',
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: account, amountMinor: '100' }],
    }).expect(201);

    const applyBody = customerFinancialRequest('100');
    const competingCredit = await Promise.all([
      postCustomerFinancial(customerId, 'credit/applications', applyBody),
      postCustomerFinancial(customerId, 'credit/refunds', {
        operationId: randomUUID(),
        occurredAt: '2026-09-15T12:00:00Z',
        amountMinor: '100',
        moneyAccountId: account,
      }),
    ]);
    expect(competingCredit.map((response) => response.status).sort()).toEqual([201, 409]);

    const replayCustomer = await createCustomer();
    const replaySale = await postCreditSale(replayCustomer, '100', '2026-08-02T10:00:00Z');
    const settlementBody = customerFinancialRequest('100', {
      allocationMode: 'custom',
      allocations: [
        { targetType: 'sale_receivable', targetId: replaySale.sale.id, amountMinor: '100' },
      ],
      reason: 'agreed waiver',
    });
    const [first, replay] = await Promise.all([
      postCustomerFinancial(replayCustomer, 'settlements', settlementBody),
      postCustomerFinancial(replayCustomer, 'settlements', settlementBody),
    ]);
    expect([first.status, replay.status].every((status) => [201, 409].includes(status))).toBe(true);
    expect(
      [first.status, replay.status].filter((status) => status === 201).length,
    ).toBeGreaterThanOrEqual(1);
    const operationId = settlementBody.operationId as string;
    const effects = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.customer_ledger_entries
       where store_id=$1 and transaction_group_id=$2 and entry_type='settlement'`,
      [owner.storeId, operationId],
    );
    expect(effects.rows[0]).toEqual({ count: 1 });
    await postCustomerFinancial(replayCustomer, 'settlements', {
      ...settlementBody,
      amountMinor: '99',
      allocations: [
        { targetType: 'sale_receivable', targetId: replaySale.sale.id, amountMinor: '99' },
      ],
    })
      .expect(409)
      .expect(expectResponseCode('OPERATION_ID_CONFLICT'));

    const collectionCustomer = await createCustomer();
    await postOpening(collectionCustomer, '100', '2026-08-03T10:00:00Z');
    const competingDebt = await Promise.all([
      postCollection(
        collectionCustomer,
        fifoRequest([{ moneyAccountId: account, amountMinor: '100' }]),
      ),
      postCustomerFinancial(
        collectionCustomer,
        'settlements',
        customerFinancialRequest('100', { reason: 'concurrent waiver' }),
      ),
    ]);
    expect(competingDebt.map((response) => response.status).sort()).toEqual([201, 409]);
    const remaining = await db().admin.query<{ receivable: string }>(
      `select coalesce(receivable_minor,0)::text as receivable
       from ledger.v_customer_balances where store_id=$1 and customer_id=$2`,
      [owner.storeId, collectionCustomer],
    );
    expect(remaining.rows[0]).toEqual({ receivable: '0' });
    expect(sale.receivable).not.toBeNull();

    const overpaymentCustomer = await createCustomer();
    await postOpening(overpaymentCustomer, '100', '2026-08-04T10:00:00Z');
    const overpayments = await Promise.all([
      postCollection(
        overpaymentCustomer,
        fifoRequest([{ moneyAccountId: account, amountMinor: '150' }], {
          overpaymentHandling: 'keep_as_customer_credit',
        }),
      ),
      postCollection(
        overpaymentCustomer,
        fifoRequest([{ moneyAccountId: account, amountMinor: '150' }], {
          overpaymentHandling: 'keep_as_customer_credit',
        }),
      ),
    ]);
    expect(overpayments.map((response) => response.status).sort()).toEqual([201, 409]);
    const overpaymentBalance = await db().admin.query<{ credit: string }>(
      `select credit_minor::text as credit from ledger.v_customer_balances
       where store_id=$1 and customer_id=$2`,
      [owner.storeId, overpaymentCustomer],
    );
    expect(overpaymentBalance.rows[0]).toEqual({ credit: '50' });
  });

  it('posts Customer Credit as a non-Money Sale tender across the approved settlement combinations and reads', async () => {
    const account = await createAccount();
    const fullCustomer = await createCustomer();
    const cashCreditCustomer = await createCustomer();
    const creditDebtCustomer = await createCustomer();
    const mixedCustomer = await createCustomer();
    await Promise.all([
      createCustomerCredit(fullCustomer, account, '300'),
      createCustomerCredit(cashCreditCustomer, account, '100'),
      createCustomerCredit(creditDebtCustomer, account, '100'),
      createCustomerCredit(mixedCustomer, account, '100'),
    ]);

    const fullCommand = customerCreditSaleRequest({
      customerId: fullCustomer,
      totalMinor: '300',
      customerCreditAmountMinor: '300',
    });
    const full = (await postSale(fullCommand).expect(201)).body as SalePostingResponse;
    const cashCredit = (
      await postSale(
        customerCreditSaleRequest({
          customerId: cashCreditCustomer,
          totalMinor: '300',
          customerCreditAmountMinor: '100',
          payments: [{ moneyAccountId: account, amountMinor: '200' }],
        }),
      ).expect(201)
    ).body as SalePostingResponse;
    const creditDebt = (
      await postSale(
        customerCreditSaleRequest({
          customerId: creditDebtCustomer,
          totalMinor: '300',
          customerCreditAmountMinor: '100',
        }),
      ).expect(201)
    ).body as SalePostingResponse;
    const mixed = (
      await postSale(
        customerCreditSaleRequest({
          customerId: mixedCustomer,
          totalMinor: '300',
          customerCreditAmountMinor: '100',
          payments: [{ moneyAccountId: account, amountMinor: '100' }],
        }),
      ).expect(201)
    ).body as SalePostingResponse;
    const moneyOnly = (
      await postSale(
        customerCreditSaleRequest({
          totalMinor: '300',
          payments: [{ moneyAccountId: account, amountMinor: '300' }],
        }),
      ).expect(201)
    ).body as SalePostingResponse;

    expect(full).toMatchObject({
      sale: {
        totalMinor: '300',
        paidTotalMinor: '300',
        creditTotalMinor: '0',
        paymentStatus: 'paid',
      },
      payments: [],
      customerCreditTender: { customerId: fullCustomer, amountMinor: '300' },
      receivable: null,
    });
    expect(cashCredit).toMatchObject({
      sale: { paidTotalMinor: '300', creditTotalMinor: '0', paymentStatus: 'paid' },
      payments: [expect.objectContaining({ amountMinor: '200' })],
      customerCreditTender: { customerId: cashCreditCustomer, amountMinor: '100' },
      receivable: null,
    });
    expect(creditDebt).toMatchObject({
      sale: { paidTotalMinor: '100', creditTotalMinor: '200', paymentStatus: 'partial' },
      payments: [],
      customerCreditTender: { customerId: creditDebtCustomer, amountMinor: '100' },
    });
    expect(creditDebt.receivable).toMatchObject({ receivableDeltaMinor: '200' });
    expect(mixed).toMatchObject({
      sale: { paidTotalMinor: '200', creditTotalMinor: '100', paymentStatus: 'partial' },
      payments: [expect.objectContaining({ amountMinor: '100' })],
      customerCreditTender: { customerId: mixedCustomer, amountMinor: '100' },
    });
    expect(mixed.receivable).toMatchObject({ receivableDeltaMinor: '100' });
    expect(moneyOnly).toMatchObject({
      payments: [expect.objectContaining({ amountMinor: '300' })],
      customerCreditTender: null,
      receivable: null,
    });

    const fullGroupId = deriveTransactionGroupId(fullCommand.operationId as string);
    const fullFacts = (
      await db().admin.query<{
        moneyCount: number;
        moneyAmount: string;
        receivable: string;
        credit: string;
        inventoryCount: number;
      }>(
        `select
          (select count(*)::int from ledger.money_movements
             where store_id=$1 and transaction_group_id=$2) as "moneyCount",
          (select coalesce(sum(amount_delta_minor),0)::text from ledger.money_movements
             where store_id=$1 and transaction_group_id=$2) as "moneyAmount",
          (select coalesce(sum(receivable_delta_minor),0)::text from ledger.customer_ledger_entries
             where store_id=$1 and transaction_group_id=$2) as receivable,
          (select coalesce(sum(credit_delta_minor),0)::text from ledger.customer_ledger_entries
             where store_id=$1 and transaction_group_id=$2) as credit,
          (select count(*)::int from ledger.inventory_movements
             where store_id=$1 and transaction_group_id=$2) as "inventoryCount"`,
        [owner.storeId, fullGroupId],
      )
    ).rows[0];
    expect(fullFacts).toEqual({
      moneyCount: 0,
      moneyAmount: '0',
      receivable: '0',
      credit: '-300',
      inventoryCount: 0,
    });

    const detail = (
      await request(server)
        .get(`/v1/sales/${mixed.sale.id}`)
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200)
    ).body as SaleDetailResponse;
    expect(detail).toMatchObject({
      sale: {
        moneyPaidTotalMinor: '100',
        customerCreditUsedMinor: '100',
        paidTotalMinor: '200',
        receivableOriginatedMinor: '100',
      },
      tenders: [expect.objectContaining({ amountMinor: '100' })],
    });
    expect(detail.customerCreditTender).toMatchObject({ amountMinor: '100' });
    expect(detail.receivable).toMatchObject({ originalAmountMinor: '100' });
    const list = (
      await request(server)
        .get('/v1/sales?limit=100')
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200)
    ).body as { items: SaleDetailResponse['sale'][] };
    expect(list.items.find((item) => item.id === full.sale.id)).toMatchObject({
      moneyPaidTotalMinor: '0',
      customerCreditUsedMinor: '300',
      paidTotalMinor: '300',
      receivableOriginatedMinor: '0',
    });
    const history = (
      await request(server)
        .get(`/v1/customers/${fullCustomer}/credit-history`)
        .set('authorization', `Bearer ${owner.token}`)
        .expect(200)
    ).body as CustomerCreditHistoryResponse;
    expect(history.creditBalanceMinor).toBe('0');
    expect(history.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryType: 'credit_used',
          creditDeltaMinor: '-300',
          targetType: 'sale_tender',
          targetId: full.sale.id,
          moneyAccount: null,
        }),
      ]),
    );
  });

  it('rejects invalid Sale Credit tenders, preserves exact replay, bigint, and atomic rollback', async () => {
    const account = await createAccount();
    const customerId = await createCustomer();
    await createCustomerCredit(customerId, account, '100');
    await postSale(
      customerCreditSaleRequest({
        customerId,
        totalMinor: '101',
        customerCreditAmountMinor: '101',
      }),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_CREDIT_INSUFFICIENT'));

    const zeroCreditCustomer = await createCustomer();
    await postSale(
      customerCreditSaleRequest({
        customerId: zeroCreditCustomer,
        totalMinor: '1',
        customerCreditAmountMinor: '1',
      }),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_CREDIT_INSUFFICIENT'));
    await postSale(
      customerCreditSaleRequest({ totalMinor: '1', customerCreditAmountMinor: '1' }),
    ).expect(400);

    const archivedCustomer = await createCustomer();
    await createCustomerCredit(archivedCustomer, account, '1');
    await db().admin.query(
      `update ledger.customers set status='archived',archived_at=clock_timestamp() where id=$1`,
      [archivedCustomer],
    );
    await postSale(
      customerCreditSaleRequest({
        customerId: archivedCustomer,
        totalMinor: '1',
        customerCreditAmountMinor: '1',
      }),
    )
      .expect(409)
      .expect(expectResponseCode('CUSTOMER_UNAVAILABLE'));

    const foreignCustomer = await createCustomer(foreignOwner);
    const foreignAccount = await createAccount(foreignOwner);
    await createCustomerCredit(foreignCustomer, foreignAccount, '1', foreignOwner);
    await postSale(
      customerCreditSaleRequest({
        customerId: foreignCustomer,
        totalMinor: '1',
        customerCreditAmountMinor: '1',
      }),
    )
      .expect(404)
      .expect(expectResponseCode('CUSTOMER_NOT_FOUND'));

    const replayCustomer = await createCustomer();
    await createCustomerCredit(replayCustomer, account, '100');
    const replayCommand = customerCreditSaleRequest({
      customerId: replayCustomer,
      totalMinor: '100',
      customerCreditAmountMinor: '100',
      operationId: randomUUID(),
    });
    const first = await postSale(replayCommand).expect(201);
    const replay = await postSale(replayCommand).expect(201);
    expect(replay.body).toEqual(first.body);
    await postSale({
      ...replayCommand,
      payments: [{ moneyAccountId: account, amountMinor: '1' }],
      customerCreditAmountMinor: '99',
    })
      .expect(409)
      .expect(expectResponseCode('OPERATION_ID_CONFLICT'));
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.sale_customer_credit_applications
           where store_id=$1 and sale_id=$2`,
          [owner.storeId, (first.body as SalePostingResponse).sale.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const largeCustomer = await createCustomer();
    const largeAmount = '9007199254740993';
    await createCustomerCredit(largeCustomer, account, largeAmount);
    const large = (
      await postSale(
        customerCreditSaleRequest({
          customerId: largeCustomer,
          totalMinor: largeAmount,
          customerCreditAmountMinor: largeAmount,
        }),
      ).expect(201)
    ).body as SalePostingResponse;
    expect(large.customerCreditTender?.amountMinor).toBe(largeAmount);

    const rollbackCustomer = await createCustomer();
    const advance = await createCustomerCredit(rollbackCustomer, account, '100');
    const rollbackOperationId = randomUUID();
    const collidingId = deriveMoneyFactId(rollbackOperationId, 'sale-customer-credit-ledger');
    await db().admin.query(
      `insert into ledger.customer_ledger_entries(
         id,store_id,customer_id,accounting_period_id,entry_type,
         receivable_delta_minor,credit_delta_minor,reference_type,reference_id,
         transaction_group_id,occurred_at,device_id,operation_id
       ) values($1,$2,$3,$4,'credit_created',0,1,'fixture',$5,$5,$6,$7,$8)`,
      [
        collidingId,
        owner.storeId,
        rollbackCustomer,
        advance.accountingPeriodId,
        randomUUID(),
        '2026-09-15T12:00:00Z',
        owner.deviceId,
        randomUUID(),
      ],
    );
    const rollbackSaleId = deriveMoneyFactId(rollbackOperationId, 'sale');
    await postSale(
      customerCreditSaleRequest({
        customerId: rollbackCustomer,
        totalMinor: '100',
        customerCreditAmountMinor: '100',
        operationId: rollbackOperationId,
      }),
    ).expect(500);
    const rollbackResidue = (
      await db().admin.query<{ sales: number; relations: number; operations: number }>(
        `select
          (select count(*)::int from ledger.sales where store_id=$1 and id=$2) as sales,
          (select count(*)::int from ledger.sale_customer_credit_applications
             where store_id=$1 and sale_id=$2) as relations,
          (select count(*)::int from sync.processed_operations
             where store_id=$1 and operation_id=$3) as operations`,
        [owner.storeId, rollbackSaleId, rollbackOperationId],
      )
    ).rows[0];
    expect(rollbackResidue).toEqual({ sales: 0, relations: 0, operations: 0 });
  });

  it('serializes Sale Credit consumption against Sales, refunds, allocations, and Money lock order', async () => {
    const accountA = await createAccount();
    const accountB = await createAccount();

    const saleRaceCustomer = await createCustomer();
    await createCustomerCredit(saleRaceCustomer, accountA, '100');
    const saleRace = await Promise.all([
      postSale(
        customerCreditSaleRequest({
          customerId: saleRaceCustomer,
          totalMinor: '100',
          customerCreditAmountMinor: '100',
        }),
      ),
      postSale(
        customerCreditSaleRequest({
          customerId: saleRaceCustomer,
          totalMinor: '100',
          customerCreditAmountMinor: '100',
        }),
      ),
    ]);
    expect(saleRace.map((response) => response.status).sort()).toEqual([201, 409]);

    const refundRaceCustomer = await createCustomer();
    await createCustomerCredit(refundRaceCustomer, accountA, '100');
    const refundRace = await Promise.all([
      postSale(
        customerCreditSaleRequest({
          customerId: refundRaceCustomer,
          totalMinor: '100',
          customerCreditAmountMinor: '100',
        }),
      ),
      postCustomerFinancial(refundRaceCustomer, 'credit/refunds', {
        operationId: randomUUID(),
        occurredAt: '2026-09-15T13:00:00Z',
        amountMinor: '100',
        moneyAccountId: accountA,
      }),
    ]);
    expect(refundRace.map((response) => response.status).sort()).toEqual([201, 409]);

    const allocationRaceCustomer = await createCustomer();
    const opening = await postOpening(allocationRaceCustomer, '100', '2026-09-15T10:00:00Z');
    await createCustomerCredit(allocationRaceCustomer, accountA, '100');
    const allocationRace = await Promise.all([
      postSale(
        customerCreditSaleRequest({
          customerId: allocationRaceCustomer,
          totalMinor: '100',
          customerCreditAmountMinor: '100',
        }),
      ),
      postCustomerFinancial(
        allocationRaceCustomer,
        'credit/applications',
        customerFinancialRequest('100', {
          allocationMode: 'custom',
          allocations: [
            {
              targetType: 'opening_receivable',
              targetId: opening.receivable.id,
              amountMinor: '100',
            },
          ],
        }),
      ),
    ]);
    expect(allocationRace.map((response) => response.status).sort()).toEqual([201, 409]);

    const replayCustomer = await createCustomer();
    await createCustomerCredit(replayCustomer, accountA, '100');
    const duplicateCommand = customerCreditSaleRequest({
      customerId: replayCustomer,
      totalMinor: '100',
      customerCreditAmountMinor: '100',
    });
    const duplicate = await Promise.all([postSale(duplicateCommand), postSale(duplicateCommand)]);
    expect(duplicate.every((response) => [201, 409].includes(response.status))).toBe(true);
    expect(duplicate.filter((response) => response.status === 201).length).toBeGreaterThanOrEqual(
      1,
    );
    const duplicateSaleId = deriveMoneyFactId(duplicateCommand.operationId as string, 'sale');
    expect(
      (
        await db().admin.query(
          `select count(*)::int as count from ledger.sale_customer_credit_applications
           where store_id=$1 and sale_id=$2`,
          [owner.storeId, duplicateSaleId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });

    const lockOrderCustomer = await createCustomer();
    await createCustomerCredit(lockOrderCustomer, accountA, '200');
    const lockOrder = await Promise.all([
      postSale(
        customerCreditSaleRequest({
          customerId: lockOrderCustomer,
          totalMinor: '300',
          customerCreditAmountMinor: '100',
          payments: [
            { moneyAccountId: accountB, amountMinor: '100' },
            { moneyAccountId: accountA, amountMinor: '100' },
          ],
        }),
      ),
      postSale(
        customerCreditSaleRequest({
          customerId: lockOrderCustomer,
          totalMinor: '300',
          customerCreditAmountMinor: '100',
          payments: [
            { moneyAccountId: accountA, amountMinor: '100' },
            { moneyAccountId: accountB, amountMinor: '100' },
          ],
        }),
      ),
    ]);
    expect(lockOrder.map((response) => response.status)).toEqual([201, 201]);
  });

  it('rolls back Customer Credit refund facts and operation claim after a child movement failure', async () => {
    const customerId = await createCustomer();
    const account = await createAccount();
    const advance = await postCollection(customerId, {
      operationId: randomUUID(),
      occurredAt: '2026-09-15T09:00:00Z',
      intent: 'customer_advance',
      tenders: [{ moneyAccountId: account, amountMinor: '100' }],
    }).expect(201);
    const operationId = randomUUID();
    const discriminator = 'customer-credit-refund-money';
    await db().admin.query(
      `insert into ledger.money_movements(
        id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
        reference_type,reference_id,transaction_group_id,occurred_at,operation_id
      ) values($1,$2,$3,$4,'other',1,'fixture',$5,$5,'2026-09-15T10:00:00Z',$6)`,
      [
        deriveMoneyFactId(operationId, discriminator),
        owner.storeId,
        account,
        (advance.body as CustomerCollectionPostingResponse).accountingPeriodId,
        randomUUID(),
        deriveMoneyFactOperationId(operationId, discriminator),
      ],
    );
    await postCustomerFinancial(customerId, 'credit/refunds', {
      operationId,
      occurredAt: '2026-09-15T12:00:00Z',
      amountMinor: '50',
      moneyAccountId: account,
    }).expect(500);
    const residue = await db().admin.query<{ ledger: number; operation: number; credit: string }>(
      `select
        (select count(*)::int from ledger.customer_ledger_entries
          where store_id=$1 and transaction_group_id=$2) as ledger,
        (select count(*)::int from sync.processed_operations
          where store_id=$1 and operation_id=$2) as operation,
        (select credit_minor::text from ledger.v_customer_balances
          where store_id=$1 and customer_id=$3) as credit`,
      [owner.storeId, operationId, customerId],
    );
    expect(residue.rows[0]).toEqual({ ledger: 0, operation: 0, credit: '100' });
  });

  describe('S15.5 immutable Customer financial corrections', () => {
    it('cancels a mixed collection as one root and preserves replay and operational history', async () => {
      const customerId = await createCustomer();
      const cash = await createAccount();
      const bank = await createAccount();
      const opening = await postOpening(customerId, '100', '2026-09-10T09:00:00Z');
      const sale = await postCreditSale(customerId, '200', '2026-09-10T10:00:00Z');
      const originalRequest = customRequest(
        [
          { moneyAccountId: cash, amountMinor: '100' },
          { moneyAccountId: bank, amountMinor: '200' },
        ],
        [
          { targetType: 'opening_receivable', targetId: opening.receivable.id, amountMinor: '100' },
          { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '200' },
        ],
      );
      const original = (await postCollection(customerId, originalRequest).expect(201))
        .body as CustomerCollectionPostingResponse;
      const correctionBody = correctionRequest();
      const corrected = (
        await postCustomerFinancialCorrection(
          customerId,
          'payments',
          original.operationId,
          'cancel',
          correctionBody,
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;

      expect(corrected).toMatchObject({
        targetOperationId: original.operationId,
        family: 'customer_collection',
        intent: 'cancel',
        activeOperationId: null,
      });
      expect(corrected.reversal.ledgerEffects).toHaveLength(original.allocations.length);
      expect(corrected.reversal.moneyMovements).toHaveLength(2);
      expect(await customerBalances(customerId)).toEqual({ receivable: '300', credit: '0' });
      expect(await moneyBalance(cash)).toBe('0');
      expect(await moneyBalance(bank)).toBe('0');

      const replay = await postCustomerFinancialCorrection(
        customerId,
        'payments',
        original.operationId,
        'cancel',
        correctionBody,
      ).expect(201);
      expect(replay.body).toEqual(corrected);
      await postCustomerFinancialCorrection(
        customerId,
        'payments',
        original.operationId,
        'cancel',
        { ...correctionBody, reason: 'Changed reuse' },
      )
        .expect(409)
        .expect(expectResponseCode('OPERATION_ID_CONFLICT'));
      expect((await postCollection(customerId, originalRequest).expect(201)).body).toEqual(
        original,
      );

      const payments = (await getCustomerPayments(customerId).expect(200))
        .body as CustomerPaymentListResponse;
      expect(payments.payments).toHaveLength(2);
      expect(
        payments.payments.every(
          (payment) =>
            payment.status === 'cancelled' &&
            payment.lineage.state === 'cancelled' &&
            payment.lineage.correctedByOperationId === corrected.operationId &&
            payment.lineage.currentActiveOperationId === null,
        ),
      ).toBe(true);
      const details = await Promise.all(
        original.payments.map(
          async (payment) =>
            (
              await request(server)
                .get(`/v1/customers/${customerId}/payments/${payment.id}`)
                .set('authorization', `Bearer ${owner.token}`)
                .expect(200)
            ).body as CustomerPaymentDetailResponse,
        ),
      );
      const targetTypes = new Set(
        details.flatMap((detail) => detail.allocations.map((allocation) => allocation.target.type)),
      );
      expect(targetTypes.has('SALE_RECEIVABLE')).toBe(true);
      expect(targetTypes.has('OPENING_RECEIVABLE')).toBe(true);
      expect(details.every((detail) => detail.corrections.length === 1)).toBe(true);
      expect(details[0]?.corrections).toEqual([corrected]);
    });

    it('replaces collections atomically and enforces a linear active-leaf chain', async () => {
      const customerId = await createCustomer();
      const cash = await createAccount();
      const bank = await createAccount();
      await postOpening(customerId, '300', '2026-09-11T09:00:00Z');
      const original = (
        await postCollection(
          customerId,
          fifoRequest([{ moneyAccountId: cash, amountMinor: '300' }]),
        ).expect(201)
      ).body as CustomerCollectionPostingResponse;

      const replacementB = (
        await postCustomerFinancialCorrection(
          customerId,
          'payments',
          original.operationId,
          'edit',
          correctionRequest({
            replacement: {
              allocationMode: 'fifo',
              tenders: [{ moneyAccountId: bank, amountMinor: '250' }],
            },
          }),
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;
      expect(await customerBalances(customerId)).toEqual({ receivable: '50', credit: '0' });
      expect(await moneyBalance(cash)).toBe('0');
      expect(await moneyBalance(bank)).toBe('250');
      await postCustomerFinancialCorrection(
        customerId,
        'payments',
        original.operationId,
        'cancel',
        correctionRequest(),
      )
        .expect(409)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE'));

      const replacementC = (
        await postCustomerFinancialCorrection(
          customerId,
          'payments',
          replacementB.operationId,
          'edit',
          correctionRequest({
            replacement: {
              allocationMode: 'fifo',
              tenders: [{ moneyAccountId: cash, amountMinor: '200' }],
            },
          }),
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;
      await postCustomerFinancialCorrection(
        customerId,
        'payments',
        replacementB.operationId,
        'cancel',
        correctionRequest(),
      )
        .expect(409)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE'));
      const terminal = (
        await postCustomerFinancialCorrection(
          customerId,
          'payments',
          replacementC.operationId,
          'cancel',
          correctionRequest(),
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;
      expect(terminal.activeOperationId).toBeNull();
      expect(await customerBalances(customerId)).toEqual({ receivable: '300', credit: '0' });
      expect(await moneyBalance(cash)).toBe('0');
      expect(await moneyBalance(bank)).toBe('0');
      await postCustomerFinancialCorrection(
        customerId,
        'payments',
        replacementC.operationId,
        'cancel',
        correctionRequest(),
      )
        .expect(409)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE'));

      const chain = (await getCustomerPayments(customerId).expect(200))
        .body as CustomerPaymentListResponse;
      const originalPayment = chain.payments.find(
        (payment) => payment.lineage.rootOperationId === original.operationId,
      );
      expect(originalPayment?.lineage).toMatchObject({
        state: 'corrected',
        correctedByOperationId: replacementB.operationId,
        currentActiveOperationId: null,
      });
    });

    it('reverses internal overpayment/refund facts and blocks consumed Customer Credit', async () => {
      const account = await createAccount();

      const unusedCustomer = await createCustomer();
      await postOpening(unusedCustomer, '300', '2026-09-12T08:00:00Z');
      const unused = (
        await postCollection(
          unusedCustomer,
          fifoRequest([{ moneyAccountId: account, amountMinor: '400' }], {
            overpaymentHandling: 'keep_as_customer_credit',
          }),
        ).expect(201)
      ).body as CustomerCollectionPostingResponse;
      expect(await customerBalances(unusedCustomer)).toEqual({ receivable: '0', credit: '100' });
      await postCustomerFinancialCorrection(
        unusedCustomer,
        'payments',
        unused.operationId,
        'cancel',
        correctionRequest(),
      ).expect(201);
      expect(await customerBalances(unusedCustomer)).toEqual({ receivable: '300', credit: '0' });

      const consumedCustomer = await createCustomer();
      await postOpening(consumedCustomer, '300', '2026-09-12T08:10:00Z');
      const retained = (
        await postCollection(
          consumedCustomer,
          fifoRequest([{ moneyAccountId: account, amountMinor: '400' }], {
            overpaymentHandling: 'keep_as_customer_credit',
          }),
        ).expect(201)
      ).body as CustomerCollectionPostingResponse;
      await postCreditSale(consumedCustomer, '60', '2026-09-12T09:00:00Z');
      await postCustomerFinancial(
        consumedCustomer,
        'credit/applications',
        customerFinancialRequest('60'),
      ).expect(201);
      await postCustomerFinancialCorrection(
        consumedCustomer,
        'payments',
        retained.operationId,
        'cancel',
        correctionRequest(),
      )
        .expect(409)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY'));
      expect(await customerBalances(consumedCustomer)).toEqual({ receivable: '0', credit: '40' });

      const refundCustomer = await createCustomer();
      await postOpening(refundCustomer, '300', '2026-09-12T10:00:00Z');
      const immediateRefund = (
        await postCollection(
          refundCustomer,
          fifoRequest([{ moneyAccountId: account, amountMinor: '400' }], {
            overpaymentHandling: 'refund_excess',
            refundMoneyAccountId: account,
          }),
        ).expect(201)
      ).body as CustomerCollectionPostingResponse;
      const beforeCancel = await moneyBalance(account);
      const cancelled = (
        await postCustomerFinancialCorrection(
          refundCustomer,
          'payments',
          immediateRefund.operationId,
          'cancel',
          correctionRequest(),
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;
      expect(cancelled.reversal.moneyMovements).toHaveLength(2);
      expect(await moneyBalance(account)).toBe((BigInt(beforeCancel) - 300n).toString());
      expect(await customerBalances(refundCustomer)).toEqual({ receivable: '300', credit: '0' });

      const advanceCustomer = await createCustomer();
      const advanceAccount = await createAccount();
      const advance = await createCustomerCredit(advanceCustomer, advanceAccount, '200');
      await db().admin.query(
        `update ledger.customers set status='archived',archived_at=clock_timestamp()
         where store_id=$1 and id=$2`,
        [owner.storeId, advanceCustomer],
      );
      await db().admin.query(
        `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
         where store_id=$1 and id=$2`,
        [owner.storeId, advanceAccount],
      );
      await postCustomerFinancialCorrection(
        advanceCustomer,
        'payments',
        advance.operationId,
        'cancel',
        correctionRequest(),
      ).expect(201);
      expect(await customerBalances(advanceCustomer)).toEqual({ receivable: '0', credit: '0' });
      expect(await moneyBalance(advanceAccount)).toBe('0');

      const consumedAdvanceCustomer = await createCustomer();
      const consumedAdvanceAccount = await createAccount();
      const consumedAdvance = await createCustomerCredit(
        consumedAdvanceCustomer,
        consumedAdvanceAccount,
        '200',
      );
      await postCustomerFinancial(consumedAdvanceCustomer, 'credit/refunds', {
        operationId: randomUUID(),
        occurredAt: '2026-09-12T11:00:00Z',
        amountMinor: '160',
        moneyAccountId: consumedAdvanceAccount,
      }).expect(201);
      await postCustomerFinancialCorrection(
        consumedAdvanceCustomer,
        'payments',
        consumedAdvance.operationId,
        'cancel',
        correctionRequest(),
      )
        .expect(409)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_CREDIT_DEPENDENCY'));

      const replacementCustomer = await createCustomer();
      const replacementOldAccount = await createAccount();
      const replacementNewAccount = await createAccount();
      const replacementAdvance = await createCustomerCredit(
        replacementCustomer,
        replacementOldAccount,
        '200',
      );
      await postCustomerFinancialCorrection(
        replacementCustomer,
        'payments',
        replacementAdvance.operationId,
        'edit',
        correctionRequest({
          replacement: {
            intent: 'customer_advance',
            tenders: [{ moneyAccountId: replacementNewAccount, amountMinor: '120' }],
          },
        }),
      ).expect(201);
      expect(await customerBalances(replacementCustomer)).toEqual({
        receivable: '0',
        credit: '120',
      });
      expect(await moneyBalance(replacementOldAccount)).toBe('0');
      expect(await moneyBalance(replacementNewAccount)).toBe('120');

      const immediateEditCustomer = await createCustomer();
      const immediateEditAccount = await createAccount();
      await postOpening(immediateEditCustomer, '300', '2026-09-12T12:00:00Z');
      const immediateEditOriginal = (
        await postCollection(
          immediateEditCustomer,
          fifoRequest([{ moneyAccountId: immediateEditAccount, amountMinor: '400' }], {
            overpaymentHandling: 'refund_excess',
            refundMoneyAccountId: immediateEditAccount,
          }),
        ).expect(201)
      ).body as CustomerCollectionPostingResponse;
      await postCustomerFinancialCorrection(
        immediateEditCustomer,
        'payments',
        immediateEditOriginal.operationId,
        'edit',
        correctionRequest({
          replacement: {
            allocationMode: 'fifo',
            tenders: [{ moneyAccountId: immediateEditAccount, amountMinor: '350' }],
            overpaymentHandling: 'refund_excess',
            refundMoneyAccountId: immediateEditAccount,
          },
        }),
      ).expect(201);
      expect(await customerBalances(immediateEditCustomer)).toEqual({
        receivable: '0',
        credit: '0',
      });
      expect(await moneyBalance(immediateEditAccount)).toBe('300');
    });

    it('corrects Credit applications, refunds, and settlements without inventing Money', async () => {
      const account = await createAccount();
      const refundAccount = await createAccount();
      const customerId = await createCustomer();
      await createCustomerCredit(customerId, account, '500');
      const opening = await postOpening(customerId, '100', '2026-09-13T08:00:00Z');
      const sale = await postCreditSale(customerId, '100', '2026-09-13T09:00:00Z');

      const application = (
        await postCustomerFinancial(
          customerId,
          'credit/applications',
          customerFinancialRequest('100', {
            allocationMode: 'custom',
            allocations: [
              { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' },
            ],
          }),
        ).expect(201)
      ).body as CustomerFinancialResponse;
      await postCustomerFinancialCorrection(
        customerId,
        'credit/applications',
        application.operationId,
        'cancel',
        correctionRequest(),
      ).expect(201);
      expect(await customerBalances(customerId)).toEqual({ receivable: '200', credit: '500' });

      const applicationForEdit = (
        await postCustomerFinancial(
          customerId,
          'credit/applications',
          customerFinancialRequest('100', {
            allocationMode: 'custom',
            allocations: [
              { targetType: 'sale_receivable', targetId: sale.sale.id, amountMinor: '100' },
            ],
          }),
        ).expect(201)
      ).body as CustomerFinancialResponse;
      await postCustomerFinancialCorrection(
        customerId,
        'credit/applications',
        applicationForEdit.operationId,
        'edit',
        correctionRequest({
          replacement: {
            amountMinor: '50',
            allocationMode: 'custom',
            allocations: [
              {
                targetType: 'opening_receivable',
                targetId: opening.receivable.id,
                amountMinor: '50',
              },
            ],
          },
        }),
      ).expect(201);
      expect(await customerBalances(customerId)).toEqual({ receivable: '150', credit: '450' });

      const refund = (
        await postCustomerFinancial(customerId, 'credit/refunds', {
          operationId: randomUUID(),
          occurredAt: '2026-09-13T10:00:00Z',
          amountMinor: '70',
          moneyAccountId: refundAccount,
        }).expect(201)
      ).body as CustomerFinancialResponse;
      await db().admin.query(
        `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
         where store_id=$1 and id=$2`,
        [owner.storeId, refundAccount],
      );
      await postCustomerFinancialCorrection(
        customerId,
        'credit/refunds',
        refund.operationId,
        'cancel',
        correctionRequest(),
      ).expect(201);
      expect(await moneyBalance(refundAccount)).toBe('0');

      const replacementRefundAccount = await createAccount();
      const replacementDestination = await createAccount();
      const refundForEdit = (
        await postCustomerFinancial(customerId, 'credit/refunds', {
          operationId: randomUUID(),
          occurredAt: '2026-09-13T10:10:00Z',
          amountMinor: '70',
          moneyAccountId: replacementRefundAccount,
        }).expect(201)
      ).body as CustomerFinancialResponse;
      await postCustomerFinancialCorrection(
        customerId,
        'credit/refunds',
        refundForEdit.operationId,
        'edit',
        correctionRequest({
          replacement: { amountMinor: '50', moneyAccountId: replacementDestination },
        }),
      ).expect(201);
      expect(await moneyBalance(replacementRefundAccount)).toBe('0');
      expect(await moneyBalance(replacementDestination)).toBe('-50');

      const settlement = (
        await postCustomerFinancial(
          customerId,
          'settlements',
          customerFinancialRequest('50', { reason: 'Original waiver' }),
        ).expect(201)
      ).body as CustomerFinancialResponse;
      const moneyCountBefore = (
        await db().admin.query<{ count: number }>(
          `select count(*)::int as count from ledger.money_movements where store_id=$1`,
          [owner.storeId],
        )
      ).rows[0]?.count;
      const settlementEdit = (
        await postCustomerFinancialCorrection(
          customerId,
          'settlements',
          settlement.operationId,
          'edit',
          correctionRequest({
            replacement: {
              amountMinor: '30',
              allocationMode: 'fifo',
              reason: 'Corrected waiver',
            },
          }),
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;
      expect(settlementEdit.reversal.moneyMovements).toHaveLength(0);
      expect(settlementEdit.replacement).toMatchObject({ action: 'settle_receivable' });
      expect(
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.money_movements where store_id=$1`,
            [owner.storeId],
          )
        ).rows[0]?.count,
      ).toBe(moneyCountBefore);
      expect(await customerBalances(customerId)).toEqual({ receivable: '120', credit: '400' });

      const cancelSettlementCustomer = await createCustomer();
      await postOpening(cancelSettlementCustomer, '50', '2026-09-13T11:00:00Z');
      const cancellableSettlement = (
        await postCustomerFinancial(
          cancelSettlementCustomer,
          'settlements',
          customerFinancialRequest('50', { reason: 'Temporary waiver' }),
        ).expect(201)
      ).body as CustomerFinancialResponse;
      await postCustomerFinancialCorrection(
        cancelSettlementCustomer,
        'settlements',
        cancellableSettlement.operationId,
        'cancel',
        correctionRequest(),
      ).expect(201);
      expect(await customerBalances(cancelSettlementCustomer)).toEqual({
        receivable: '50',
        credit: '0',
      });

      const history = (
        await request(server)
          .get(`/v1/customers/${customerId}/credit-history?limit=100`)
          .set('authorization', `Bearer ${owner.token}`)
          .expect(200)
      ).body as CustomerCreditHistoryResponse;
      expect(history.entries.some((entry) => entry.entryType === 'correction')).toBe(true);
      expect(
        history.entries.some(
          (entry) =>
            entry.reversalOfId !== null &&
            entry.correction !== null &&
            entry.lineage.rootOperationId === entry.correction.operationId,
        ),
      ).toBe(true);
    });

    it('enforces tenant, read_only, current-period, rollback, and same-Customer boundaries', async () => {
      const customerId = await createCustomer();
      const otherCustomer = await createCustomer();
      const account = await createAccount();
      await postOpening(customerId, '100', '2026-08-15T09:00:00Z');
      const originalRequest = fifoRequest([{ moneyAccountId: account, amountMinor: '100' }], {
        occurredAt: '2026-08-15T10:00:00Z',
      });
      const original = (await postCollection(customerId, originalRequest).expect(201))
        .body as CustomerCollectionPostingResponse;
      await db().admin.query(
        `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
         where store_id=$1 and id=$2`,
        [owner.storeId, original.accountingPeriodId],
      );
      const corrected = (
        await postCustomerFinancialCorrection(
          customerId,
          'payments',
          original.operationId,
          'cancel',
          correctionRequest(),
        ).expect(201)
      ).body as CustomerFinancialCorrectionResponse;
      expect(corrected.accountingPeriodId).not.toBe(original.accountingPeriodId);
      expect(
        (
          await db().admin.query<{ accountingPeriodId: string }>(
            `select accounting_period_id as "accountingPeriodId"
             from ledger.customer_payments where store_id=$1 and id=$2`,
            [owner.storeId, original.payments[0]?.id],
          )
        ).rows[0]?.accountingPeriodId,
      ).toBe(original.accountingPeriodId);

      await postCustomerFinancialCorrection(
        otherCustomer,
        'payments',
        original.operationId,
        'cancel',
        correctionRequest(),
      )
        .expect(409)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_CUSTOMER_MISMATCH'));
      await postCustomerFinancialCorrection(
        customerId,
        'payments',
        randomUUID(),
        'cancel',
        correctionRequest(),
        foreignOwner,
      )
        .expect(404)
        .expect(expectResponseCode('CUSTOMER_FINANCIAL_CORRECTION_TARGET_NOT_FOUND'));

      const readOnlyCustomer = await createCustomer();
      const readOnlyAccount = await createAccount();
      const readOnlyAdvance = await createCustomerCredit(readOnlyCustomer, readOnlyAccount, '10');
      await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
        owner.storeId,
      ]);
      try {
        await postCustomerFinancialCorrection(
          readOnlyCustomer,
          'payments',
          readOnlyAdvance.operationId,
          'cancel',
          correctionRequest(),
        ).expect(403);
      } finally {
        await db().admin.query(`update ledger.stores set status='active' where id=$1`, [
          owner.storeId,
        ]);
      }

      const rollbackCustomer = await createCustomer();
      const rollbackAccount = await createAccount();
      const rollbackAdvance = await createCustomerCredit(rollbackCustomer, rollbackAccount, '100');
      const failedOperationId = randomUUID();
      await postCustomerFinancialCorrection(
        rollbackCustomer,
        'payments',
        rollbackAdvance.operationId,
        'edit',
        correctionRequest({
          operationId: failedOperationId,
          replacement: {
            intent: 'customer_advance',
            tenders: [{ moneyAccountId: randomUUID(), amountMinor: '50' }],
          },
        }),
      )
        .expect(404)
        .expect(expectResponseCode('MONEY_ACCOUNT_NOT_FOUND'));
      expect(await customerBalances(rollbackCustomer)).toEqual({ receivable: '0', credit: '100' });
      expect(await moneyBalance(rollbackAccount)).toBe('100');
      expect(
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.customer_ledger_entries
             where store_id=$1 and transaction_group_id=$2 and reversal_of_id is not null`,
            [owner.storeId, deriveTransactionGroupId(failedOperationId)],
          )
        ).rows[0],
      ).toEqual({ count: 0 });

      const closedCustomer = await createCustomer();
      const closedAccount = await createAccount();
      const closedAdvance = await createCustomerCredit(closedCustomer, closedAccount, '10');
      const september = (
        await db().admin.query<{ id: string }>(
          `select id from ledger.accounting_periods
           where store_id=$1 and period_year=2026 and period_month=9`,
          [owner.storeId],
        )
      ).rows[0];
      if (!september) throw new Error('September accounting period is missing.');
      await db().admin.query(
        `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
         where id=$1`,
        [september.id],
      );
      try {
        await postCustomerFinancialCorrection(
          closedCustomer,
          'payments',
          closedAdvance.operationId,
          'cancel',
          correctionRequest(),
        )
          .expect(409)
          .expect(expectResponseCode('ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE'));
      } finally {
        await db().admin.query(
          `update ledger.accounting_periods set status='open',closed_at=null where id=$1`,
          [september.id],
        );
      }
    });

    it('serializes correction races without double reversal or negative balances', async () => {
      const account = await createAccount();

      const advanceCustomer = await createCustomer();
      const advance = await createCustomerCredit(advanceCustomer, account, '100');
      const advanceRace = await Promise.all([
        postCustomerFinancialCorrection(
          advanceCustomer,
          'payments',
          advance.operationId,
          'cancel',
          correctionRequest(),
        ),
        postCustomerFinancial(advanceCustomer, 'credit/refunds', {
          operationId: randomUUID(),
          occurredAt: '2026-09-20T12:00:00Z',
          amountMinor: '100',
          moneyAccountId: account,
        }),
      ]);
      expect(advanceRace.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(BigInt((await customerBalances(advanceCustomer)).credit)).toBeGreaterThanOrEqual(0n);

      const saleRaceCustomer = await createCustomer();
      const saleRaceAdvance = await createCustomerCredit(saleRaceCustomer, account, '100');
      const saleRace = await Promise.all([
        postCustomerFinancialCorrection(
          saleRaceCustomer,
          'payments',
          saleRaceAdvance.operationId,
          'cancel',
          correctionRequest(),
        ),
        postSale(
          customerCreditSaleRequest({
            customerId: saleRaceCustomer,
            totalMinor: '100',
            customerCreditAmountMinor: '100',
          }),
        ),
      ]);
      expect(saleRace.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(BigInt((await customerBalances(saleRaceCustomer)).credit)).toBeGreaterThanOrEqual(0n);

      const leafCustomer = await createCustomer();
      const leafAdvance = await createCustomerCredit(leafCustomer, account, '100');
      const twoCorrections = await Promise.all([
        postCustomerFinancialCorrection(
          leafCustomer,
          'payments',
          leafAdvance.operationId,
          'cancel',
          correctionRequest(),
        ),
        postCustomerFinancialCorrection(
          leafCustomer,
          'payments',
          leafAdvance.operationId,
          'cancel',
          correctionRequest(),
        ),
      ]);
      expect(twoCorrections.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(await customerBalances(leafCustomer)).toEqual({ receivable: '0', credit: '0' });

      const duplicateCustomer = await createCustomer();
      const duplicateAdvance = await createCustomerCredit(duplicateCustomer, account, '100');
      const duplicateBody = correctionRequest();
      const duplicate = await Promise.all([
        postCustomerFinancialCorrection(
          duplicateCustomer,
          'payments',
          duplicateAdvance.operationId,
          'cancel',
          duplicateBody,
        ),
        postCustomerFinancialCorrection(
          duplicateCustomer,
          'payments',
          duplicateAdvance.operationId,
          'cancel',
          duplicateBody,
        ),
      ]);
      expect(duplicate.every((response) => [201, 409].includes(response.status))).toBe(true);
      expect(duplicate.filter((response) => response.status === 201).length).toBeGreaterThanOrEqual(
        1,
      );
      expect(await customerBalances(duplicateCustomer)).toEqual({ receivable: '0', credit: '0' });
      expect(
        (
          await db().admin.query<{ count: number }>(
            `select count(*)::int as count from ledger.customer_ledger_entries
             where store_id=$1 and transaction_group_id=$2 and reversal_of_id is not null`,
            [owner.storeId, deriveTransactionGroupId(duplicateBody.operationId as string)],
          )
        ).rows[0]?.count,
      ).toBe(1);

      const collectionRaceCustomer = await createCustomer();
      const collectionRaceAccount = await createAccount();
      await postOpening(collectionRaceCustomer, '200', '2026-09-20T08:00:00Z');
      const collectionRaceOriginal = (
        await postCollection(
          collectionRaceCustomer,
          fifoRequest([{ moneyAccountId: collectionRaceAccount, amountMinor: '100' }]),
        ).expect(201)
      ).body as CustomerCollectionPostingResponse;
      const collectionRace = await Promise.all([
        postCustomerFinancialCorrection(
          collectionRaceCustomer,
          'payments',
          collectionRaceOriginal.operationId,
          'cancel',
          correctionRequest(),
        ),
        postCollection(
          collectionRaceCustomer,
          fifoRequest([{ moneyAccountId: collectionRaceAccount, amountMinor: '100' }]),
        ),
      ]);
      expect(collectionRace.map((response) => response.status)).toEqual([201, 201]);
      expect(await customerBalances(collectionRaceCustomer)).toEqual({
        receivable: '100',
        credit: '0',
      });

      const applicationRaceCustomer = await createCustomer();
      const applicationRaceAccount = await createAccount();
      await createCustomerCredit(applicationRaceCustomer, applicationRaceAccount, '100');
      await postOpening(applicationRaceCustomer, '200', '2026-09-20T08:10:00Z');
      const applicationRaceOriginal = (
        await postCustomerFinancial(
          applicationRaceCustomer,
          'credit/applications',
          customerFinancialRequest('100'),
        ).expect(201)
      ).body as CustomerFinancialResponse;
      const applicationRace = await Promise.all([
        postCustomerFinancialCorrection(
          applicationRaceCustomer,
          'credit/applications',
          applicationRaceOriginal.operationId,
          'cancel',
          correctionRequest(),
        ),
        postCollection(
          applicationRaceCustomer,
          fifoRequest([{ moneyAccountId: applicationRaceAccount, amountMinor: '100' }]),
        ),
      ]);
      expect(applicationRace.map((response) => response.status)).toEqual([201, 201]);
      expect(await customerBalances(applicationRaceCustomer)).toEqual({
        receivable: '100',
        credit: '100',
      });

      const settlementRaceCustomer = await createCustomer();
      const settlementRaceAccount = await createAccount();
      await postOpening(settlementRaceCustomer, '200', '2026-09-20T08:20:00Z');
      const settlementRaceOriginal = (
        await postCustomerFinancial(
          settlementRaceCustomer,
          'settlements',
          customerFinancialRequest('100', { reason: 'Race waiver' }),
        ).expect(201)
      ).body as CustomerFinancialResponse;
      const settlementRace = await Promise.all([
        postCustomerFinancialCorrection(
          settlementRaceCustomer,
          'settlements',
          settlementRaceOriginal.operationId,
          'cancel',
          correctionRequest(),
        ),
        postCollection(
          settlementRaceCustomer,
          fifoRequest([{ moneyAccountId: settlementRaceAccount, amountMinor: '100' }]),
        ),
      ]);
      expect(settlementRace.map((response) => response.status)).toEqual([201, 201]);
      expect(await customerBalances(settlementRaceCustomer)).toEqual({
        receivable: '100',
        credit: '0',
      });

      const branchCustomer = await createCustomer();
      const branchAccount = await createAccount();
      const branchAdvance = await createCustomerCredit(branchCustomer, branchAccount, '100');
      const branchRace = await Promise.all([
        postCustomerFinancialCorrection(
          branchCustomer,
          'payments',
          branchAdvance.operationId,
          'edit',
          correctionRequest({
            replacement: {
              intent: 'customer_advance',
              tenders: [{ moneyAccountId: branchAccount, amountMinor: '50' }],
            },
          }),
        ),
        postCustomerFinancialCorrection(
          branchCustomer,
          'payments',
          branchAdvance.operationId,
          'cancel',
          correctionRequest(),
        ),
      ]);
      expect(branchRace.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(['0', '50']).toContain((await customerBalances(branchCustomer)).credit);
    });
  });
});
