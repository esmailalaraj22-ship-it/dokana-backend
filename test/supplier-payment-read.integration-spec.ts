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
  SupplierFinancialResponse,
  SupplierInvoiceDetailResponse,
} from '../src/suppliers/supplier-financial-read.types';
import type { SupplierInvoicePostingResponse } from '../src/suppliers/supplier-invoice-posting.types';
import type {
  SupplierPaymentDetailResponse,
  SupplierPaymentListResponse,
} from '../src/suppliers/supplier-payment-read.types';
import type { SupplierPaymentPostingResponse } from '../src/suppliers/supplier-payment-posting.types';
import { applyMigration, verifyMigrationSession } from '../scripts/migrate';
import {
  createInventoryTestDatabase,
  type InventoryTestDatabase,
} from './inventory-postgresql-fixture';
import { createTestPool, readLocalPostgresTestEnvironment } from './postgresql-test-environment';

const migrationFilename = '0011_supplier_opening_payable_allocations.sql';
const instant = '2026-09-15T10:00:00Z';

interface TestIdentity {
  storeId: string;
  userId: string;
  deviceId: string;
  email: string;
  token: string;
}

interface EffectCounts {
  payments: number;
  allocations: number;
  supplierLedger: number;
  moneyMovements: number;
  ownerLedger: number;
  periods: number;
  processedOperations: number;
  changeEvents: number;
  audits: number;
}

const ownerA: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s134-owner-a-${randomUUID()}@example.test`,
  token: '',
};
const ownerB: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s134-owner-b-${randomUUID()}@example.test`,
  token: '',
};
const supplierIds = {
  invoiceStates: randomUUID(),
  openingUnpaid: randomUUID(),
  openingPartial: randomUUID(),
  openingPaid: randomUUID(),
  sources: randomUUID(),
  bigint: randomUUID(),
  foreign: randomUUID(),
} as const;
const accountId = randomUUID();

