import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import {
  deriveMoneyFactOperationId,
  deriveTransactionGroupId,
} from '../src/money-movements/money-movement-identity';
import type { SupplierInvoicePostingResponse } from '../src/suppliers/supplier-invoice-posting.types';
import type { SupplierPaymentPostingResponse } from '../src/suppliers/supplier-payment-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0011_supplier_opening_payable_allocations.sql';
const septemberInstant = '2026-09-15T10:00:00Z';

interface TestIdentity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  token: string;
}

interface PaymentFacts {
  payments: number;
  allocations: number;
  payableReductions: number;
  moneyMovements: number;
  ownerEntries: number;
  invoices: number;
  expenses: number;
  goodsReceipts: number;
  inventoryMovements: number;
  stockBalances: number;
}

const ownerA: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s133-owner-a-${randomUUID()}@example.test`,
  token: '',
};
const ownerB: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s133-owner-b-${randomUUID()}@example.test`,
  token: '',
};

const supplierIds = {
  partial: randomUUID(),
  multi: randomUUID(),
  opening: randomUUID(),
  ownerFunded: randomUUID(),
  overInvoice: randomUUID(),
  overOpening: randomUUID(),
  invalidSource: randomUUID(),
  mismatchA: randomUUID(),
  mismatchB: randomUUID(),
  closed: randomUUID(),
  race: randomUUID(),
  raceMulti: randomUUID(),
  atomic: randomUUID(),
  guardInvoice: randomUUID(),
  guardOpening: randomUUID(),
  guardUnpaid: randomUUID(),
  bigint: randomUUID(),
  foreign: randomUUID(),
} as const;

const accountIds = {
  active: randomUUID(),
  archived: randomUUID(),
  held: randomUUID(),
  foreign: randomUUID(),
} as const;

