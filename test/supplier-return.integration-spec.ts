import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger, PARAMS_PROVIDER_TOKEN } from 'nestjs-pino';
import type { Pool } from 'pg';
import request, { type Response } from 'supertest';

import { deriveAccountingPeriodId } from '../src/accounting-periods/accounting-period-identity';
import { resolveAccountingPeriodBoundaries } from '../src/accounting-periods/accounting-period-month';
import { AUTH_DATABASE_POOL } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { configureApplication } from '../src/bootstrap';
import { createLoggingParams } from '../src/common/logging/logging.module';
import { AppConfigService } from '../src/config/app-config.service';
import { DATABASE_POOL } from '../src/database/database.constants';
import type { SupplierInvoicePostingResponse } from '../src/suppliers/supplier-invoice-posting.types';
import { parseStoredSupplierFinancialPostingResponse } from '../src/suppliers/supplier-return-response';
import type { SupplierReturnPostingResponse } from '../src/suppliers/supplier-return.types';
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

interface InvoiceFixture {
  operationId: string;
  response: SupplierInvoicePostingResponse;
}

const identities: [Identity, Identity, Identity] = [
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s176-owner-${randomUUID()}@example.test`,
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s176-foreign-${randomUUID()}@example.test`,
    storeStatus: 'active',
    token: '',
  },
  {
    storeId: randomUUID(),
    userId: randomUUID(),
    deviceId: randomUUID(),
    email: `s176-read-only-${randomUUID()}@example.test`,
    storeStatus: 'read_only',
    token: '',
  },
];
const [owner, foreignOwner, readOnlyOwner] = identities;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseBody(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) throw new Error('Expected an object response body.');
  return response.body;
}

function supplierReturnBody(response: Response): SupplierReturnPostingResponse {
  const body = parseStoredSupplierFinancialPostingResponse(response.body as unknown);
  if (body.family !== 'supplier_return') {
    throw new Error('Expected a Supplier Return response body.');
  }
  return body;
}