describe('S13.4 Supplier Payment reads on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  const invoices = {
    unpaid: { id: '', operationId: '' },
    partial: { id: '', operationId: '' },
    paid: { id: '', operationId: '' },
    openingCompanion: { id: '', operationId: '' },
    source: { id: '', operationId: '' },
    bigint: { id: '', operationId: '' },
    foreign: { id: '', operationId: '' },
  };
  const openings = {
    unpaid: { id: '', operationId: '' },
    partial: { id: '', operationId: '' },
    paid: { id: '', operationId: '' },
    foreign: { id: '', operationId: '' },
  };
  const payments = {
    multiInvoice: '',
    partialSecond: '',
    openingPartialFirst: '',
    openingPartialSecond: '',
    openingPaidFirst: '',
    openingPaidSecond: '',
    moneyAccount: '',
    ownerFunded: '',
    bigint: '',
    foreign: '',
  };

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S13.4 database is unavailable.');
    return database;
  }

  function authorizedGet(identity: TestIdentity, path: string) {
    return request(server).get(path).set('authorization', `Bearer ${identity.token}`);
  }

  function invoiceBody(operationId: string, amountMinor: string): Record<string, unknown> {
    return {
      operationId,
      occurredAt: instant,
      items: [
        {
          description: 'S13.4 payable item',
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
    identity = ownerA,
  ): Promise<{ id: string; operationId: string }> {
    const operationId = randomUUID();
    const response = await request(server)
      .post(`/v1/suppliers/${supplierId}/invoices`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(invoiceBody(operationId, amountMinor))
      .expect(201);
    const body = response.body as SupplierInvoicePostingResponse;
    return { id: body.invoice.id, operationId };
  }

  async function postOpening(
    supplierId: string,
    amountMinor: string,
    identity = ownerA,
  ): Promise<{ id: string; operationId: string }> {
    const operationId = randomUUID();
    const response = await request(server)
      .post(`/v1/suppliers/${supplierId}/opening-payables`)
      .set('authorization', `Bearer ${identity.token}`)
      .send({ operationId, amountMinor, occurredAt: instant })
      .expect(201);
    const body = response.body as { payable: { id: string } };
    return { id: body.payable.id, operationId };
  }

  async function postPayment(input: {
    supplierId: string;
    identity?: TestIdentity;
    source?: 'money_account' | 'owner_pocket';
    occurredAt: string;
    allocations: {
      targetType: 'purchase_invoice' | 'opening_payable';
      targetId: string;
      amountMinor: string;
    }[];
  }): Promise<SupplierPaymentPostingResponse> {
    const identity = input.identity ?? ownerA;
    const source = input.source ?? 'money_account';
    const amountMinor = input.allocations
      .reduce((total, allocation) => total + BigInt(allocation.amountMinor), 0n)
      .toString();
    const response = await request(server)
      .post(`/v1/suppliers/${input.supplierId}/payments`)
      .set('authorization', `Bearer ${identity.token}`)
      .send({
        operationId: randomUUID(),
        paymentSource: source,
        moneyAccountId: source === 'money_account' ? accountId : null,
        amountMinor,
        occurredAt: input.occurredAt,
        externalReference: 'S13.4 fixture',
        notes: 'S13.4 payment read fixture',
        allocations: input.allocations,
      })
      .expect(201);
    return response.body as SupplierPaymentPostingResponse;
  }

  async function financial(supplierId: string): Promise<SupplierFinancialResponse> {
    const response = await authorizedGet(ownerA, `/v1/suppliers/${supplierId}/invoices`).expect(
      200,
    );
    return response.body as SupplierFinancialResponse;
  }

  async function effectCounts(): Promise<EffectCounts> {
    const result = await db().admin.query<EffectCounts>(
      `select
        (select count(*)::integer from ledger.supplier_payments where store_id=$1) as payments,
        (select count(*)::integer from ledger.supplier_payment_allocations where store_id=$1) as allocations,
        (select count(*)::integer from ledger.supplier_ledger_entries where store_id=$1) as "supplierLedger",
        (select count(*)::integer from ledger.money_movements where store_id=$1) as "moneyMovements",
        (select count(*)::integer from ledger.owner_ledger_entries where store_id=$1) as "ownerLedger",
        (select count(*)::integer from ledger.accounting_periods where store_id=$1) as periods,
        (select count(*)::integer from sync.processed_operations where store_id=$1) as "processedOperations",
        (select count(*)::integer from sync.change_events where store_id=$1) as "changeEvents",
        (select count(*)::integer from audit.central_audit_logs where store_id=$1) as audits`,
      [ownerA.storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('S13.4 effect counts are unavailable.');
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
      throw new Error('S13.4 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s134-runtime', 6);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s134-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S13.4 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S13.4 owner')`,
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
        [supplierId, storeId, `S13.4 ${name}`, `s13.4 ${name}`, randomUUID()],
      );
    }
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.money_accounts(
           id,store_id,name,normalized_name,account_type,availability,status,operation_id
         ) values($1,$2,'S13.4 Cash','s13.4 cash','transfer','available','active',$3)`,
        [identity === ownerA ? accountId : randomUUID(), identity.storeId, randomUUID()],
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

    for (const identity of [ownerA, ownerB]) {
      const login = await request(server)
        .post('/v1/auth/login')
        .send({
          email: identity.email,
          password,
          storeId: identity.storeId,
          deviceId: identity.deviceId,
          deviceName: 'S13.4 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S13.4 login token missing.');
      identity.token = body.accessToken;
    }

    invoices.unpaid = await postInvoice(supplierIds.invoiceStates, '500');
    invoices.partial = await postInvoice(supplierIds.invoiceStates, '500');
    invoices.paid = await postInvoice(supplierIds.invoiceStates, '300');
    const multi = await postPayment({
      supplierId: supplierIds.invoiceStates,
      occurredAt: '2026-09-15T09:00:00Z',
      allocations: [
        { targetType: 'purchase_invoice', targetId: invoices.partial.id, amountMinor: '100' },
        { targetType: 'purchase_invoice', targetId: invoices.paid.id, amountMinor: '300' },
      ],
    });
    payments.multiInvoice = multi.payment.id;
    const second = await postPayment({
      supplierId: supplierIds.invoiceStates,
      occurredAt: '2026-09-15T10:00:00Z',
      allocations: [
        { targetType: 'purchase_invoice', targetId: invoices.partial.id, amountMinor: '100' },
      ],
    });
    payments.partialSecond = second.payment.id;

    openings.unpaid = await postOpening(supplierIds.openingUnpaid, '1200');
    openings.partial = await postOpening(supplierIds.openingPartial, '1200');
    invoices.openingCompanion = await postInvoice(supplierIds.openingPartial, '300');
    for (const [index, amountMinor] of ['200', '300'].entries()) {
      const posted = await postPayment({
        supplierId: supplierIds.openingPartial,
        occurredAt: `2026-09-16T${(index + 9).toString().padStart(2, '0')}:00:00Z`,
        allocations: [
          {
            targetType: 'opening_payable',
            targetId: openings.partial.id,
            amountMinor,
          },
        ],
      });
      if (index === 0) payments.openingPartialFirst = posted.payment.id;
      else payments.openingPartialSecond = posted.payment.id;
    }

    openings.paid = await postOpening(supplierIds.openingPaid, '1200');
    for (const [index, amountMinor] of ['200', '1000'].entries()) {
      const posted = await postPayment({
        supplierId: supplierIds.openingPaid,
        occurredAt: `2026-09-17T${String(index + 10)}:00:00Z`,
        allocations: [{ targetType: 'opening_payable', targetId: openings.paid.id, amountMinor }],
      });
      if (index === 0) payments.openingPaidFirst = posted.payment.id;
      else payments.openingPaidSecond = posted.payment.id;
    }

    invoices.source = await postInvoice(supplierIds.sources, '400');
    payments.moneyAccount = (
      await postPayment({
        supplierId: supplierIds.sources,
        occurredAt: '2026-09-18T11:00:00Z',
        allocations: [
          { targetType: 'purchase_invoice', targetId: invoices.source.id, amountMinor: '200' },
        ],
      })
    ).payment.id;
    payments.ownerFunded = (
      await postPayment({
        supplierId: supplierIds.sources,
        source: 'owner_pocket',
        occurredAt: '2026-09-18T12:00:00Z',
        allocations: [
          { targetType: 'purchase_invoice', targetId: invoices.source.id, amountMinor: '200' },
        ],
      })
    ).payment.id;

    invoices.bigint = await postInvoice(supplierIds.bigint, '9007199254740993');
    payments.bigint = (
      await postPayment({
        supplierId: supplierIds.bigint,
        source: 'owner_pocket',
        occurredAt: '2026-09-19T10:00:00Z',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoices.bigint.id,
            amountMinor: '9007199254740993',
          },
        ],
      })
    ).payment.id;

    invoices.foreign = await postInvoice(supplierIds.foreign, '100', ownerB);
    openings.foreign = await postOpening(supplierIds.foreign, '100', ownerB);
    payments.foreign = (
      await postPayment({
        supplierId: supplierIds.foreign,
        identity: ownerB,
        source: 'owner_pocket',
        occurredAt: '2026-09-19T11:00:00Z',
        allocations: [
          { targetType: 'purchase_invoice', targetId: invoices.foreign.id, amountMinor: '100' },
        ],
      })
    ).payment.id;

    await db().admin.query(
      `update ledger.money_accounts
       set status='archived',archived_at=clock_timestamp() where id=$1`,
      [accountId],
    );
    await db().admin.query(
      `update ledger.suppliers
       set status='archived',archived_at=clock_timestamp() where id=$1`,
      [supplierIds.sources],
    );
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

  it('derives unpaid, partial, paid, multi-payment, and multi-Invoice state exactly', async () => {
    const view = await financial(supplierIds.invoiceStates);
    const byId = new Map(view.invoices.map((invoice) => [invoice.id, invoice]));
    expect(byId.get(invoices.unpaid.id)).toMatchObject({
      totalMinor: '500',
      paidAmountMinor: '0',
      outstandingMinor: '500',
      settlementState: 'UNPAID',
    });
    expect(byId.get(invoices.partial.id)).toMatchObject({
      totalMinor: '500',
      paidAmountMinor: '200',
      outstandingMinor: '300',
      settlementState: 'PARTIALLY_PAID',
    });
    expect(byId.get(invoices.paid.id)).toMatchObject({
      totalMinor: '300',
      paidAmountMinor: '300',
      outstandingMinor: '0',
      settlementState: 'PAID',
    });
    expect(view.totalOutstandingMinor).toBe('800');

    const detail = await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/invoices/${invoices.partial.id}`,
    ).expect(200);
    expect((detail.body as SupplierInvoiceDetailResponse).invoice).toMatchObject({
      paidAmountMinor: '200',
      outstandingMinor: '300',
      settlementState: 'PARTIALLY_PAID',
    });
  });

  it('derives unpaid, partial, and fully paid Opening Payable state from allocations', async () => {
    const unpaid = await financial(supplierIds.openingUnpaid);
    expect(unpaid.openingPayable).toMatchObject({
      id: openings.unpaid.id,
      amountMinor: '1200',
      paidAmountMinor: '0',
      outstandingMinor: '1200',
      settlementState: 'UNPAID',
    });

    const partial = await financial(supplierIds.openingPartial);
    expect(partial.openingPayable).toMatchObject({
      id: openings.partial.id,
      amountMinor: '1200',
      paidAmountMinor: '500',
      outstandingMinor: '700',
      settlementState: 'PARTIALLY_PAID',
    });
    expect(partial.totalOutstandingMinor).toBe('1000');

    const paid = await financial(supplierIds.openingPaid);
    expect(paid.openingPayable).toMatchObject({
      id: openings.paid.id,
      amountMinor: '1200',
      paidAmountMinor: '1200',
      outstandingMinor: '0',
      settlementState: 'PAID',
    });
    expect(paid.totalOutstandingMinor).toBe('0');
  });

  it('lists payments newest-first with stable keyset pagination and target history', async () => {
    const firstResponse = await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments`,
    )
      .query({ limit: 1 })
      .expect(200);
    const first = firstResponse.body as SupplierPaymentListResponse;
    expect(first.payments.map((payment) => payment.id)).toEqual([payments.partialSecond]);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments`,
    )
      .query({ limit: 1, cursor: first.nextCursor })
      .expect(200);
    const second = secondResponse.body as SupplierPaymentListResponse;
    expect(second.payments.map((payment) => payment.id)).toEqual([payments.multiInvoice]);
    expect(second.nextCursor).toBeNull();

    const invoiceHistory = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments`,
    )
      .query({ invoiceId: invoices.partial.id })
      .expect(200)) as { body: SupplierPaymentListResponse };
    expect(invoiceHistory.body.payments.map((payment) => payment.id)).toEqual([
      payments.partialSecond,
      payments.multiInvoice,
    ]);
    expect(invoiceHistory.body.payments.map((payment) => payment.targetAllocationMinor)).toEqual([
      '100',
      '100',
    ]);

    const openingHistory = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.openingPartial}/payments`,
    )
      .query({ openingPayableId: openings.partial.id })
      .expect(200)) as { body: SupplierPaymentListResponse };
    expect(openingHistory.body.payments.map((payment) => payment.id)).toEqual([
      payments.openingPartialSecond,
      payments.openingPartialFirst,
    ]);
    expect(openingHistory.body.payments.map((payment) => payment.targetAllocationMinor)).toEqual([
      '300',
      '200',
    ]);

    await authorizedGet(ownerA, `/v1/suppliers/${supplierIds.invoiceStates}/payments`)
      .query({ cursor: first.nextCursor, invoiceId: invoices.partial.id })
      .expect(400);
    await authorizedGet(ownerA, `/v1/suppliers/${supplierIds.invoiceStates}/payments`)
      .query({ invoiceId: invoices.partial.id, openingPayableId: openings.partial.id })
      .expect(400);
  });

  it('returns payment detail with exact account, owner, Invoice, and Opening targets', async () => {
    const accountDetail = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.sources}/payments/${payments.moneyAccount}`,
    ).expect(200)) as { body: SupplierPaymentDetailResponse };
    expect(accountDetail.body.supplier.status).toBe('archived');
    expect(accountDetail.body.payment).toMatchObject({
      amountMinor: '200',
      allocatedTotalMinor: '200',
      creditCreatedMinor: '0',
      source: {
        type: 'MONEY_ACCOUNT',
        moneyAccount: { id: accountId, name: 'S13.4 Cash', status: 'archived' },
      },
    });
    expect(accountDetail.body.allocations[0]).toMatchObject({
      amountMinor: '200',
      target: { type: 'SUPPLIER_INVOICE', id: invoices.source.id },
    });

    const ownerDetail = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.sources}/payments/${payments.ownerFunded}`,
    ).expect(200)) as { body: SupplierPaymentDetailResponse };
    expect(ownerDetail.body.payment.source).toEqual({ type: 'OWNER', moneyAccount: null });

    const openingDetail = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.openingPaid}/payments/${payments.openingPaidFirst}`,
    ).expect(200)) as { body: SupplierPaymentDetailResponse };
    expect(openingDetail.body.allocations[0]).toMatchObject({
      amountMinor: '200',
      target: {
        type: 'OPENING_PAYABLE',
        id: openings.paid.id,
        amountMinor: '1200',
      },
    });
  });

  it('preserves bigint precision and explicit zero in financial and payment reads', async () => {
    const view = await financial(supplierIds.bigint);
    expect(view.invoices[0]).toMatchObject({
      totalMinor: '9007199254740993',
      paidAmountMinor: '9007199254740993',
      outstandingMinor: '0',
      settlementState: 'PAID',
    });
    expect(view.totalOutstandingMinor).toBe('0');
    const detail = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.bigint}/payments/${payments.bigint}`,
    ).expect(200)) as { body: SupplierPaymentDetailResponse };
    expect(detail.body.payment).toMatchObject({
      amountMinor: '9007199254740993',
      creditCreatedMinor: '0',
    });
  });

  it('fails closed across Stores and without tenant context', async () => {
    const absentSupplier = await authorizedGet(
      ownerA,
      `/v1/suppliers/${randomUUID()}/payments`,
    ).expect(404);
    const foreignSupplier = await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.foreign}/payments`,
    ).expect(404);
    const foreignSupplierBody = foreignSupplier.body as { code: unknown };
    const absentSupplierBody = absentSupplier.body as { code: unknown };
    expect(foreignSupplierBody.code).toBe(absentSupplierBody.code);

    const absentPayment = await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments/${randomUUID()}`,
    ).expect(404);
    const foreignPayment = await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments/${payments.foreign}`,
    ).expect(404);
    const foreignPaymentBody = foreignPayment.body as { code: unknown };
    const absentPaymentBody = absentPayment.body as { code: unknown };
    expect(foreignPaymentBody.code).toBe(absentPaymentBody.code);

    const foreignInvoiceFilter = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments`,
    )
      .query({ invoiceId: invoices.foreign.id })
      .expect(200)) as { body: SupplierPaymentListResponse };
    expect(foreignInvoiceFilter.body.payments).toEqual([]);
    const foreignOpeningFilter = (await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments`,
    )
      .query({ openingPayableId: openings.foreign.id })
      .expect(200)) as { body: SupplierPaymentListResponse };
    expect(foreignOpeningFilter.body.payments).toEqual([]);

    if (!runtimePool) throw new Error('S13.4 runtime pool is unavailable.');
    const hidden = await runtimePool.query<{ payments: number; allocations: number }>(
      `select
        (select count(*)::integer from ledger.supplier_payments) as payments,
        (select count(*)::integer from ledger.supplier_payment_allocations) as allocations`,
    );
    expect(hidden.rows[0]).toEqual({ payments: 0, allocations: 0 });
  });

  it('performs no business, period, idempotency, sync, or audit writes while reading', async () => {
    const before = await effectCounts();
    await financial(supplierIds.invoiceStates);
    await authorizedGet(ownerA, `/v1/suppliers/${supplierIds.invoiceStates}/payments`).expect(200);
    await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.invoiceStates}/payments/${payments.multiInvoice}`,
    ).expect(200);
    expect(await effectCounts()).toEqual(before);
  });

  it('preserves the S12 active-allocation correction guard', async () => {
    await request(server)
      .post(`/v1/suppliers/invoices/${invoices.partial.operationId}/cancel`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({ operationId: randomUUID(), occurredAt: instant })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS' }),
      );
    const view = await financial(supplierIds.invoiceStates);
    expect(view.invoices.find((invoice) => invoice.id === invoices.partial.id)).toMatchObject({
      paidAmountMinor: '200',
      outstandingMinor: '300',
      settlementState: 'PARTIALLY_PAID',
    });
  });

  it('allows historical owner reads when the Store becomes read-only', async () => {
    await db().admin.query(`update ledger.stores set status='read_only' where id=$1`, [
      ownerA.storeId,
    ]);
    await authorizedGet(ownerA, `/v1/suppliers/${supplierIds.sources}/payments`).expect(200);
    await authorizedGet(
      ownerA,
      `/v1/suppliers/${supplierIds.sources}/payments/${payments.ownerFunded}`,
    ).expect(200);
  });
});