describe('S13.3 Supplier Payment posting on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S13.3 database is unavailable.');
    return database;
  }

  function invoiceBody(
    operationId: string,
    amountMinor: string,
    occurredAt = septemberInstant,
  ): Record<string, unknown> {
    return {
      operationId,
      occurredAt,
      items: [
        {
          description: 'Supplier payable item',
          unitName: 'piece',
          quantityMilli: '1000',
          unitCostMinor: amountMinor,
          lineTotalMinor: amountMinor,
        },
      ],
      totalMinor: amountMinor,
    };
  }

  async function postInvoice(
    supplierId: string,
    amountMinor: string,
    operationId = randomUUID(),
    identity = ownerA,
    occurredAt = septemberInstant,
  ): Promise<{ operationId: string; response: SupplierInvoicePostingResponse }> {
    const result = await request(server)
      .post(`/v1/suppliers/${supplierId}/invoices`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(invoiceBody(operationId, amountMinor, occurredAt))
      .expect(201);
    return { operationId, response: result.body as SupplierInvoicePostingResponse };
  }

  async function postOpening(
    supplierId: string,
    amountMinor: string,
    operationId = randomUUID(),
    identity = ownerA,
  ): Promise<{ operationId: string; payableId: string }> {
    const result = await request(server)
      .post(`/v1/suppliers/${supplierId}/opening-payables`)
      .set('authorization', `Bearer ${identity.token}`)
      .send({ operationId, amountMinor, occurredAt: septemberInstant })
      .expect(201);
    const body = result.body as { payable: { id: string } };
    return { operationId, payableId: body.payable.id };
  }

  function paymentBody(input: {
    operationId?: string;
    paymentSource?: 'money_account' | 'owner_pocket';
    moneyAccountId?: string | null;
    amountMinor: string;
    occurredAt?: string;
    allocations: {
      targetType: 'purchase_invoice' | 'opening_payable';
      targetId: string;
      amountMinor: string;
    }[];
  }): Record<string, unknown> {
    const source = input.paymentSource ?? 'money_account';
    return {
      operationId: input.operationId ?? randomUUID(),
      paymentSource: source,
      moneyAccountId:
        input.moneyAccountId === undefined
          ? source === 'money_account'
            ? accountIds.active
            : null
          : input.moneyAccountId,
      amountMinor: input.amountMinor,
      occurredAt: input.occurredAt ?? septemberInstant,
      externalReference: 'S13.3 fixture',
      notes: 'Explicit Supplier allocation',
      allocations: input.allocations,
    };
  }

  function postPayment(identity: TestIdentity, supplierId: string, body: Record<string, unknown>) {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/payments`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  async function facts(storeId = ownerA.storeId): Promise<PaymentFacts> {
    const result = await db().admin.query<PaymentFacts>(
      `select
        (select count(*)::integer from ledger.supplier_payments where store_id=$1) as payments,
        (select count(*)::integer from ledger.supplier_payment_allocations where store_id=$1) as allocations,
        (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1 and entry_type='payment') as "payableReductions",
        (select count(*)::integer from ledger.money_movements where store_id=$1 and movement_type='supplier_payment') as "moneyMovements",
        (select count(*)::integer from ledger.owner_ledger_entries where store_id=$1 and entry_type='owner_paid_supplier') as "ownerEntries",
        (select count(*)::integer from ledger.purchase_invoices where store_id=$1) as invoices,
        (select count(*)::integer from ledger.expenses where store_id=$1) as expenses,
        (select count(*)::integer from ledger.goods_receipts where store_id=$1) as "goodsReceipts",
        (select count(*)::integer from ledger.inventory_movements where store_id=$1) as "inventoryMovements",
        (select count(*)::integer from ledger.stock_balances where store_id=$1) as "stockBalances"`,
      [storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected S13.3 fact counts.');
    return row;
  }

  async function supplierOutstanding(supplierId: string): Promise<string> {
    const result = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(payable_delta_minor-credit_delta_minor),0)::text as amount
       from ledger.supplier_ledger_entries where supplier_id=$1`,
      [supplierId],
    );
    return result.rows[0]?.amount ?? 'missing';
  }

  async function targetAllocated(targetType: 'invoice' | 'opening', targetId: string) {
    const column =
      targetType === 'invoice' ? 'purchase_invoice_id' : 'opening_payable_ledger_entry_id';
    const result = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(allocation.amount_minor),0)::text as amount
       from ledger.supplier_payment_allocations allocation
       inner join ledger.supplier_payments payment
         on payment.store_id=allocation.store_id and payment.id=allocation.supplier_payment_id
       where allocation.${column}=$1 and payment.status='posted'`,
      [targetId],
    );
    return result.rows[0]?.amount ?? 'missing';
  }

  async function accountBalance(accountId: string): Promise<string> {
    const result = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as amount
       from ledger.money_movements where account_id=$1`,
      [accountId],
    );
    return result.rows[0]?.amount ?? 'missing';
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
      throw new Error('S13.3 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s133-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s133-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S13.3 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S13.3 owner')`,
        [identity.userId, identity.email, passwordHash],
      );
      await db().admin.query(
        `insert into platform.store_memberships(id,store_id,user_id,role,status)
         values($1,$2,$3,'owner','active')`,
        [randomUUID(), identity.storeId, identity.userId],
      );
    }

    for (const [name, supplierId] of Object.entries(supplierIds)) {
      const storeId = name === 'foreign' ? ownerB.storeId : ownerA.storeId;
      await db().admin.query(
        `insert into ledger.suppliers(
           id,store_id,name,normalized_name,status,operation_id
         ) values($1,$2,$3,$4,'active',$5)`,
        [supplierId, storeId, `S13.3 ${name}`, `s13.3 ${name}`, randomUUID()],
      );
    }
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id
       ) values
         ($1,$5,'S13 active','s13 active','transfer','available','active',null,$7),
         ($2,$5,'S13 archived','s13 archived','transfer','available','archived',clock_timestamp(),$8),
         ($3,$5,'S13 held','s13 held','external_party','held_by_external_party','active',null,$9),
         ($4,$6,'S13 foreign','s13 foreign','transfer','available','active',null,$10)`,
      [
        accountIds.active,
        accountIds.archived,
        accountIds.held,
        accountIds.foreign,
        ownerA.storeId,
        ownerB.storeId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );

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

    for (const identity of [ownerA, ownerB]) {
      const login = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S13.3 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S13.3 login token missing.');
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
        const idle = await database.admin.query<{ count: number }>(
          `select count(*)::integer as count from pg_stat_activity
           where datname=current_database() and state like 'idle in transaction%'`,
        );
        expect(idle.rows[0]).toEqual({ count: 0 });
      }
    } finally {
      await database?.close();
    }
  });

  it('posts partial, subsequent, and full Money Account settlements exactly once', async () => {
    const invoice = await postInvoice(supplierIds.partial, '500');
    const before = await facts();
    const payments = [
      paymentBody({
        amountMinor: '200',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '200',
          },
        ],
      }),
      paymentBody({
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
      paymentBody({
        amountMinor: '200',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '200',
          },
        ],
      }),
    ];

    for (const body of payments) {
      const posted = await postPayment(ownerA, supplierIds.partial, body).expect(201);
      const response = posted.body as SupplierPaymentPostingResponse;
      expect(response.payment).toMatchObject({
        paymentSource: 'money_account',
        moneyAccountId: accountIds.active,
        status: 'posted',
        creditCreatedMinor: '0',
      });
      expect(response.moneyMovement?.amountDeltaMinor).toBe(`-${response.payment.amountMinor}`);
      expect(response.payable.payableDeltaMinor).toBe(`-${response.payment.amountMinor}`);
      expect(response.ownerLedgerEntry).toBeNull();
    }

    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('500');
    expect(await supplierOutstanding(supplierIds.partial)).toBe('0');
    expect(await accountBalance(accountIds.active)).toBe('-500');
    const after = await facts();
    expect(after).toEqual({
      ...before,
      payments: before.payments + 3,
      allocations: before.allocations + 3,
      payableReductions: before.payableReductions + 3,
      moneyMovements: before.moneyMovements + 3,
    });
    expect(after.invoices).toBe(before.invoices);
    expect(after.expenses).toBe(before.expenses);
    expect(after.goodsReceipts).toBe(before.goodsReceipts);
    expect(after.inventoryMovements).toBe(before.inventoryMovements);
    expect(after.stockBalances).toBe(before.stockBalances);

    const audit = await db().admin.query<{ changes: number; audits: number }>(
      `select
        (select count(*)::integer from sync.change_events
          where store_id=$1 and entity_type='supplier_payments') as changes,
        (select count(*)::integer from audit.central_audit_logs
          where store_id=$1 and entity_type='ledger.supplier_payments') as audits`,
      [ownerA.storeId],
    );
    expect(audit.rows[0]?.changes).toBeGreaterThanOrEqual(6);
    expect(audit.rows[0]?.audits).toBeGreaterThanOrEqual(6);
  });

  it('posts explicit multi-Invoice allocations and canonicalizes replay order', async () => {
    const invoiceA = await postInvoice(supplierIds.multi, '300');
    const invoiceB = await postInvoice(supplierIds.multi, '500');
    const operationId = randomUUID();
    const allocations = [
      {
        targetType: 'purchase_invoice' as const,
        targetId: invoiceB.response.invoice.id,
        amountMinor: '300',
      },
      {
        targetType: 'purchase_invoice' as const,
        targetId: invoiceA.response.invoice.id,
        amountMinor: '300',
      },
    ];
    const firstBody = paymentBody({
      operationId,
      amountMinor: '600',
      allocations,
    });
    const first = await postPayment(ownerA, supplierIds.multi, firstBody).expect(201);
    const replay = await postPayment(
      ownerA,
      supplierIds.multi,
      paymentBody({
        operationId,
        amountMinor: '600',
        allocations: [...allocations].reverse(),
      }),
    ).expect(201);
    expect(replay.body).toEqual(first.body);
    expect((first.body as SupplierPaymentPostingResponse).allocations).toHaveLength(2);
    const replayFacts = await db().admin.query<{ payments: number; allocations: number }>(
      `select
        (select count(*)::integer from ledger.supplier_payments
          where store_id=$1 and operation_id=$2) as payments,
        (select count(*)::integer from ledger.supplier_payment_allocations allocation
          inner join ledger.supplier_payments payment
            on payment.store_id=allocation.store_id
            and payment.id=allocation.supplier_payment_id
          where payment.store_id=$1 and payment.operation_id=$2) as allocations`,
      [ownerA.storeId, operationId],
    );
    expect(replayFacts.rows[0]).toEqual({ payments: 1, allocations: 2 });
    expect(await targetAllocated('invoice', invoiceA.response.invoice.id)).toBe('300');
    expect(await targetAllocated('invoice', invoiceB.response.invoice.id)).toBe('300');
    expect(await supplierOutstanding(supplierIds.multi)).toBe('200');

    await postPayment(
      ownerA,
      supplierIds.multi,
      paymentBody({
        operationId,
        amountMinor: '600',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoiceA.response.invoice.id,
            amountMinor: '299',
          },
          {
            targetType: 'purchase_invoice',
            targetId: invoiceB.response.invoice.id,
            amountMinor: '301',
          },
        ],
      }),
    )
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
  });

  it('settles Invoice and Opening Payable targets without fabricating an Invoice', async () => {
    const invoice = await postInvoice(supplierIds.opening, '300');
    const opening = await postOpening(supplierIds.opening, '1200');
    const beforeInvoices = (await facts()).invoices;
    await postPayment(
      ownerA,
      supplierIds.opening,
      paymentBody({
        amountMinor: '500',
        allocations: [
          { targetType: 'opening_payable', targetId: opening.payableId, amountMinor: '200' },
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '300',
          },
        ],
      }),
    ).expect(201);
    await postPayment(
      ownerA,
      supplierIds.opening,
      paymentBody({
        amountMinor: '1000',
        allocations: [
          { targetType: 'opening_payable', targetId: opening.payableId, amountMinor: '1000' },
        ],
      }),
    ).expect(201);
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('300');
    expect(await targetAllocated('opening', opening.payableId)).toBe('1200');
    expect(await supplierOutstanding(supplierIds.opening)).toBe('0');
    expect((await facts()).invoices).toBe(beforeInvoices);
  });

  it('posts owner-funded settlement as owner liability with no Money Account movement', async () => {
    const invoice = await postInvoice(supplierIds.ownerFunded, '400');
    const before = await facts();
    const ownerBefore = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(owner_liability_delta_minor),0)::text as amount
       from ledger.owner_ledger_entries where store_id=$1`,
      [ownerA.storeId],
    );
    const posted = await postPayment(
      ownerA,
      supplierIds.ownerFunded,
      paymentBody({
        paymentSource: 'owner_pocket',
        moneyAccountId: null,
        amountMinor: '400',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '400',
          },
        ],
      }),
    ).expect(201);
    const response = posted.body as SupplierPaymentPostingResponse;
    expect(response.payment).toMatchObject({
      paymentSource: 'owner_pocket',
      moneyAccountId: null,
      moneyMovementId: null,
    });
    expect(response.moneyMovement).toBeNull();
    expect(response.ownerLedgerEntry).toMatchObject({
      entryType: 'owner_paid_supplier',
      ownerLiabilityDeltaMinor: '400',
      equityDeltaMinor: '0',
      moneyAccountId: null,
    });
    const after = await facts();
    expect(after.ownerEntries).toBe(before.ownerEntries + 1);
    expect(after.moneyMovements).toBe(before.moneyMovements);
    expect(await supplierOutstanding(supplierIds.ownerFunded)).toBe('0');
    const ownerAfter = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(owner_liability_delta_minor),0)::text as amount
       from ledger.owner_ledger_entries where store_id=$1`,
      [ownerA.storeId],
    );
    expect(
      BigInt(ownerAfter.rows[0]?.amount ?? '0') - BigInt(ownerBefore.rows[0]?.amount ?? '0'),
    ).toBe(400n);
  });

  it('rejects invalid amounts, incomplete allocations, and over-allocation', async () => {
    const invoice = await postInvoice(supplierIds.overInvoice, '300');
    const opening = await postOpening(supplierIds.overOpening, '300');
    for (const amountMinor of ['0', '-1']) {
      await postPayment(
        ownerA,
        supplierIds.overInvoice,
        paymentBody({
          amountMinor,
          allocations: [
            {
              targetType: 'purchase_invoice',
              targetId: invoice.response.invoice.id,
              amountMinor: '1',
            },
          ],
        }),
      ).expect(400);
    }
    await postPayment(
      ownerA,
      supplierIds.overInvoice,
      paymentBody({
        amountMinor: '200',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '199',
          },
        ],
      }),
    ).expect(400);
    await postPayment(
      ownerA,
      supplierIds.overInvoice,
      paymentBody({
        amountMinor: '301',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '301',
          },
        ],
      }),
    )
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING' }),
      );
    await postPayment(
      ownerA,
      supplierIds.overOpening,
      paymentBody({
        amountMinor: '301',
        allocations: [
          { targetType: 'opening_payable', targetId: opening.payableId, amountMinor: '301' },
        ],
      }),
    )
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING' }),
      );
    expect(await supplierOutstanding(supplierIds.overInvoice)).toBe('300');
    expect(await supplierOutstanding(supplierIds.overOpening)).toBe('300');
  });

  it('rejects unavailable and foreign sources and cross-tenant or cross-Supplier targets', async () => {
    const invoice = await postInvoice(supplierIds.invalidSource, '100');
    for (const [accountId, code, status] of [
      [randomUUID(), 'MONEY_ACCOUNT_NOT_FOUND', 404],
      [accountIds.archived, 'MONEY_ACCOUNT_UNAVAILABLE', 409],
      [accountIds.held, 'MONEY_ACCOUNT_UNAVAILABLE', 409],
      [accountIds.foreign, 'MONEY_ACCOUNT_NOT_FOUND', 404],
    ] as const) {
      await postPayment(
        ownerA,
        supplierIds.invalidSource,
        paymentBody({
          moneyAccountId: accountId,
          amountMinor: '100',
          allocations: [
            {
              targetType: 'purchase_invoice',
              targetId: invoice.response.invoice.id,
              amountMinor: '100',
            },
          ],
        }),
      )
        .expect(status)
        .expect(({ body }) => expect(body).toMatchObject({ code }));
    }

    const mismatchTarget = await postInvoice(supplierIds.mismatchB, '100');
    await postPayment(
      ownerA,
      supplierIds.mismatchA,
      paymentBody({
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: mismatchTarget.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    )
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_TARGET_SUPPLIER_MISMATCH' }),
      );

    const foreignInvoice = await postInvoice(supplierIds.foreign, '100', randomUUID(), ownerB);
    const foreignOpening = await postOpening(supplierIds.foreign, '100', randomUUID(), ownerB);
    await postPayment(
      ownerA,
      supplierIds.mismatchA,
      paymentBody({
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: foreignInvoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    )
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_TARGET_NOT_FOUND' }),
      );
    await postPayment(
      ownerA,
      supplierIds.mismatchA,
      paymentBody({
        amountMinor: '100',
        allocations: [
          {
            targetType: 'opening_payable',
            targetId: foreignOpening.payableId,
            amountMinor: '100',
          },
        ],
      }),
    )
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_TARGET_NOT_FOUND' }),
      );
    await postPayment(
      ownerA,
      supplierIds.foreign,
      paymentBody({
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: foreignInvoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    )
      .expect(404)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' }));
  });

  it('rejects new posting in a closed period and preserves the historical rejection', async () => {
    const occurredAt = '2026-12-10T10:00:00Z';
    const invoice = await postInvoice(supplierIds.closed, '100', randomUUID(), ownerA, occurredAt);
    const periodId = deriveAccountingPeriodId(ownerA.storeId, 2026, 12);
    await db().admin.query(
      `update ledger.accounting_periods
       set status='closed',closed_at=clock_timestamp() where id=$1`,
      [periodId],
    );
    const operationId = randomUUID();
    const body = paymentBody({
      operationId,
      amountMinor: '100',
      occurredAt,
      allocations: [
        {
          targetType: 'purchase_invoice',
          targetId: invoice.response.invoice.id,
          amountMinor: '100',
        },
      ],
    });
    await postPayment(ownerA, supplierIds.closed, body)
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await db().admin.query(
      `update ledger.accounting_periods set status='open',closed_at=null where id=$1`,
      [periodId],
    );
    await postPayment(ownerA, supplierIds.closed, body)
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await postPayment(ownerA, supplierIds.closed, {
      ...body,
      notes: 'Changed reuse',
    })
      .expect(409)
      .expect(({ body: error }) => expect(error).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
  });

  it('serializes concurrent full settlement and concurrent multi-target settlement', async () => {
    const invoice = await postInvoice(supplierIds.race, '300');
    const singleResults = await Promise.all(
      [randomUUID(), randomUUID()].map((operationId) =>
        postPayment(
          ownerA,
          supplierIds.race,
          paymentBody({
            operationId,
            amountMinor: '300',
            allocations: [
              {
                targetType: 'purchase_invoice',
                targetId: invoice.response.invoice.id,
                amountMinor: '300',
              },
            ],
          }),
        ),
      ),
    );
    expect(singleResults.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('300');

    const first = await postInvoice(supplierIds.raceMulti, '300');
    const second = await postInvoice(supplierIds.raceMulti, '300');
    const allocations = [
      {
        targetType: 'purchase_invoice' as const,
        targetId: first.response.invoice.id,
        amountMinor: '300',
      },
      {
        targetType: 'purchase_invoice' as const,
        targetId: second.response.invoice.id,
        amountMinor: '300',
      },
    ];
    const multiResults = await Promise.all(
      [randomUUID(), randomUUID()].map((operationId) =>
        postPayment(
          ownerA,
          supplierIds.raceMulti,
          paymentBody({ operationId, amountMinor: '600', allocations }),
        ),
      ),
    );
    expect(multiResults.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await targetAllocated('invoice', first.response.invoice.id)).toBe('300');
    expect(await targetAllocated('invoice', second.response.invoice.id)).toBe('300');
  });

  it('rolls back all partial facts and the claim on an unexpected mid-transaction failure', async () => {
    const invoice = await postInvoice(supplierIds.atomic, '100');
    const operationId = randomUUID();
    await db().admin.query(
      `insert into ledger.money_movements(
         id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
         reference_type,reference_id,transaction_group_id,occurred_at,operation_id
       ) values($1,$2,$3,$4,'other',1,'fixture',$5,$6,$7,$8)`,
      [
        randomUUID(),
        ownerA.storeId,
        accountIds.active,
        invoice.response.accountingPeriodId,
        randomUUID(),
        deriveTransactionGroupId(randomUUID()),
        septemberInstant,
        deriveMoneyFactOperationId(operationId, 'supplier-payment-money'),
      ],
    );
    const before = await facts();
    await postPayment(
      ownerA,
      supplierIds.atomic,
      paymentBody({
        operationId,
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    ).expect(500);
    expect(await facts()).toEqual(before);
    const residue = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from sync.processed_operations
       where store_id=$1 and operation_id=$2`,
      [ownerA.storeId, operationId],
    );
    expect(residue.rows[0]).toEqual({ count: 0 });
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('0');
    expect(await supplierOutstanding(supplierIds.atomic)).toBe('100');
  });

  it('blocks S12 correction of allocated targets without mutating allocations', async () => {
    const invoice = await postInvoice(supplierIds.guardInvoice, '100');
    const opening = await postOpening(supplierIds.guardOpening, '100');
    const unpaid = await postInvoice(supplierIds.guardUnpaid, '100');
    await postPayment(
      ownerA,
      supplierIds.guardInvoice,
      paymentBody({
        amountMinor: '50',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '50',
          },
        ],
      }),
    ).expect(201);
    await postPayment(
      ownerA,
      supplierIds.guardOpening,
      paymentBody({
        amountMinor: '50',
        allocations: [
          { targetType: 'opening_payable', targetId: opening.payableId, amountMinor: '50' },
        ],
      }),
    ).expect(201);
    const before = (await facts()).allocations;

    await request(server)
      .post(`/v1/suppliers/invoices/${invoice.operationId}/cancel`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({ operationId: randomUUID(), occurredAt: septemberInstant })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS' }),
      );
    await request(server)
      .post(`/v1/suppliers/invoices/${invoice.operationId}/edit`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({
        operationId: randomUUID(),
        occurredAt: septemberInstant,
        replacement: {
          supplierId: supplierIds.guardInvoice,
          items: [
            {
              description: 'Unsafe replacement',
              unitName: 'piece',
              quantityMilli: '1000',
              unitCostMinor: '90',
            },
          ],
        },
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS' }),
      );
    await request(server)
      .post(`/v1/suppliers/opening-payables/${opening.operationId}/cancel`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({ operationId: randomUUID(), occurredAt: septemberInstant })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS' }),
      );
    await request(server)
      .post(`/v1/suppliers/invoices/${unpaid.operationId}/cancel`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({ operationId: randomUUID(), occurredAt: septemberInstant })
      .expect(201);
    await postPayment(
      ownerA,
      supplierIds.guardUnpaid,
      paymentBody({
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: unpaid.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    )
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_TARGET_NOT_ACTIVE' }),
      );
    expect((await facts()).allocations).toBe(before);
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('50');
    expect(await targetAllocated('opening', opening.payableId)).toBe('50');
  });

  it('preserves bigint money above Number.MAX_SAFE_INTEGER without Number authority', async () => {
    const amountMinor = '9007199254740993';
    const invoice = await postInvoice(supplierIds.bigint, amountMinor);
    const posted = await postPayment(
      ownerA,
      supplierIds.bigint,
      paymentBody({
        paymentSource: 'owner_pocket',
        moneyAccountId: null,
        amountMinor,
        allocations: [
          { targetType: 'purchase_invoice', targetId: invoice.response.invoice.id, amountMinor },
        ],
      }),
    ).expect(201);
    const response = posted.body as SupplierPaymentPostingResponse;
    expect(response.payment.amountMinor).toBe(amountMinor);
    expect(response.payable.payableDeltaMinor).toBe(`-${amountMinor}`);
    expect(response.ownerLedgerEntry?.ownerLiabilityDeltaMinor).toBe(amountMinor);
    expect(await supplierOutstanding(supplierIds.bigint)).toBe('0');
  });

  it('fails closed without tenant context and exposes no foreign payment facts', async () => {
    if (!runtimePool) throw new Error('S13.3 runtime pool is unavailable.');
    const hidden = await runtimePool.query<{ count: number }>(
      `select count(*)::integer as count from ledger.supplier_payments`,
    );
    expect(hidden.rows[0]).toEqual({ count: 0 });
    await request(server)
      .post(`/v1/suppliers/${supplierIds.partial}/payments`)
      .send(
        paymentBody({
          amountMinor: '1',
          allocations: [
            { targetType: 'purchase_invoice', targetId: randomUUID(), amountMinor: '1' },
          ],
        }),
      )
      .expect(401);
  });
});