describe('S17.6 Supplier financial Returns and Credit lifecycle on isolated PostgreSQL', () => {
  jest.setTimeout(300_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;
  let occurredAt: string;
  let previousOccurredAt: string;
  let currentPeriodId: string;
  let previousPeriodId: string;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S17.6 database is unavailable.');
    return database;
  }

  function authorized(identity: Identity = owner): { authorization: string } {
    return { authorization: `Bearer ${identity.token}` };
  }

  async function createSupplier(
    identity: Identity = owner,
    status: 'active' | 'archived' = 'active',
  ): Promise<string> {
    const id = randomUUID();
    await db().admin.query(
      `insert into ledger.suppliers(
         id,store_id,name,normalized_name,phone,normalized_phone,status,archived_at,
         device_id,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,$1::uuid::text,$1::uuid::text,$3,
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
         id,store_id,name,normalized_name,account_type,availability,status,archived_at,operation_id)
       values($1,$2,$1::uuid::text,$1::uuid::text,'transfer','available',$3,
         case when $3='archived' then clock_timestamp() else null end,$4)`,
      [id, identity.storeId, status, randomUUID()],
    );
    return id;
  }

  async function postInvoice(
    supplierId: string,
    amountMinor: string,
    identity: Identity = owner,
    at = occurredAt,
    operationId = randomUUID(),
  ): Promise<InvoiceFixture> {
    const result = await request(server)
      .post(`/v1/suppliers/${supplierId}/invoices`)
      .set(authorized(identity))
      .send({
        operationId,
        occurredAt: at,
        items: [
          {
            description: 'S17.6 Supplier financial Return fixture',
            unitName: 'piece',
            quantityMilli: '1000',
            unitCostMinor: amountMinor,
            lineTotalMinor: amountMinor,
          },
        ],
        totalMinor: amountMinor,
      })
      .expect(201);
    return { operationId, response: result.body as SupplierInvoicePostingResponse };
  }

  async function payInvoice(
    supplierId: string,
    invoiceId: string,
    amountMinor: string,
    accountId: string,
    operationId = randomUUID(),
  ): Promise<void> {
    await request(server)
      .post(`/v1/suppliers/${supplierId}/payments`)
      .set(authorized())
      .send({
        operationId,
        paymentSource: 'money_account',
        moneyAccountId: accountId,
        amountMinor,
        occurredAt,
        externalReference: 'S17.6 historical payment',
        notes: null,
        allocations: [{ targetType: 'purchase_invoice', targetId: invoiceId, amountMinor }],
      })
      .expect(201);
  }

  function postReturn(
    supplierId: string,
    invoiceId: string,
    amountMinor: string,
    operationId = randomUUID(),
    identity: Identity = owner,
    at = occurredAt,
  ): request.Test {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/financial-returns`)
      .set(authorized(identity))
      .send({
        operationId,
        purchaseInvoiceId: invoiceId,
        amountMinor,
        occurredAt: at,
        reason: 'Supplier accepted the financial Return',
      });
  }

  function applyCredit(
    supplierId: string,
    invoiceId: string,
    amountMinor: string,
    operationId = randomUUID(),
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/credit-applications`)
      .set(authorized(identity))
      .send({
        operationId,
        purchaseInvoiceId: invoiceId,
        amountMinor,
        occurredAt,
        notes: 'Explicit Supplier Credit application',
      });
  }

  function refundCredit(
    supplierId: string,
    accountId: string,
    amountMinor: string,
    operationId = randomUUID(),
    identity: Identity = owner,
  ): request.Test {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/refunds`)
      .set(authorized(identity))
      .send({
        operationId,
        moneyAccountId: accountId,
        amountMinor,
        occurredAt,
        notes: 'Actual Supplier money Refund',
      });
  }

  function correct(
    family: 'financial-returns' | 'credit-applications' | 'refunds',
    kind: 'cancel' | 'replace',
    targetOperationId: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(server)
      .post(`/v1/suppliers/${family}/${targetOperationId}/${kind}`)
      .set(authorized())
      .send(body);
  }

  function correctionBody(
    replacement?: Record<string, unknown>,
    operationId = randomUUID(),
  ): Record<string, unknown> {
    return {
      operationId,
      occurredAt,
      reason: 'Correct the posted Supplier financial operation',
      ...(replacement ? { replacement } : {}),
    };
  }

  async function supplierBalances(
    supplierId: string,
  ): Promise<{ payable: string; credit: string }> {
    const result = await db().admin.query<{ payable: string; credit: string }>(
      `select coalesce(sum(payable_delta_minor),0)::text as payable,
              coalesce(sum(credit_delta_minor),0)::text as credit
       from ledger.supplier_ledger_entries where store_id=$1 and supplier_id=$2`,
      [owner.storeId, supplierId],
    );
    return result.rows[0] ?? { payable: '0', credit: '0' };
  }

  async function invoiceOutstanding(invoiceId: string): Promise<string> {
    const result = await db().admin.query<{ outstanding: string }>(
      `select (
         coalesce((select sum(entry.payable_delta_minor)
                   from ledger.supplier_ledger_entries entry
                   where entry.store_id=invoice.store_id
                     and entry.source_purchase_invoice_id=invoice.id),0)
         - coalesce((select sum(allocation.amount_minor)
                     from ledger.supplier_payment_allocations allocation
                     inner join ledger.supplier_payments payment
                       on payment.store_id=allocation.store_id
                      and payment.id=allocation.supplier_payment_id
                     where allocation.store_id=invoice.store_id
                       and allocation.purchase_invoice_id=invoice.id
                       and payment.status='posted'),0)
       )::text as outstanding
       from ledger.purchase_invoices invoice where invoice.store_id=$1 and invoice.id=$2`,
      [owner.storeId, invoiceId],
    );
    return result.rows[0]?.outstanding ?? 'missing';
  }

  async function accountBalance(accountId: string): Promise<string> {
    const result = await db().admin.query<{ balance: string }>(
      `select coalesce(sum(amount_delta_minor),0)::text as balance
       from ledger.money_movements where store_id=$1 and account_id=$2`,
      [owner.storeId, accountId],
    );
    return result.rows[0]?.balance ?? '0';
  }

  async function supplierVersion(supplierId: string): Promise<string> {
    const result = await db().admin.query<{ version: string }>(
      `select version::text as version from ledger.suppliers where store_id=$1 and id=$2`,
      [owner.storeId, supplierId],
    );
    const version = result.rows[0]?.version;
    if (!version) throw new Error('Supplier fixture is missing.');
    return version;
  }

  function archiveSupplier(supplierId: string): request.Test {
    return request(server)
      .post(`/v1/suppliers/${supplierId}/archive`)
      .set(authorized())
      .send({ operationId: randomUUID(), expectedVersion: '1' });
  }

  async function createCredit(
    amountMinor: string,
  ): Promise<{ supplierId: string; invoice: InvoiceFixture; returnOperationId: string }> {
    const supplierId = await createSupplier();
    const accountId = await createAccount();
    const invoice = await postInvoice(supplierId, amountMinor);
    await payInvoice(supplierId, invoice.response.invoice.id, amountMinor, accountId);
    const returnOperationId = randomUUID();
    await postReturn(
      supplierId,
      invoice.response.invoice.id,
      amountMinor,
      returnOperationId,
    ).expect(201);
    return { supplierId, invoice, returnOperationId };
  }

  beforeAll(async () => {
    let setupStage = 'read test environment';
    try {
      const environment = readLocalPostgresTestEnvironment();
      if (!environment) throw new Error('Approved non-production local test environment required.');
      database = await createInventoryTestDatabase(migrationFilename);
      setupStage = 'apply latest migration';
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
      const previousMonth = month === 1 ? 12 : month - 1;
      const previousYear = month === 1 ? year - 1 : year;
      const currentBoundaries = resolveAccountingPeriodBoundaries(year, month);
      const previousBoundaries = resolveAccountingPeriodBoundaries(previousYear, previousMonth);
      previousOccurredAt = new Date(
        previousBoundaries.startsAt.getTime() + 43_200_000,
      ).toISOString();

      setupStage = 'seed stores and periods';
      for (const identity of identities) {
        await db().admin.query(
          `insert into ledger.stores(id,name,status) values($1,'S17.6 fixture',$2)`,
          [identity.storeId, identity.storeStatus],
        );
        await db().admin.query(`insert into ledger.app_settings(store_id) values($1)`, [
          identity.storeId,
        ]);
        const currentId = deriveAccountingPeriodId(identity.storeId, year, month);
        const previousId = deriveAccountingPeriodId(identity.storeId, previousYear, previousMonth);
        for (const period of [
          { id: previousId, year: previousYear, month: previousMonth, ...previousBoundaries },
          { id: currentId, year, month, ...currentBoundaries },
        ]) {
          await db().admin.query(
            `insert into ledger.accounting_periods(
             id,store_id,period_year,period_month,starts_at,ends_at,status,operation_id)
           values($1,$2,$3,$4,$5,$6,'open',$7)`,
            [
              period.id,
              identity.storeId,
              period.year,
              period.month,
              period.startsAt,
              period.endsAt,
              randomUUID(),
            ],
          );
        }
        if (identity === owner) {
          currentPeriodId = currentId;
          previousPeriodId = previousId;
        }
      }

      const password = randomUUID();
      const passwordHash = await new PasswordService().hash(password);
      setupStage = 'seed identities';
      for (const identity of identities) {
        await db().admin.query(
          `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S17.6 fixture')`,
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
        throw new Error('S17.6 integration database is not isolated.');
      }
      const databaseUrl = (source: string): string => {
        const parsed = new URL(source);
        parsed.pathname = `/${databaseName}`;
        return parsed.toString();
      };
      runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s176-runtime', 20);
      authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s176-auth', 4);

      setupStage = 'compile Nest application';
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

      setupStage = 'authenticate fixtures';
      for (const identity of identities) {
        const login = await request(server)
          .post('/v1/auth/login')
          .send({
            email: identity.email,
            password,
            storeId: identity.storeId,
            deviceId: identity.deviceId,
            deviceName: 'S17.6 isolated',
            devicePlatform: 'android',
          })
          .expect(200);
        const token = (login.body as { accessToken?: unknown }).accessToken;
        if (typeof token !== 'string') throw new Error('S17.6 login token is missing.');
        identity.token = token;
      }
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
          : JSON.stringify(error);
      throw new Error(`S17.6 setup failed during ${setupStage}: ${detail}`);
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

  it('posts an unpaid-Invoice Return payable-first while preserving Invoice and inventory history', async () => {
    const supplierId = await createSupplier();
    const invoice = await postInvoice(supplierId, '1000');
    const before = await db().admin.query<{ movements: number; balances: number }>(
      `select
        (select count(*)::int from ledger.inventory_movements where store_id=$1) as movements,
        (select count(*)::int from ledger.stock_balances where store_id=$1) as balances`,
      [owner.storeId],
    );
    const result = await postReturn(supplierId, invoice.response.invoice.id, '300').expect(201);
    expect(result.body).toMatchObject({
      family: 'supplier_return',
      return: {
        purchaseInvoiceId: invoice.response.invoice.id,
        amountMinor: '300',
        payableReductionMinor: '300',
        supplierCreditCreatedMinor: '0',
      },
      inventoryEffectMinor: '0',
    });
    expect(await invoiceOutstanding(invoice.response.invoice.id)).toBe('700');
    expect(await supplierBalances(supplierId)).toEqual({ payable: '700', credit: '0' });
    const invoiceState = await db().admin.query<{ total: string; status: string; items: number }>(
      `select invoice.total_minor::text as total,invoice.status,
              (select count(*)::int from ledger.purchase_items item
               where item.purchase_invoice_id=invoice.id) as items
       from ledger.purchase_invoices invoice where invoice.id=$1`,
      [invoice.response.invoice.id],
    );
    expect(invoiceState.rows[0]).toEqual({ total: '1000', status: 'open', items: 1 });
    const after = await db().admin.query<{ movements: number; balances: number }>(
      `select
        (select count(*)::int from ledger.inventory_movements where store_id=$1) as movements,
        (select count(*)::int from ledger.stock_balances where store_id=$1) as balances`,
      [owner.storeId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const read = await request(server)
      .get(`/v1/suppliers/${supplierId}/return-financials`)
      .set(authorized())
      .expect(200);
    expect(read.body).toMatchObject({
      balances: { payableMinor: '700', supplierCreditAvailableMinor: '0' },
      returns: [{ id: supplierReturnBody(result).return.id, inventoryEffectMinor: '0' }],
    });
  });

  it('preserves historical payments and creates distinct Credit only above remaining Payable', async () => {
    const supplierId = await createSupplier();
    const accountId = await createAccount();
    const partial = await postInvoice(supplierId, '1000');
    await payInvoice(supplierId, partial.response.invoice.id, '700', accountId);
    const returned = await postReturn(supplierId, partial.response.invoice.id, '500').expect(201);
    expect(returned.body).toMatchObject({
      return: { payableReductionMinor: '300', supplierCreditCreatedMinor: '200' },
    });
    expect(await invoiceOutstanding(partial.response.invoice.id)).toBe('0');

    const paid = await postInvoice(supplierId, '250');
    await payInvoice(supplierId, paid.response.invoice.id, '250', accountId);
    const fullyPaidReturn = await postReturn(supplierId, paid.response.invoice.id, '250').expect(
      201,
    );
    expect(fullyPaidReturn.body).toMatchObject({
      return: { payableReductionMinor: '0', supplierCreditCreatedMinor: '250' },
    });
    expect(await supplierBalances(supplierId)).toEqual({ payable: '0', credit: '450' });
    const paymentCount = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.supplier_payments
       where store_id=$1 and supplier_id=$2 and status='posted'`,
      [owner.storeId, supplierId],
    );
    expect(paymentCount.rows[0]).toEqual({ count: 2 });
  });

  it('bounds multiple Returns and provides exact replay with deterministic changed-payload conflict', async () => {
    const supplierId = await createSupplier();
    const invoice = await postInvoice(supplierId, '1000');
    const operationId = randomUUID();
    const first = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '600',
      operationId,
    ).expect(201);
    const replay = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '600',
      operationId,
    ).expect(201);
    expect(replay.body).toEqual(first.body);
    await postReturn(supplierId, invoice.response.invoice.id, '400').expect(201);
    const overOperationId = randomUUID();
    const over = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '1',
      overOperationId,
    ).expect(409);
    expect(over.body).toMatchObject({ code: 'SUPPLIER_RETURN_EXCEEDS_CREDITABLE_VALUE' });
    const rejectedReplay = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '1',
      overOperationId,
    ).expect(409);
    const originalRejection = responseBody(over);
    expect(responseBody(rejectedReplay)).toMatchObject({
      statusCode: originalRejection.statusCode,
      code: originalRejection.code,
      message: originalRejection.message,
      path: originalRejection.path,
    });
    const changed = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '601',
      operationId,
    ).expect(409);
    expect(changed.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    const roots = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.supplier_returns
       where store_id=$1 and purchase_invoice_id=$2 and status='posted'`,
      [owner.storeId, invoice.response.invoice.id],
    );
    expect(roots.rows[0]).toEqual({ count: 2 });
  });

  it('applies Supplier Credit partially and repeatedly without Money or cross-Supplier leakage', async () => {
    const source = await createCredit('500');
    const target = await postInvoice(source.supplierId, '500');
    const beforeMoney = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.money_movements where store_id=$1`,
      [owner.storeId],
    );
    const applicationOperationId = randomUUID();
    const application = await applyCredit(
      source.supplierId,
      target.response.invoice.id,
      '200',
      applicationOperationId,
    ).expect(201);
    const applicationReplay = await applyCredit(
      source.supplierId,
      target.response.invoice.id,
      '200',
      applicationOperationId,
    ).expect(201);
    expect(applicationReplay.body).toEqual(application.body);
    const applicationConflict = await applyCredit(
      source.supplierId,
      target.response.invoice.id,
      '201',
      applicationOperationId,
    ).expect(409);
    expect(applicationConflict.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    await applyCredit(source.supplierId, target.response.invoice.id, '100').expect(201);
    expect(await invoiceOutstanding(target.response.invoice.id)).toBe('200');
    expect(await supplierBalances(source.supplierId)).toEqual({ payable: '200', credit: '200' });

    const tooLarge = await applyCredit(source.supplierId, target.response.invoice.id, '201').expect(
      409,
    );
    expect(tooLarge.body).toMatchObject({ code: 'SUPPLIER_CREDIT_INSUFFICIENT' });
    const smallTarget = await postInvoice(source.supplierId, '100');
    const aboveOutstanding = await applyCredit(
      source.supplierId,
      smallTarget.response.invoice.id,
      '101',
    ).expect(409);
    expect(aboveOutstanding.body).toMatchObject({
      code: 'SUPPLIER_CREDIT_APPLICATION_EXCEEDS_OUTSTANDING',
    });
    const otherSupplier = await createSupplier();
    const otherInvoice = await postInvoice(otherSupplier, '100');
    const mismatch = await applyCredit(
      source.supplierId,
      otherInvoice.response.invoice.id,
      '50',
    ).expect(409);
    expect(mismatch.body).toMatchObject({ code: 'SUPPLIER_INVOICE_SUPPLIER_MISMATCH' });
    const afterMoney = await db().admin.query<{ count: number }>(
      `select count(*)::int as count from ledger.money_movements where store_id=$1`,
      [owner.storeId],
    );
    expect(afterMoney.rows[0]).toEqual(beforeMoney.rows[0]);
  });

  it('records partial and full Supplier Refunds as exact Money inflows without Revenue or Expense', async () => {
    const source = await createCredit('300');
    const accountId = await createAccount();
    const archivedAccountId = await createAccount(owner, 'archived');
    const before = await db().admin.query<{ sales: number; expenses: number }>(
      `select
        (select count(*)::int from ledger.sales where store_id=$1) as sales,
        (select count(*)::int from ledger.expenses where store_id=$1) as expenses`,
      [owner.storeId],
    );
    const operationId = randomUUID();
    const partial = await refundCredit(source.supplierId, accountId, '100', operationId).expect(
      201,
    );
    const replay = await refundCredit(source.supplierId, accountId, '100', operationId).expect(201);
    expect(replay.body).toEqual(partial.body);
    const refundConflict = await refundCredit(
      source.supplierId,
      accountId,
      '101',
      operationId,
    ).expect(409);
    expect(refundConflict.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    await refundCredit(source.supplierId, accountId, '200').expect(201);
    expect(await accountBalance(accountId)).toBe('300');
    expect(await supplierBalances(source.supplierId)).toEqual({ payable: '0', credit: '0' });
    const excess = await refundCredit(source.supplierId, accountId, '1').expect(409);
    expect(excess.body).toMatchObject({ code: 'SUPPLIER_CREDIT_INSUFFICIENT' });
    const unavailable = await refundCredit(
      (await createCredit('10')).supplierId,
      archivedAccountId,
      '10',
    ).expect(409);
    expect(unavailable.body).toMatchObject({ code: 'MONEY_ACCOUNT_UNAVAILABLE' });
    const after = await db().admin.query<{ sales: number; expenses: number }>(
      `select
        (select count(*)::int from ledger.sales where store_id=$1) as sales,
        (select count(*)::int from ledger.expenses where store_id=$1) as expenses`,
      [owner.storeId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('enforces Supplier archive balances, active Supplier writes, and read_only rejection', async () => {
    const payableSupplier = await createSupplier();
    await postInvoice(payableSupplier, '100');
    const payableArchive = await archiveSupplier(payableSupplier).expect(409);
    expect(payableArchive.body).toMatchObject({
      code: 'SUPPLIER_FINANCIAL_BALANCE_OUTSTANDING',
    });

    const creditSource = await createCredit('100');
    const creditArchive = await archiveSupplier(creditSource.supplierId).expect(409);
    expect(creditArchive.body).toMatchObject({
      code: 'SUPPLIER_FINANCIAL_BALANCE_OUTSTANDING',
    });

    const settledSupplier = await createSupplier();
    const accountId = await createAccount();
    const invoice = await postInvoice(settledSupplier, '100');
    await payInvoice(settledSupplier, invoice.response.invoice.id, '100', accountId);
    const version = await supplierVersion(settledSupplier);
    await request(server)
      .post(`/v1/suppliers/${settledSupplier}/archive`)
      .set(authorized())
      .send({ operationId: randomUUID(), expectedVersion: version })
      .expect(200);
    const archivedWrite = await postReturn(
      settledSupplier,
      invoice.response.invoice.id,
      '10',
    ).expect(409);
    expect(archivedWrite.body).toMatchObject({ code: 'SUPPLIER_INACTIVE' });

    const readOnlySupplier = await createSupplier(readOnlyOwner);
    const readOnlyWrite = await postReturn(
      readOnlySupplier,
      randomUUID(),
      '10',
      randomUUID(),
      readOnlyOwner,
    ).expect(403);
    expect(readOnlyWrite.body).toMatchObject({ code: 'BUSINESS_WRITE_NOT_ALLOWED' });
  });

  it('cancels and replaces Supplier Returns immutably while preserving original replay and rollback', async () => {
    const supplierId = await createSupplier();
    const accountId = await createAccount();
    const invoice = await postInvoice(supplierId, '1000');
    await payInvoice(supplierId, invoice.response.invoice.id, '700', accountId);
    const originalOperationId = randomUUID();
    const originalRequest = postReturn(
      supplierId,
      invoice.response.invoice.id,
      '500',
      originalOperationId,
    );
    const original = await originalRequest.expect(201);
    const cancelBody = correctionBody();
    const cancel = await correct(
      'financial-returns',
      'cancel',
      originalOperationId,
      cancelBody,
    ).expect(201);
    const cancelReplay = await correct(
      'financial-returns',
      'cancel',
      originalOperationId,
      cancelBody,
    ).expect(201);
    expect(cancelReplay.body).toEqual(cancel.body);
    const cancelConflict = await correct('financial-returns', 'cancel', originalOperationId, {
      ...cancelBody,
      reason: 'Changed Supplier Return correction',
    }).expect(409);
    expect(cancelConflict.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    expect(cancel.body).toMatchObject({
      family: 'supplier_return',
      intent: 'cancel',
      target: { id: supplierReturnBody(original).return.id, status: 'cancelled' },
    });
    expect(await supplierBalances(supplierId)).toEqual({ payable: '300', credit: '0' });
    const originalReplay = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '500',
      originalOperationId,
    ).expect(201);
    expect(originalReplay.body).toEqual(original.body);
    await correct('financial-returns', 'cancel', originalOperationId, correctionBody()).expect(409);

    const replaceTargetOperationId = randomUUID();
    const replaceTarget = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '200',
      replaceTargetOperationId,
    ).expect(201);
    const replacement = await correct(
      'financial-returns',
      'replace',
      replaceTargetOperationId,
      correctionBody({ amountMinor: '250', reason: 'Correct replacement value' }),
    ).expect(201);
    expect(replacement.body).toMatchObject({
      intent: 'replace',
      target: { id: supplierReturnBody(replaceTarget).return.id, status: 'cancelled' },
      replacement: { family: 'supplier_return', return: { amountMinor: '250' } },
    });

    const activeOperationId = randomUUID();
    const active = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '50',
      activeOperationId,
    ).expect(201);
    await correct(
      'financial-returns',
      'replace',
      activeOperationId,
      correctionBody({ amountMinor: '751', reason: 'Invalid replacement' }),
    ).expect(409);
    const state = await db().admin.query<{ status: string }>(
      `select status from ledger.supplier_returns where id=$1`,
      [supplierReturnBody(active).return.id],
    );
    expect(state.rows[0]).toEqual({ status: 'posted' });
  });

  it('blocks originating Return correction after its Supplier Credit has been consumed', async () => {
    const source = await createCredit('200');
    const refundAccount = await createAccount();
    await refundCredit(source.supplierId, refundAccount, '150').expect(201);
    const response = await correct(
      'financial-returns',
      'cancel',
      source.returnOperationId,
      correctionBody(),
    ).expect(409);
    expect(response.body).toMatchObject({ code: 'SUPPLIER_RETURN_CREDIT_DEPENDENCY' });
    expect(await supplierBalances(source.supplierId)).toEqual({ payable: '0', credit: '50' });
    expect(await accountBalance(refundAccount)).toBe('150');
  });

  it('cancels and replaces Credit Applications without branching or partial replacement', async () => {
    const source = await createCredit('400');
    const target = await postInvoice(source.supplierId, '500');
    const firstOperationId = randomUUID();
    await applyCredit(
      source.supplierId,
      target.response.invoice.id,
      '100',
      firstOperationId,
    ).expect(201);
    const applicationCancelBody = correctionBody();
    const applicationCancel = await correct(
      'credit-applications',
      'cancel',
      firstOperationId,
      applicationCancelBody,
    ).expect(201);
    const applicationCancelReplay = await correct(
      'credit-applications',
      'cancel',
      firstOperationId,
      applicationCancelBody,
    ).expect(201);
    expect(applicationCancelReplay.body).toEqual(applicationCancel.body);
    const applicationCancelConflict = await correct(
      'credit-applications',
      'cancel',
      firstOperationId,
      {
        ...applicationCancelBody,
        reason: 'Changed Supplier Credit Application correction',
      },
    ).expect(409);
    expect(applicationCancelConflict.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    expect(await invoiceOutstanding(target.response.invoice.id)).toBe('500');

    const secondOperationId = randomUUID();
    await applyCredit(
      source.supplierId,
      target.response.invoice.id,
      '100',
      secondOperationId,
    ).expect(201);
    const replaced = await correct(
      'credit-applications',
      'replace',
      secondOperationId,
      correctionBody({
        purchaseInvoiceId: target.response.invoice.id,
        amountMinor: '150',
        notes: 'Corrected application',
      }),
    ).expect(201);
    expect(replaced.body).toMatchObject({
      family: 'supplier_credit_application',
      intent: 'replace',
      replacement: { application: { amountMinor: '150' } },
    });
    expect(await invoiceOutstanding(target.response.invoice.id)).toBe('350');
    await correct('credit-applications', 'cancel', secondOperationId, correctionBody()).expect(409);

    const thirdOperationId = randomUUID();
    await applyCredit(source.supplierId, target.response.invoice.id, '50', thirdOperationId).expect(
      201,
    );
    await correct(
      'credit-applications',
      'replace',
      thirdOperationId,
      correctionBody({
        purchaseInvoiceId: target.response.invoice.id,
        amountMinor: '999',
        notes: null,
      }),
    ).expect(409);
    expect(await invoiceOutstanding(target.response.invoice.id)).toBe('300');
  });

  it('reverses a Refund through its historical archived account and replaces through a current account', async () => {
    const source = await createCredit('400');
    const historicalAccount = await createAccount();
    const currentAccount = await createAccount();
    const refundOperationId = randomUUID();
    await refundCredit(source.supplierId, historicalAccount, '100', refundOperationId).expect(201);
    await db().admin.query(
      `update ledger.money_accounts set status='archived',archived_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, historicalAccount],
    );
    const refundCancelBody = correctionBody();
    const refundCancel = await correct(
      'refunds',
      'cancel',
      refundOperationId,
      refundCancelBody,
    ).expect(201);
    const refundCancelReplay = await correct(
      'refunds',
      'cancel',
      refundOperationId,
      refundCancelBody,
    ).expect(201);
    expect(refundCancelReplay.body).toEqual(refundCancel.body);
    const refundCancelConflict = await correct('refunds', 'cancel', refundOperationId, {
      ...refundCancelBody,
      reason: 'Changed Supplier Refund correction',
    }).expect(409);
    expect(refundCancelConflict.body).toMatchObject({ code: 'OPERATION_ID_CONFLICT' });
    expect(await accountBalance(historicalAccount)).toBe('0');

    const replacementTargetOperationId = randomUUID();
    await refundCredit(
      source.supplierId,
      currentAccount,
      '100',
      replacementTargetOperationId,
    ).expect(201);
    const replacementAccount = await createAccount();
    const replaced = await correct(
      'refunds',
      'replace',
      replacementTargetOperationId,
      correctionBody({ moneyAccountId: replacementAccount, amountMinor: '150', notes: null }),
    ).expect(201);
    expect(replaced.body).toMatchObject({
      family: 'supplier_refund',
      intent: 'replace',
      replacement: { refund: { moneyAccountId: replacementAccount, amountMinor: '150' } },
    });
    expect(await accountBalance(currentAccount)).toBe('0');
    expect(await accountBalance(replacementAccount)).toBe('150');
  });

  it('posts against a historical Invoice whose original period is now closed', async () => {
    const supplierId = await createSupplier();
    const invoice = await postInvoice(supplierId, '200', owner, previousOccurredAt);
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
       where store_id=$1 and id=$2`,
      [owner.storeId, previousPeriodId],
    );
    const result = await postReturn(supplierId, invoice.response.invoice.id, '50').expect(201);
    expect(result.body).toMatchObject({
      posting: { accountingPeriodId: currentPeriodId },
      return: { purchaseInvoiceId: invoice.response.invoice.id },
    });
    const original = await db().admin.query<{ periodId: string }>(
      `select accounting_period_id as "periodId" from ledger.purchase_invoices where id=$1`,
      [invoice.response.invoice.id],
    );
    expect(original.rows[0]).toEqual({ periodId: previousPeriodId });
  });

  it('fails closed across Stores and keeps historical reads available after archive', async () => {
    const supplierId = await createSupplier();
    const invoice = await postInvoice(supplierId, '100');
    const foreign = await postReturn(
      supplierId,
      invoice.response.invoice.id,
      '10',
      randomUUID(),
      foreignOwner,
    );
    expect([404, 409]).toContain(foreign.status);
    const foreignRead = await request(server)
      .get(`/v1/suppliers/${supplierId}/return-financials`)
      .set(authorized(foreignOwner));
    expect(foreignRead.status).toBe(404);

    const settledSupplier = await createSupplier();
    const accountId = await createAccount();
    const settledInvoice = await postInvoice(settledSupplier, '100');
    await payInvoice(settledSupplier, settledInvoice.response.invoice.id, '100', accountId);
    await request(server)
      .post(`/v1/suppliers/${settledSupplier}/archive`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        expectedVersion: await supplierVersion(settledSupplier),
      })
      .expect(200);
    const read = await request(server)
      .get(`/v1/suppliers/${settledSupplier}/return-financials`)
      .set(authorized())
      .expect(200);
    expect(read.body).toMatchObject({ supplier: { id: settledSupplier, status: 'archived' } });
  });

  describe('focused concurrency', () => {
    it('serializes Return vs Return and same-operation replay', async () => {
      const supplierId = await createSupplier();
      const invoice = await postInvoice(supplierId, '500');
      const concurrent = await Promise.all([
        postReturn(supplierId, invoice.response.invoice.id, '400'),
        postReturn(supplierId, invoice.response.invoice.id, '400'),
      ]);
      expect(concurrent.map((result) => result.status).sort()).toEqual([201, 409]);
      const sameOperationId = randomUUID();
      const same = await Promise.all([
        postReturn(supplierId, invoice.response.invoice.id, '100', sameOperationId),
        postReturn(supplierId, invoice.response.invoice.id, '100', sameOperationId),
      ]);
      expect(same.map((result) => result.status)).toEqual([201, 201]);
      expect(responseBody(same[0])).toEqual(responseBody(same[1]));
      expect(await invoiceOutstanding(invoice.response.invoice.id)).toBe('0');
    });

    it('serializes Return against Supplier Payment and Invoice correction', async () => {
      const supplierId = await createSupplier();
      const accountId = await createAccount();
      const invoice = await postInvoice(supplierId, '500');
      const paymentOperationId = randomUUID();
      const payment = request(server)
        .post(`/v1/suppliers/${supplierId}/payments`)
        .set(authorized())
        .send({
          operationId: paymentOperationId,
          paymentSource: 'money_account',
          moneyAccountId: accountId,
          amountMinor: '400',
          occurredAt,
          externalReference: null,
          notes: null,
          allocations: [
            {
              targetType: 'purchase_invoice',
              targetId: invoice.response.invoice.id,
              amountMinor: '400',
            },
          ],
        });
      const pair = await Promise.all([
        postReturn(supplierId, invoice.response.invoice.id, '300'),
        payment,
      ]);
      expect(pair.some((result) => result.status === 201)).toBe(true);
      expect(BigInt(await invoiceOutstanding(invoice.response.invoice.id))).toBeGreaterThanOrEqual(
        0n,
      );

      const correctionInvoice = await postInvoice(supplierId, '200');
      const correctionPair = await Promise.all([
        postReturn(supplierId, correctionInvoice.response.invoice.id, '100'),
        request(server)
          .post(`/v1/suppliers/invoices/${correctionInvoice.operationId}/cancel`)
          .set(authorized())
          .send({ operationId: randomUUID(), occurredAt }),
      ]);
      expect(correctionPair.map((result) => result.status).sort()).toEqual([201, 409]);
    });

    it('prevents concurrent Credit Application and Refund double-spend', async () => {
      const applicationSource = await createCredit('200');
      const targetA = await postInvoice(applicationSource.supplierId, '200');
      const targetB = await postInvoice(applicationSource.supplierId, '200');
      const applications = await Promise.all([
        applyCredit(applicationSource.supplierId, targetA.response.invoice.id, '150'),
        applyCredit(applicationSource.supplierId, targetB.response.invoice.id, '150'),
      ]);
      expect(applications.map((result) => result.status).sort()).toEqual([201, 409]);

      const mixedSource = await createCredit('200');
      const mixedTarget = await postInvoice(mixedSource.supplierId, '200');
      const mixedAccount = await createAccount();
      const mixed = await Promise.all([
        applyCredit(mixedSource.supplierId, mixedTarget.response.invoice.id, '150'),
        refundCredit(mixedSource.supplierId, mixedAccount, '150'),
      ]);
      expect(mixed.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(
        BigInt((await supplierBalances(mixedSource.supplierId)).credit),
      ).toBeGreaterThanOrEqual(0n);

      const refundSource = await createCredit('200');
      const refundAccount = await createAccount();
      const refunds = await Promise.all([
        refundCredit(refundSource.supplierId, refundAccount, '150'),
        refundCredit(refundSource.supplierId, refundAccount, '150'),
      ]);
      expect(refunds.map((result) => result.status).sort()).toEqual([201, 409]);
    });

    it('prevents correction branching, Credit dependency races, and account-archive races', async () => {
      const branchSupplier = await createSupplier();
      const branchInvoice = await postInvoice(branchSupplier, '200');
      const targetOperationId = randomUUID();
      await postReturn(
        branchSupplier,
        branchInvoice.response.invoice.id,
        '100',
        targetOperationId,
      ).expect(201);
      const corrections = await Promise.all([
        correct('financial-returns', 'cancel', targetOperationId, correctionBody()),
        correct(
          'financial-returns',
          'replace',
          targetOperationId,
          correctionBody({ amountMinor: '80', reason: 'Concurrent replacement' }),
        ),
      ]);
      expect(corrections.map((result) => result.status).sort()).toEqual([201, 409]);

      const dependencySource = await createCredit('200');
      const dependencyAccount = await createAccount();
      const dependencyRace = await Promise.all([
        correct(
          'financial-returns',
          'cancel',
          dependencySource.returnOperationId,
          correctionBody(),
        ),
        refundCredit(dependencySource.supplierId, dependencyAccount, '150'),
      ]);
      expect(dependencyRace.map((result) => result.status).sort()).toEqual([201, 409]);

      const archiveSource = await createCredit('100');
      const archiveAccount = await createAccount();
      const accountVersion = (
        await db().admin.query<{ version: string }>(
          `select version::text as version from ledger.money_accounts where id=$1`,
          [archiveAccount],
        )
      ).rows[0]?.version;
      if (!accountVersion) throw new Error('Money Account fixture is missing.');
      const archiveRace = await Promise.all([
        refundCredit(archiveSource.supplierId, archiveAccount, '100'),
        request(server)
          .post(`/v1/money-accounts/${archiveAccount}/archive`)
          .set(authorized())
          .send({ operationId: randomUUID(), expectedVersion: accountVersion }),
      ]);
      const archiveStatuses = archiveRace.map((result) => result.status);
      expect(archiveStatuses).toContain(409);
      expect(archiveStatuses.some((status) => status === 200 || status === 201)).toBe(true);
    });
  });
});
