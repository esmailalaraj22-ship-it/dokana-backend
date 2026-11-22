import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { OperationalTimeService } from '../src/settings/operational-time.service';

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
import { DatabaseService } from '../src/database/database.service';
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
import { captureReplayEvidence } from './stage3b-replay-evidence';
import { interceptOperationQueries } from './stage3b-driver-boundary';
import {
  assertSupplierDimensions,
  assertSupplierPaymentFacts,
  assertSupplierReversalFacts,
  supplierBoundaries,
  supplierFinancialTables,
} from './stage4c-financial-evidence';

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
  const body = parseStoredSupplierFinancialPostingResponse(owner.storeId, response.body as unknown);
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
    operationId: string = randomUUID(),
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

  it('S4C2-01 reconciles invoice and opening exposure once while preserving independent Supplier credit', async () => {
    const supplier = await createSupplier();
    const account = await createAccount();
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const invoice = await postInvoice(supplier, '10000');
    const invoiceId = invoice.response.invoice.id;
    const check = async (payable: string, allocated: string, credit = '0') => {
      await assertSupplierDimensions(db().admin, owner.storeId, supplier, payable, credit);
      expect(
        (
          await db().admin.query(
            `select outstanding_minor::text as obligation
        from ledger.v_supplier_invoice_outstanding where store_id=$1 and purchase_invoice_id=$2`,
            [owner.storeId, invoiceId],
          )
        ).rows,
      ).toEqual([{ obligation: '10000' }]);
      expect(
        (
          await db().admin.query(
            `select coalesce(sum(a.amount_minor),0)::text as allocated
        from ledger.supplier_payment_allocations a join ledger.supplier_payments p on p.store_id=a.store_id and p.id=a.supplier_payment_id
        where a.store_id=$1 and a.purchase_invoice_id=$2 and p.status='posted'`,
            [owner.storeId, invoiceId],
          )
        ).rows,
      ).toEqual([{ allocated }]);
      expect(await invoiceOutstanding(invoiceId)).toBe((10000n - BigInt(allocated)).toString());
      const read = await request(server)
        .get(`/v1/suppliers/${supplier}/invoices`)
        .set(authorized())
        .expect(200);
      expect(read.body).toMatchObject({
        totalOutstandingMinor: (BigInt(payable) - BigInt(credit)).toString(),
        invoices: expect.arrayContaining([
          expect.objectContaining({
            id: invoiceId,
            paidAmountMinor: allocated,
            outstandingMinor: (10000n - BigInt(allocated)).toString(),
          }),
        ]) as unknown,
      });
    };
    await check('10000', '0');
    expect(await accountBalance(account)).toBe('0');
    await payInvoice(supplier, invoiceId, '4000', account);
    await check('6000', '4000');
    expect(await accountBalance(account)).toBe('-4000');
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    await payInvoice(supplier, invoiceId, '6000', account);
    await check('0', '10000');
    expect(await accountBalance(account)).toBe('-10000');
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    const beforeOpening = (
      await db().admin.query(
        'select id from ledger.purchase_invoices where store_id=$1 order by id',
        [owner.storeId],
      )
    ).rows;
    const opening = await request(server)
      .post(`/v1/suppliers/${supplier}/opening-payables`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        amountMinor: '3000',
        occurredAt,
      })
      .expect(201);
    const openingId = (opening.body as { payable: { id: string } }).payable.id;
    expect(
      (
        await db().admin.query(
          'select id from ledger.purchase_invoices where store_id=$1 order by id',
          [owner.storeId],
        )
      ).rows,
    ).toEqual(beforeOpening);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '3000', '0');
    await request(server)
      .post(`/v1/suppliers/${supplier}/payments`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        paymentSource: 'money_account',
        moneyAccountId: account,
        amountMinor: '1000',
        occurredAt,
        allocations: [{ targetType: 'opening_payable', targetId: openingId, amountMinor: '1000' }],
      })
      .expect(201);
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    await check('2000', '10000');
    const openingRead = await request(server)
      .get(`/v1/suppliers/${supplier}/invoices`)
      .set(authorized())
      .expect(200);
    expect(openingRead.body).toMatchObject({
      openingPayable: { amountMinor: '3000', paidAmountMinor: '1000', outstandingMinor: '2000' },
    });
    await postReturn(supplier, invoiceId, '2500').expect(201);
    await check('2000', '10000', '2500');
    const creditRead = await request(server)
      .get(`/v1/suppliers/${supplier}/return-financials`)
      .set(authorized())
      .expect(200);
    expect(creditRead.body).toMatchObject({
      balances: { payableMinor: '2000', supplierCreditAvailableMinor: '2500' },
    });
    expect(await accountBalance(account)).toBe('-11000');
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-02 enforces complete exact allocation and rolls back staged funding without a second expense', async () => {
    const supplier = await createSupplier();
    const account = await createAccount();
    const first = await postInvoice(supplier, '1000');
    const second = await postInvoice(supplier, '2000');
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const target = (id: string, amountMinor: string) => ({
      targetType: 'purchase_invoice',
      targetId: id,
      amountMinor,
    });
    const command = {
      operationId: randomUUID(),
      paymentSource: 'money_account',
      moneyAccountId: account,
      amountMinor: '1500',
      occurredAt,
      allocations: [
        target(first.response.invoice.id, '500'),
        target(second.response.invoice.id, '1000'),
      ],
    };
    const post = (body: Record<string, unknown>) =>
      request(server).post(`/v1/suppliers/${supplier}/payments`).set(authorized()).send(body);
    const accepted = await post(command).expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '1500', '0');
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    expect(await accountBalance(account)).toBe('-1500');
    const beforeReplay = await captureReplayEvidence(
      db().admin,
      owner.storeId,
      supplierFinancialTables,
    );
    expect(
      (await post({ ...command, allocations: [...command.allocations].reverse() }).expect(201))
        .body,
    ).toEqual(accepted.body);
    expect(await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables)).toEqual(
      beforeReplay,
    );
    for (const invalid of [
      {
        amountMinor: '2',
        allocations: [
          target(first.response.invoice.id, '1'),
          target(first.response.invoice.id, '1'),
        ],
        status: 400,
      },
      { amountMinor: '501', allocations: [target(first.response.invoice.id, '501')], status: 409 },
      { amountMinor: '2', allocations: [target(first.response.invoice.id, '1')], status: 400 },
      { amountMinor: '1', allocations: [target(first.response.invoice.id, '2')], status: 400 },
      { amountMinor: '1', allocations: [], status: 400 },
      { amountMinor: '1', allocations: [target(first.response.invoice.id, '0')], status: 400 },
      { amountMinor: '1', allocations: [target(first.response.invoice.id, '-1')], status: 400 },
    ]) {
      const before = await captureReplayEvidence(
        db().admin,
        owner.storeId,
        supplierFinancialTables,
      );
      const { status, ...payload } = invalid;
      await post({ ...command, ...payload, operationId: randomUUID() }).expect(status);
      const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
      for (const table of Object.keys(before).filter(
        (table) => table !== 'sync.processed_operations',
      ))
        expect(after[table]).toEqual(before[table]);
    }
    if (!app) throw new Error('Application unavailable');
    const service = app.get(DatabaseService);
    const original = service.withTenantTransaction.bind(service);
    const beforeFailure = await captureReplayEvidence(
      db().admin,
      owner.storeId,
      supplierFinancialTables,
    );
    const spy = jest.spyOn(service, 'withTenantTransaction').mockImplementation((context, work) =>
      original(context, async (transaction) => {
        await work(transaction);
        throw new Error('Stage 4C controlled failure after funding');
      }),
    );
    try {
      await post({
        ...command,
        operationId: randomUUID(),
        amountMinor: '500',
        allocations: [target(first.response.invoice.id, '500')],
      }).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables)).toEqual(
      beforeFailure,
    );
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
  });

  it('S4C2-04 reconciles payable-first Returns, independent credit consumption and actual refunds', async () => {
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const rejectedUnchanged = async (test: request.Test) => {
      const before = await captureReplayEvidence(
        db().admin,
        owner.storeId,
        supplierFinancialTables,
      );
      await test.expect(409);
      const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
      for (const table of Object.keys(before).filter(
        (table) => table !== 'sync.processed_operations',
      ))
        expect(after[table]).toEqual(before[table]);
    };
    for (const paid of ['0', '700', '1000']) {
      const supplier = await createSupplier();
      const account = await createAccount();
      const invoice = await postInvoice(supplier, '1000');
      if (paid !== '0') await payInvoice(supplier, invoice.response.invoice.id, paid, account);
      const operation = randomUUID();
      const posted = await postReturn(
        supplier,
        invoice.response.invoice.id,
        '500',
        operation,
      ).expect(201);
      const reduction = paid === '0' ? '500' : paid === '700' ? '300' : '0';
      const credit = paid === '0' ? '0' : paid === '700' ? '200' : '500';
      const remaining = paid === '0' ? '500' : '0';
      await assertSupplierDimensions(db().admin, owner.storeId, supplier, remaining, credit);
      expect(await invoiceOutstanding(invoice.response.invoice.id)).toBe(remaining);
      const facts = (
        await db().admin.query(
          `select entry_type as type,payable_delta_minor::text as payable,
        credit_delta_minor::text as credit,source_purchase_invoice_id as invoice from ledger.supplier_ledger_entries
        where store_id=$1 and reference_type='supplier_return' and reference_id=$2 order by entry_type`,
          [owner.storeId, supplierReturnBody(posted).return.id],
        )
      ).rows;
      expect(facts).toEqual([
        ...(credit === '0'
          ? []
          : [
              {
                type: 'credit_created',
                payable: '0',
                credit,
                invoice: invoice.response.invoice.id,
              },
            ]),
        ...(reduction === '0'
          ? []
          : [
              {
                type: 'return',
                payable: (-BigInt(reduction)).toString(),
                credit: '0',
                invoice: invoice.response.invoice.id,
              },
            ]),
      ]);
      expect(await accountBalance(account)).toBe((-BigInt(paid)).toString());
      const beforeReplay = await captureReplayEvidence(
        db().admin,
        owner.storeId,
        supplierFinancialTables,
      );
      expect(
        (await postReturn(supplier, invoice.response.invoice.id, '500', operation).expect(201))
          .body,
      ).toEqual(posted.body);
      expect(
        await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables),
      ).toEqual(beforeReplay);
      await postReturn(supplier, invoice.response.invoice.id, '500').expect(201);
      await assertSupplierDimensions(db().admin, owner.storeId, supplier, '0', paid);
      await rejectedUnchanged(postReturn(supplier, invoice.response.invoice.id, '1'));
      await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    }
    const source = await createCredit('1000');
    const target = await postInvoice(source.supplierId, '1200');
    await assertSupplierDimensions(db().admin, owner.storeId, source.supplierId, '1200', '1000');
    const moneyBefore = (
      await db().admin.query(
        `select to_jsonb(m)::text as row from ledger.money_movements m where store_id=$1 order by id`,
        [owner.storeId],
      )
    ).rows;
    await applyCredit(source.supplierId, target.response.invoice.id, '400').expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, source.supplierId, '800', '600');
    await applyCredit(source.supplierId, target.response.invoice.id, '600').expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, source.supplierId, '200', '0');
    expect(await invoiceOutstanding(target.response.invoice.id)).toBe('200');
    await rejectedUnchanged(applyCredit(source.supplierId, target.response.invoice.id, '1'));
    expect(
      (
        await db().admin.query(
          `select to_jsonb(m)::text as row from ledger.money_movements m where store_id=$1 order by id`,
          [owner.storeId],
        )
      ).rows,
    ).toEqual(moneyBefore);
    const refundSource = await createCredit('500');
    const smallInvoice = await postInvoice(refundSource.supplierId, '100');
    await rejectedUnchanged(
      applyCredit(refundSource.supplierId, smallInvoice.response.invoice.id, '101'),
    );
    const account = await createAccount();
    for (const [amount, remaining, total] of [
      ['200', '300', '200'],
      ['300', '0', '500'],
    ] as const) {
      await refundCredit(refundSource.supplierId, account, amount).expect(201);
      await assertSupplierDimensions(
        db().admin,
        owner.storeId,
        refundSource.supplierId,
        '100',
        remaining,
      );
      expect(await accountBalance(account)).toBe(total);
    }
    await rejectedUnchanged(refundCredit(refundSource.supplierId, account, '1'));
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-05 preserves original facts and response identities through exact financial reversal and replacement', async () => {
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const supplier = await createSupplier();
    const account = await createAccount();
    const invoice = await postInvoice(supplier, '1000');
    const invoiceEdit = await request(server)
      .post(`/v1/suppliers/invoices/${invoice.operationId}/edit`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        replacement: {
          supplierId: supplier,
          items: [
            {
              description: 'Replacement',
              unitName: 'piece',
              quantityMilli: '1000',
              unitCostMinor: '1200',
            },
          ],
        },
      })
      .expect(201);
    const replacement = (invoiceEdit.body as { replacement: SupplierInvoicePostingResponse })
      .replacement;
    expect(
      (await postInvoice(supplier, '1000', owner, occurredAt, invoice.operationId)).response,
    ).toEqual(invoice.response);
    const payment = (source: string, amount: string, operationId = randomUUID()) => ({
      operationId,
      paymentSource: source,
      ...(source === 'money_account' ? { moneyAccountId: account } : {}),
      amountMinor: amount,
      occurredAt,
      allocations: [
        { targetType: 'purchase_invoice', targetId: replacement.invoice.id, amountMinor: amount },
      ],
    });
    const post = (body: Record<string, unknown>) =>
      request(server).post(`/v1/suppliers/${supplier}/payments`).set(authorized()).send(body);
    const normal = payment('money_account', '400');
    const ownerPaid = payment('owner_pocket', '400');
    const normalResponse = await post(normal).expect(201);
    const ownerResponse = await post(ownerPaid).expect(201);
    const immutableTables = [
      'ledger.supplier_ledger_entries',
      'ledger.money_movements',
      'ledger.owner_ledger_entries',
      'ledger.supplier_payment_allocations',
      'ledger.purchase_items',
    ];
    const before = await captureReplayEvidence(db().admin, owner.storeId, immutableTables);
    await request(server)
      .post(`/v1/suppliers/payments/${normal.operationId}/cancel`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt })
      .expect(201);
    const ownerEditId = randomUUID();
    const ownerReplacement = payment('owner_pocket', '200');
    const { operationId: unused, ...ownerPayload } = ownerReplacement;
    void unused;
    await request(server)
      .post(`/v1/suppliers/payments/${ownerPaid.operationId}/edit`)
      .set(authorized())
      .send({
        operationId: ownerEditId,
        occurredAt,
        replacement: { supplierId: supplier, ...ownerPayload },
      })
      .expect(201);
    expect((await post(normal).expect(201)).body).toEqual(normalResponse.body);
    expect((await post(ownerPaid).expect(201)).body).toEqual(ownerResponse.body);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '1000', '0');
    expect(await invoiceOutstanding(replacement.invoice.id)).toBe('1000');
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    const returnId = randomUUID();
    const originalReturn = await postReturn(
      supplier,
      replacement.invoice.id,
      '300',
      returnId,
    ).expect(201);
    await correct(
      'financial-returns',
      'replace',
      returnId,
      correctionBody({ amountMinor: '150', reason: 'Adjusted return' }),
    ).expect(201);
    expect(
      (await postReturn(supplier, replacement.invoice.id, '300', returnId).expect(201)).body,
    ).toEqual(originalReturn.body);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '850', '0');
    const source = await createCredit('1000');
    const target = await postInvoice(source.supplierId, '600');
    const applicationId = randomUUID();
    const application = await applyCredit(
      source.supplierId,
      target.response.invoice.id,
      '200',
      applicationId,
    ).expect(201);
    await correct(
      'credit-applications',
      'replace',
      applicationId,
      correctionBody({
        purchaseInvoiceId: target.response.invoice.id,
        amountMinor: '100',
        notes: 'Adjusted credit',
      }),
    ).expect(201);
    expect(
      (
        await applyCredit(
          source.supplierId,
          target.response.invoice.id,
          '200',
          applicationId,
        ).expect(201)
      ).body,
    ).toEqual(application.body);
    const refundId = randomUUID();
    const refundAccount = await createAccount();
    const refund = await refundCredit(source.supplierId, refundAccount, '200', refundId).expect(
      201,
    );
    await correct(
      'refunds',
      'replace',
      refundId,
      correctionBody({
        moneyAccountId: refundAccount,
        amountMinor: '100',
        notes: 'Adjusted refund',
      }),
    ).expect(201);
    expect(
      (await refundCredit(source.supplierId, refundAccount, '200', refundId).expect(201)).body,
    ).toEqual(refund.body);
    await assertSupplierDimensions(db().admin, owner.storeId, source.supplierId, '500', '800');
    expect(await accountBalance(refundAccount)).toBe('100');
    const dependency = await postInvoice(supplier, '100');
    await postReturn(supplier, dependency.response.invoice.id, '20').expect(201);
    for (const operation of [
      target.operationId,
      source.invoice.operationId,
      dependency.operationId,
    ]) {
      const saved = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
      await request(server)
        .post(`/v1/suppliers/invoices/${operation}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt })
        .expect(409);
      const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
      for (const table of supplierFinancialTables) expect(after[table]).toEqual(saved[table]);
    }
    const saved = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    await correct('financial-returns', 'cancel', source.returnOperationId, correctionBody()).expect(
      409,
    );
    const afterRejected = await captureReplayEvidence(
      db().admin,
      owner.storeId,
      supplierFinancialTables,
    );
    for (const table of supplierFinancialTables) expect(afterRejected[table]).toEqual(saved[table]);
    const after = await captureReplayEvidence(db().admin, owner.storeId, immutableTables);
    for (const table of Object.keys(before))
      expect(after[table]).toEqual(expect.arrayContaining(before[table] ?? []));
    await assertSupplierReversalFacts(db().admin, owner.storeId);
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-03 funds partial and full Supplier settlement exclusively through Owner liability', async () => {
    const supplier = await createSupplier();
    const account = await createAccount();
    const invoice = await postInvoice(supplier, '10000');
    const before = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const body = (amount: string) => ({
      operationId: randomUUID(),
      paymentSource: 'owner_pocket',
      amountMinor: amount,
      occurredAt,
      allocations: [
        {
          targetType: 'purchase_invoice',
          targetId: invoice.response.invoice.id,
          amountMinor: amount,
        },
      ],
    });
    for (const invalid of [
      { ...body('1'), moneyAccountId: account },
      { ...body('1'), paymentSource: 'money_account' },
    ]) {
      await request(server)
        .post(`/v1/suppliers/${supplier}/payments`)
        .set(authorized())
        .send(invalid)
        .expect(400);
      expect(
        await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables),
      ).toEqual(before);
    }
    for (const [amount, payable, liability] of [
      ['4000', '6000', '4000'],
      ['6000', '0', '10000'],
    ] as const) {
      await request(server)
        .post(`/v1/suppliers/${supplier}/payments`)
        .set(authorized())
        .send(body(amount))
        .expect(201);
      await assertSupplierDimensions(db().admin, owner.storeId, supplier, payable, '0');
      await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
      expect(await invoiceOutstanding(invoice.response.invoice.id)).toBe(payable);
      expect(
        (
          await db().admin.query(
            `select sum(o.owner_liability_delta_minor)::text as liability,
        sum(o.equity_delta_minor)::text as equity from ledger.owner_ledger_entries o
        join ledger.supplier_payments p on p.store_id=o.store_id and p.owner_ledger_entry_id=o.id
        where p.store_id=$1 and p.supplier_id=$2`,
            [owner.storeId, supplier],
          )
        ).rows,
      ).toEqual([{ liability, equity: '0' }]);
    }
    const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    expect(after['ledger.money_movements']).toEqual(before['ledger.money_movements']);
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-06 preserves rounding, bigint and historical facts after Supplier description edits', async () => {
    const supplier = await createSupplier();
    const account = await createAccount();
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const rounded = await request(server)
      .post(`/v1/suppliers/${supplier}/invoices`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        invoiceDiscountMinor: '10',
        roundingMinor: '1',
        items: [
          {
            description: 'Half-up line',
            unitName: 'piece',
            quantityMilli: '1500',
            unitCostMinor: '101',
            lineDiscountMinor: '2',
          },
        ],
      })
      .expect(201);
    const roundedInvoice = rounded.body as SupplierInvoicePostingResponse;
    expect(roundedInvoice.items[0]).toMatchObject({
      lineGrossMinor: '152',
      lineDiscountMinor: '2',
      roundingMinor: '0',
      lineTotalMinor: '150',
    });
    expect(roundedInvoice.invoice).toMatchObject({
      itemsSubtotalMinor: '152',
      lineDiscountTotalMinor: '2',
      invoiceDiscountMinor: '10',
      roundingMinor: '1',
      totalMinor: '141',
    });
    expect(
      (
        await db().admin.query(
          `select line_gross_minor::text as gross,line_discount_minor::text as discount,
      rounding_minor::text as rounding,line_total_minor::text as total from ledger.purchase_items
      where store_id=$1 and purchase_invoice_id=$2`,
          [owner.storeId, roundedInvoice.invoice.id],
        )
      ).rows,
    ).toEqual([{ gross: '152', discount: '2', rounding: '0', total: '150' }]);
    expect(
      (
        await db().admin.query(
          `select items_subtotal_minor::text as subtotal,invoice_discount_minor::text as discount,
      rounding_minor::text as rounding,total_minor::text as total from ledger.purchase_invoices where store_id=$1 and id=$2`,
          [owner.storeId, roundedInvoice.invoice.id],
        )
      ).rows,
    ).toEqual([{ subtotal: '152', discount: '10', rounding: '1', total: '141' }]);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '141', '0');
    const huge = '9007199254740993';
    const large = await postInvoice(supplier, huge);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '9007199254741134', '0');
    await payInvoice(supplier, large.response.invoice.id, huge, account);
    await assertSupplierPaymentFacts(db().admin, owner.storeId, supplier);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '141', '0');
    expect(await accountBalance(account)).toBe('-9007199254740993');
    const before = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    await request(server)
      .patch(`/v1/suppliers/${supplier}`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        expectedVersion: await supplierVersion(supplier),
        name: 'Updated Supplier display name',
      })
      .expect(200);
    const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    for (const table of supplierFinancialTables) expect(after[table]).toEqual(before[table]);
    for (const table of Object.keys(before))
      expect(after[table]).toEqual(expect.arrayContaining(before[table] ?? []));
    const read = await request(server)
      .get(`/v1/suppliers/${supplier}/invoices`)
      .set(authorized())
      .expect(200);
    expect(read.body).toMatchObject({
      invoices: expect.arrayContaining([
        expect.objectContaining({
          id: large.response.invoice.id,
          totalMinor: huge,
          paidAmountMinor: huge,
          outstandingMinor: '0',
        }),
      ]) as unknown,
    });
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-06 rejects archived account funding while preserving historical payment and exact reversal', async () => {
    const supplier = await createSupplier();
    const account = await createAccount();
    const invoice = await postInvoice(supplier, '300');
    const paymentId = randomUUID();
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    await payInvoice(supplier, invoice.response.invoice.id, '100', account, paymentId);
    const credit = await createCredit('100');
    await refundCredit(credit.supplierId, account, '100').expect(201);
    expect(await accountBalance(account)).toBe('0');
    const version = (
      await db().admin.query<{ version: string }>(
        'select version::text as version from ledger.money_accounts where store_id=$1 and id=$2',
        [owner.storeId, account],
      )
    ).rows[0]?.version;
    await request(server)
      .post(`/v1/money-accounts/${account}/archive`)
      .set(authorized())
      .send({ operationId: randomUUID(), expectedVersion: version })
      .expect(200);
    const before = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    const replacement = {
      supplierId: supplier,
      paymentSource: 'money_account',
      moneyAccountId: account,
      amountMinor: '100',
      occurredAt,
      allocations: [
        {
          targetType: 'purchase_invoice',
          targetId: invoice.response.invoice.id,
          amountMinor: '100',
        },
      ],
    };
    const { supplierId: ignored, ...newPayment } = replacement;
    void ignored;
    const rejected = await request(server)
      .post(`/v1/suppliers/${supplier}/payments`)
      .set(authorized())
      .send({ operationId: randomUUID(), ...newPayment })
      .expect(409);
    expect(rejected.body).toMatchObject({ code: 'MONEY_ACCOUNT_UNAVAILABLE' });
    await request(server)
      .post(`/v1/suppliers/payments/${paymentId}/edit`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt, replacement })
      .expect(409);
    const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    for (const table of Object.keys(before).filter(
      (table) => table !== 'sync.processed_operations',
    ))
      expect(after[table]).toEqual(before[table]);
    const history = await request(server)
      .get(`/v1/suppliers/${supplier}/payments`)
      .set(authorized())
      .expect(200);
    expect(history.body).toMatchObject({
      payments: expect.arrayContaining([
        expect.objectContaining({ amountMinor: '100', status: 'posted' }),
      ]) as unknown,
    });
    await request(server)
      .post(`/v1/suppliers/payments/${paymentId}/cancel`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt })
      .expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '300', '0');
    expect(await invoiceOutstanding(invoice.response.invoice.id)).toBe('300');
    expect(await accountBalance(account)).toBe('100');
    expect(
      (
        await db().admin.query(
          `select r.amount_delta_minor::text as amount,o.amount_delta_minor::text as original
      from ledger.money_movements r join ledger.money_movements o on o.store_id=r.store_id and o.id=r.reversal_of_id
      where r.store_id=$1 and r.account_id=$2`,
          [owner.storeId, account],
        )
      ).rows,
    ).toEqual([{ amount: '100', original: '-100' }]);
    expect(
      (
        await db().admin.query(
          'select status from ledger.money_accounts where store_id=$1 and id=$2',
          [owner.storeId, account],
        )
      ).rows,
    ).toEqual([{ status: 'archived' }]);
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-06 requires Supplier restoration for all six new financial operations while retaining historical replay and safe correction', async () => {
    const supplier = await createSupplier();
    const account = await createAccount();
    const boundary = await supplierBoundaries(db().admin, owner.storeId);
    const invoice = await postInvoice(supplier, '1000');
    const openingBody = { operationId: randomUUID(), amountMinor: '300', occurredAt };
    const openingPost = (body: Record<string, unknown>) =>
      request(server)
        .post(`/v1/suppliers/${supplier}/opening-payables`)
        .set(authorized())
        .send(body);
    const opening = await openingPost(openingBody).expect(201);
    const openingId = (opening.body as { payable: { id: string } }).payable.id;
    const paymentBody = {
      operationId: randomUUID(),
      paymentSource: 'money_account',
      moneyAccountId: account,
      amountMinor: '1300',
      occurredAt,
      allocations: [
        {
          targetType: 'purchase_invoice',
          targetId: invoice.response.invoice.id,
          amountMinor: '1000',
        },
        { targetType: 'opening_payable', targetId: openingId, amountMinor: '300' },
      ],
    };
    const paymentPost = (body: Record<string, unknown>) =>
      request(server).post(`/v1/suppliers/${supplier}/payments`).set(authorized()).send(body);
    const payment = await paymentPost(paymentBody).expect(201);
    const returnId = randomUUID();
    const returned = await postReturn(
      supplier,
      invoice.response.invoice.id,
      '200',
      returnId,
    ).expect(201);
    const creditTarget = await postInvoice(supplier, '100');
    const creditId = randomUUID();
    const credit = await applyCredit(
      supplier,
      creditTarget.response.invoice.id,
      '100',
      creditId,
    ).expect(201);
    const refundId = randomUUID();
    const refund = await refundCredit(supplier, account, '100', refundId).expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '0', '0');
    await request(server)
      .post(`/v1/suppliers/${supplier}/archive`)
      .set(authorized())
      .send({ operationId: randomUUID(), expectedVersion: await supplierVersion(supplier) })
      .expect(200);
    const before = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    expect(
      (await postInvoice(supplier, '1000', owner, occurredAt, invoice.operationId)).response,
    ).toEqual(invoice.response);
    expect((await openingPost(openingBody).expect(201)).body).toEqual(opening.body);
    expect((await paymentPost(paymentBody).expect(201)).body).toEqual(payment.body);
    expect(
      (await postReturn(supplier, invoice.response.invoice.id, '200', returnId).expect(201)).body,
    ).toEqual(returned.body);
    expect(
      (await applyCredit(supplier, creditTarget.response.invoice.id, '100', creditId).expect(201))
        .body,
    ).toEqual(credit.body);
    expect((await refundCredit(supplier, account, '100', refundId).expect(201)).body).toEqual(
      refund.body,
    );
    expect(await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables)).toEqual(
      before,
    );
    await request(server).get(`/v1/suppliers/${supplier}/invoices`).set(authorized()).expect(200);
    await request(server).get(`/v1/suppliers/${supplier}/payments`).set(authorized()).expect(200);
    await request(server)
      .get(`/v1/suppliers/${supplier}/return-financials`)
      .set(authorized())
      .expect(200);
    const invoiceBody = {
      operationId: randomUUID(),
      occurredAt,
      items: [
        {
          description: 'Archived rejection',
          unitName: 'piece',
          quantityMilli: '1000',
          unitCostMinor: '1',
        },
      ],
    };
    const invoicePost = (body: Record<string, unknown>) =>
      request(server).post(`/v1/suppliers/${supplier}/invoices`).set(authorized()).send(body);
    const rejectedOpening = { ...openingBody, operationId: randomUUID() };
    const rejectedPayment = { ...paymentBody, operationId: randomUUID() };
    for (const rejected of [
      () => invoicePost(invoiceBody),
      () => openingPost(rejectedOpening),
      () => paymentPost(rejectedPayment),
      () => postReturn(supplier, invoice.response.invoice.id, '1'),
      () => applyCredit(supplier, invoice.response.invoice.id, '1'),
      () => refundCredit(supplier, account, '1'),
    ]) {
      const result = await rejected().expect(409);
      expect(result.body).toMatchObject({ code: 'SUPPLIER_INACTIVE' });
      const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
      for (const table of Object.keys(before).filter(
        (table) => table !== 'sync.processed_operations',
      ))
        expect(after[table]).toEqual(before[table]);
    }
    expect(
      (
        await db().admin.query('select status from ledger.suppliers where store_id=$1 and id=$2', [
          owner.storeId,
          supplier,
        ])
      ).rows,
    ).toEqual([{ status: 'archived' }]);
    // Pure inverses retain historical eligibility; replacement facts require an active Supplier.
    const replacement = {
      supplierId: supplier,
      paymentSource: 'money_account',
      moneyAccountId: account,
      amountMinor: '1',
      occurredAt,
      allocations: [
        { targetType: 'purchase_invoice', targetId: invoice.response.invoice.id, amountMinor: '1' },
      ],
    };
    const rejectedEdit = await request(server)
      .post(`/v1/suppliers/payments/${paymentBody.operationId}/edit`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt, replacement })
      .expect(409);
    expect(rejectedEdit.body).toMatchObject({ code: 'SUPPLIER_INACTIVE' });
    const afterEdit = await captureReplayEvidence(
      db().admin,
      owner.storeId,
      supplierFinancialTables,
    );
    for (const table of supplierFinancialTables) expect(afterEdit[table]).toEqual(before[table]);
    await request(server)
      .post(`/v1/suppliers/payments/${paymentBody.operationId}/cancel`)
      .set(authorized())
      .send({ operationId: randomUUID(), occurredAt })
      .expect(201);
    await correct('credit-applications', 'cancel', creditId, correctionBody()).expect(201);
    await correct('refunds', 'cancel', refundId, correctionBody()).expect(201);
    await correct('financial-returns', 'cancel', returnId, correctionBody()).expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '1400', '0');
    const rejectedInvoiceEdit = await request(server)
      .post(`/v1/suppliers/invoices/${invoice.operationId}/edit`)
      .set(authorized())
      .send({
        operationId: randomUUID(),
        occurredAt,
        replacement: { supplierId: supplier, items: invoiceBody.items },
      })
      .expect(409);
    expect(rejectedInvoiceEdit.body).toMatchObject({ code: 'SUPPLIER_INACTIVE' });
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '1400', '0');
    for (const operation of [invoice.operationId, creditTarget.operationId])
      await request(server)
        .post(`/v1/suppliers/invoices/${operation}/cancel`)
        .set(authorized())
        .send({ operationId: randomUUID(), occurredAt })
        .expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '300', '0');
    await request(server)
      .post(`/v1/suppliers/${supplier}/restore`)
      .set(authorized())
      .send({ operationId: randomUUID(), expectedVersion: await supplierVersion(supplier) })
      .expect(200);
    // Persisted rejection is historical; restoration permits a genuinely new operation only.
    expect((await invoicePost(invoiceBody).expect(409)).body).toMatchObject({
      code: 'SUPPLIER_INACTIVE',
    });
    expect((await openingPost(rejectedOpening).expect(409)).body).toMatchObject({
      code: 'SUPPLIER_INACTIVE',
    });
    expect((await paymentPost(rejectedPayment).expect(409)).body).toMatchObject({
      code: 'SUPPLIER_INACTIVE',
    });
    await invoicePost({ ...invoiceBody, operationId: randomUUID() }).expect(201);
    await assertSupplierDimensions(db().admin, owner.storeId, supplier, '301', '0');
    expect(await supplierBoundaries(db().admin, owner.storeId)).toEqual(boundary);
  });

  it('S4C2-06 rechecks Supplier activity after a concurrent archive wins the row lock', async () => {
    for (const family of ['invoices', 'opening-payables', 'payments'] as const) {
      const supplier = await createSupplier();
      const account = await createAccount();
      const invoice = await postInvoice(supplier, '100');
      await payInvoice(supplier, invoice.response.invoice.id, '100', account);
      const before = await captureReplayEvidence(
        db().admin,
        owner.storeId,
        supplierFinancialTables,
      );
      const blocker = await db().admin.connect();
      let pending: Promise<Response> | undefined;
      try {
        await blocker.query('begin');
        const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]?.pid;
        // Stage the archive under its real row lock; the HTTP writer must observe the committed status.
        await blocker.query(
          `update ledger.suppliers set status='archived',archived_at=clock_timestamp()
          where store_id=$1 and id=$2`,
          [owner.storeId, supplier],
        );
        const body =
          family === 'invoices'
            ? {
                operationId: randomUUID(),
                occurredAt,
                items: [
                  {
                    description: 'Race',
                    unitName: 'piece',
                    quantityMilli: '1000',
                    unitCostMinor: '1',
                  },
                ],
              }
            : family === 'opening-payables'
              ? { operationId: randomUUID(), occurredAt, amountMinor: '1' }
              : {
                  operationId: randomUUID(),
                  occurredAt,
                  amountMinor: '1',
                  paymentSource: 'money_account',
                  moneyAccountId: account,
                  allocations: [
                    {
                      targetType: 'purchase_invoice',
                      targetId: invoice.response.invoice.id,
                      amountMinor: '1',
                    },
                  ],
                };
        pending = request(server)
          .post(`/v1/suppliers/${supplier}/${family}`)
          .set(authorized())
          .send(body)
          .then((result) => result);
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const result = await db().admin.query<{ blocked: boolean }>(
            `select exists(select 1 from pg_stat_activity
            where datname=current_database() and $1::int=any(pg_blocking_pids(pid)) and wait_event_type='Lock') as blocked`,
            [blockerPid],
          );
          if (result.rows[0]?.blocked) {
            blocked = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await blocker.query('commit');
        const response = await pending;
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'SUPPLIER_INACTIVE' });
        const after = await captureReplayEvidence(
          db().admin,
          owner.storeId,
          supplierFinancialTables,
        );
        for (const table of supplierFinancialTables) expect(after[table]).toEqual(before[table]);
      } finally {
        await blocker.query('rollback');
        blocker.release();
        if (pending) await pending;
      }
    }
  });

  it('S4E2-07 agrees across application time, persisted posting, PostgreSQL admission and DST month boundaries', async () => {
    if (!app) throw new Error('Application unavailable');
    const supplierId = await createSupplier();
    const times = [
      ['2026-01-14T21:59:59.999Z', '2026-01-14T23:59:59.999+02:00'],
      ['2026-01-14T22:00:00.000Z', '2026-01-15T00:00:00.000+02:00'],
      ['2022-03-26T21:59:59.999Z', '2022-03-26T23:59:59.999+02:00'],
      ['2022-03-26T22:00:00.000Z', '2022-03-27T01:00:00.000+03:00'],
      ['2022-10-28T22:30:00.000Z', '2022-10-29T01:30:00.000+03:00'],
      ['2022-10-28T23:30:00.000Z', '2022-10-29T01:30:00.000+02:00'],
      ['2022-03-31T20:59:59.999Z', '2022-03-31T23:59:59.999+03:00'],
      ['2022-03-31T21:00:00.000Z', '2022-04-01T00:00:00.000+03:00'],
    ] as const;
    for (const [at, local] of times) {
      const time = app.get(OperationalTimeService).resolve(new Date(at));
      expect(time.storeLocalDatetime).toBe(`${local}[Asia/Hebron]`);
      const invoice = await postInvoice(supplierId, '100', owner, at);
      const expectedDate = local.slice(0, 10);
      const expectedPeriod = deriveAccountingPeriodId(
        owner.storeId,
        Number(local.slice(0, 4)),
        Number(local.slice(5, 7)),
      );
      expect(invoice.response).toMatchObject({
        businessDate: expectedDate,
        postingDate: expectedDate,
        accountingPeriodId: expectedPeriod,
      });
      const rows = (
        await db().admin.query(
          `select p.posting_date::text as date,
        (p.invoice_date_at at time zone 'Asia/Hebron')::date::text as pg_date,
        p.accounting_period_id as period, p.invoice_date_at as at,
        a.starts_at as start,a.ends_at as stop,a.status,
        p.invoice_date_at>=a.starts_at and p.invoice_date_at<a.ends_at as contained
        from ledger.purchase_invoices p join ledger.accounting_periods a
        on a.store_id=p.store_id and a.id=p.accounting_period_id
        where p.store_id=$1 and p.operation_id=$2`,
          [owner.storeId, invoice.operationId],
        )
      ).rows;
      const boundaries = resolveAccountingPeriodBoundaries(
        Number(local.slice(0, 4)),
        Number(local.slice(5, 7)),
      );
      expect(rows).toEqual([
        {
          date: expectedDate,
          pg_date: expectedDate,
          period: expectedPeriod,
          at: new Date(at),
          start: boundaries.startsAt,
          stop: boundaries.endsAt,
          status: 'open',
          contained: true,
        },
      ]);
      await app.get(DatabaseService).withTenantTransaction(
        {
          storeId: owner.storeId,
          userId: owner.userId,
          deviceId: owner.deviceId,
          requestId: randomUUID(),
        },
        async (transaction) => {
          await transaction.execute(sql`select ledger.assert_period_open(${owner.storeId}::uuid,
          ${expectedPeriod}::uuid, ${at}::timestamptz)`);
        },
      );
    }
    const marchId = deriveAccountingPeriodId(owner.storeId, 2022, 3);
    const aprilId = deriveAccountingPeriodId(owner.storeId, 2022, 4);
    expect(
      (
        await db().admin.query(
          `select m.starts_at as start,m.ends_at as stop,
      m.ends_at=a.starts_at as contiguous,
      tstzrange(m.starts_at,m.ends_at,'[)') && tstzrange(a.starts_at,a.ends_at,'[)') as overlap
      from ledger.accounting_periods m join ledger.accounting_periods a on a.store_id=m.store_id
      where m.store_id=$1 and m.id=$2 and a.id=$3`,
          [owner.storeId, marchId, aprilId],
        )
      ).rows,
    ).toEqual([
      {
        start: new Date('2022-02-28T22:00:00Z'),
        stop: new Date('2022-03-31T21:00:00Z'),
        contiguous: true,
        overlap: false,
      },
    ]);
  });

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

  it('Stage 3B B02 cancels and replaces Supplier Returns immutably while preserving original replay and rollback', async () => {
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

  it.each(['invoice', 'return'] as const)(
    'S4E2-05 serializes %s posting with period close and rolls back failure',
    async (family) => {
      if (!runtimePool) throw new Error('Runtime pool unavailable');
      const supplierId = await createSupplier();
      const month = family === 'invoice' ? 1 : 2;
      const at = `2031-${String(month).padStart(2, '0')}-15T10:00:00.000Z`;
      const period = deriveAccountingPeriodId(owner.storeId, 2031, month);
      const source = await postInvoice(supplierId, '500', owner, at);
      const post = (operationId: ReturnType<typeof randomUUID>) =>
        family === 'return'
          ? postReturn(supplierId, source.response.invoice.id, '100', operationId, owner, at)
          : request(server)
              .post(`/v1/suppliers/${supplierId}/invoices`)
              .set(authorized())
              .send({
                operationId,
                occurredAt: at,
                totalMinor: '100',
                items: [
                  {
                    description: 'S4E2-05 posting',
                    unitName: 'piece',
                    quantityMilli: '1000',
                    unitCostMinor: '100',
                    lineTotalMinor: '100',
                  },
                ],
              });
      const tables = [...supplierFinancialTables, 'ledger.accounting_periods'];
      const failureOperation = randomUUID();
      const beforeFailure = await captureReplayEvidence(db().admin, owner.storeId, tables);
      const restoreFailure = interceptOperationQueries(
        runtimePool,
        failureOperation,
        async (text, execute) => {
          if (text === 'commit') throw new Error('S4E2-05 controlled failure before commit');
          return execute();
        },
      );
      try {
        await post(failureOperation).expect(500);
      } finally {
        restoreFailure();
      }
      expect(await captureReplayEvidence(db().admin, owner.storeId, tables)).toEqual(beforeFailure);

      const postingOperation = randomUUID();
      let arrived!: () => void;
      let release!: () => void;
      const atCommit = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const restore = interceptOperationQueries(
        runtimePool,
        postingOperation,
        async (text, execute) => {
          if (text === 'commit') {
            arrived();
            await gate;
          }
          return execute();
        },
      );
      const posting = post(postingOperation).then((response) => response);
      let closing: Promise<Response> | undefined;
      try {
        await Promise.race([
          atCommit,
          posting.then(() => {
            throw new Error('Posting missed commit gate');
          }),
        ]);
        const version = (
          await db().admin.query<{ version: string }>(
            `select version::text as version from ledger.accounting_periods
        where store_id=$1 and id=$2`,
            [owner.storeId, period],
          )
        ).rows[0]?.version;
        if (version === undefined) throw new Error('Accounting period version missing');
        closing = request(server)
          .post(`/v1/accounting-periods/${period}/close`)
          .set(authorized())
          .send({ operationId: randomUUID(), expectedVersion: version })
          .then((response) => response);
        let waiting = 0;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          waiting =
            (
              await db().admin.query<{
                count: number;
              }>(`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query like '%accounting_periods%'`)
            ).rows[0]?.count ?? 0;
          if (waiting > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(1);
      } finally {
        release();
        await Promise.allSettled([posting, ...(closing ? [closing] : [])]);
        restore();
      }
      expect((await posting).status).toBe(201);
      expect((await closing).status).toBe(200);
      expect(
        (
          await db().admin.query(
            `select status from ledger.accounting_periods
      where store_id=$1 and id=$2`,
            [owner.storeId, period],
          )
        ).rows,
      ).toEqual([{ status: 'closed' }]);
      const effects = (
        await db().admin.query(
          `select accounting_period_id,payable_delta_minor::text as p,
      credit_delta_minor::text as c from ledger.supplier_ledger_entries
      where store_id=$1 and transaction_group_id=$2`,
          [owner.storeId, postingOperation],
        )
      ).rows;
      expect(effects).toEqual([
        { accounting_period_id: period, p: family === 'invoice' ? '100' : '-100', c: '0' },
      ]);
      const blockedOperation = randomUUID();
      const beforeBlocked = await captureReplayEvidence(db().admin, owner.storeId, tables);
      expect((await post(blockedOperation).expect(409)).body).toMatchObject({
        code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
      });
      const afterBlocked = await captureReplayEvidence(db().admin, owner.storeId, tables);
      for (const table of tables) expect(afterBlocked[table]).toEqual(beforeBlocked[table]);
      expect(
        (
          await db().admin.query(
            `select status from sync.processed_operations
      where store_id=$1 and operation_id=$2`,
            [owner.storeId, blockedOperation],
          )
        ).rows,
      ).toEqual([{ status: 'rejected' }]);
    },
  );

  it('S4E2-04 admits Supplier Return and independent replacement periods without partial correction', async () => {
    const supplierId = await createSupplier();
    const accountId = await createAccount();
    const invoice = await postInvoice(supplierId, '500', owner, previousOccurredAt);
    const paymentOperation = randomUUID();
    const paymentPayload = {
      operationId: paymentOperation,
      paymentSource: 'money_account',
      moneyAccountId: accountId,
      amountMinor: '200',
      occurredAt: previousOccurredAt,
      allocations: [
        {
          targetType: 'purchase_invoice',
          targetId: invoice.response.invoice.id,
          amountMinor: '200',
        },
      ],
    };
    await request(server)
      .post(`/v1/suppliers/${supplierId}/payments`)
      .set(authorized())
      .send(paymentPayload)
      .expect(201);
    await db().admin.query(
      `update ledger.accounting_periods set status='closed',closed_at=clock_timestamp()
      where store_id=$1 and id=$2`,
      [owner.storeId, previousPeriodId],
    );
    const original = (
      await db().admin.query<{ id: string; fact: string }>(
        `select id,to_jsonb(e)::text as fact
      from ledger.supplier_ledger_entries e where store_id=$1 and supplier_id=$2 order by id`,
        [owner.storeId, supplierId],
      )
    ).rows;
    const editOperation = randomUUID();
    const { operationId: ignoredOperation, ...replacementPayload } = paymentPayload;
    expect(ignoredOperation).toBe(paymentOperation);
    const edit = (operationId: string, replacementOccurredAt: string) =>
      request(server)
        .post(`/v1/suppliers/payments/${paymentOperation}/edit`)
        .set(authorized())
        .send({
          operationId,
          occurredAt,
          replacement: { ...replacementPayload, supplierId, occurredAt: replacementOccurredAt },
        });
    const before = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    expect((await edit(editOperation, previousOccurredAt).expect(409)).body).toMatchObject({
      code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE',
    });
    const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    for (const table of supplierFinancialTables) expect(after[table]).toEqual(before[table]);
    expect(
      (
        await db().admin.query(
          `select status from sync.processed_operations where store_id=$1 and operation_id=$2`,
          [owner.storeId, editOperation],
        )
      ).rows,
    ).toEqual([{ status: 'rejected' }]);
    const at = new Date(occurredAt);
    const replacementAt = new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 15, 10),
    ).toISOString();
    const acceptedOperation = randomUUID();
    await edit(acceptedOperation, replacementAt).expect(201);
    const facts = (
      await db().admin.query<{
        accounting_period_id: string;
        occurred_at: Date;
        delta: string;
        date: string;
        status: string;
        contained: boolean;
      }>(
        `select e.accounting_period_id,e.occurred_at,e.payable_delta_minor::text as delta,
        (e.occurred_at at time zone 'Asia/Hebron')::date::text as date,
        p.status,(p.starts_at<=e.occurred_at and e.occurred_at<p.ends_at) as contained
       from ledger.supplier_ledger_entries e join ledger.accounting_periods p
         on p.store_id=e.store_id and p.id=e.accounting_period_id
       where e.store_id=$1 and e.transaction_group_id=$2 order by e.occurred_at`,
        [owner.storeId, acceptedOperation],
      )
    ).rows;
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      accounting_period_id: currentPeriodId,
      delta: '200',
      status: 'open',
      contained: true,
    });
    expect(facts[0]?.occurred_at.toISOString()).toBe(occurredAt);
    expect(facts[1]).toMatchObject({
      delta: '-200',
      status: 'open',
      contained: true,
      date: replacementAt.slice(0, 10),
    });
    expect(facts[1]?.occurred_at.toISOString()).toBe(replacementAt);
    expect(facts[1]?.accounting_period_id).not.toBe(currentPeriodId);
    const money = (
      await db().admin.query(
        `select accounting_period_id,occurred_at,amount_delta_minor::text as delta
      from ledger.money_movements where store_id=$1 and transaction_group_id=$2 order by occurred_at`,
        [owner.storeId, acceptedOperation],
      )
    ).rows;
    expect(money).toEqual(
      facts.map((row) => ({
        accounting_period_id: row.accounting_period_id,
        occurred_at: row.occurred_at,
        delta: row.delta,
      })),
    );
    expect(
      (
        await db().admin.query(
          `select id,to_jsonb(e)::text as fact from ledger.supplier_ledger_entries e
      where store_id=$1 and id=any($2::uuid[]) order by id`,
          [owner.storeId, original.map((row) => row.id)],
        )
      ).rows,
    ).toEqual(original);
    const returned = supplierReturnBody(
      await postReturn(supplierId, invoice.response.invoice.id, '100').expect(201),
    );
    expect(returned.posting.accountingPeriodId).toBe(currentPeriodId);
    expect(
      (
        await db().admin.query(
          `select accounting_period_id from ledger.purchase_invoices where store_id=$1 and id=$2`,
          [owner.storeId, invoice.response.invoice.id],
        )
      ).rows,
    ).toEqual([{ accounting_period_id: previousPeriodId }]);
    expect(
      (
        await db().admin.query(
          `select status from ledger.accounting_periods where store_id=$1 and id=$2`,
          [owner.storeId, previousPeriodId],
        )
      ).rows,
    ).toEqual([{ status: 'closed' }]);
    // Restore only the disposable fixture for unrelated tests sharing this month.
    await db().admin.query(
      `update ledger.accounting_periods set status='open',closed_at=null
      where store_id=$1 and id=$2`,
      [owner.storeId, previousPeriodId],
    );
  });

  it('S4E2-03 blocks Supplier dependencies and preserves exact Return replacement lineage', async () => {
    async function rejectUnchanged(call: request.Test, operationId: string, code: string) {
      const before = await captureReplayEvidence(
        db().admin,
        owner.storeId,
        supplierFinancialTables,
      );
      expect((await call.expect(409)).body).toMatchObject({ code });
      const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
      for (const table of supplierFinancialTables) expect(after[table]).toEqual(before[table]);
      expect(
        (
          await db().admin.query(
            `select count(*)::int as count from sync.processed_operations
         where store_id=$1 and operation_id=$2 and status='applied'`,
            [owner.storeId, operationId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    }
    const supplierId = await createSupplier();
    const invoice = await postInvoice(supplierId, '500');
    await payInvoice(supplierId, invoice.response.invoice.id, '100', await createAccount());
    const invoiceCorrection = randomUUID();
    await rejectUnchanged(
      request(server)
        .post(`/v1/suppliers/invoices/${invoice.operationId}/cancel`)
        .set(authorized())
        .send({ operationId: invoiceCorrection, occurredAt }),
      invoiceCorrection,
      'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS',
    );
    expect(await invoiceOutstanding(invoice.response.invoice.id)).toBe('400');

    const source = await createCredit('200');
    const refundOperation = randomUUID();
    const refundAccount = await createAccount();
    await refundCredit(source.supplierId, refundAccount, '150', refundOperation).expect(201);
    const blockedOperation = randomUUID();
    await rejectUnchanged(
      correct(
        'financial-returns',
        'cancel',
        source.returnOperationId,
        correctionBody(undefined, blockedOperation),
      ),
      blockedOperation,
      'SUPPLIER_RETURN_CREDIT_DEPENDENCY',
    );
    expect(await supplierBalances(source.supplierId)).toEqual({ payable: '0', credit: '50' });
    await correct('refunds', 'cancel', refundOperation, correctionBody()).expect(201);
    expect(await supplierBalances(source.supplierId)).toEqual({ payable: '0', credit: '200' });
    expect(await accountBalance(refundAccount)).toBe('0');
    const originalFacts = async () =>
      (
        await db().admin.query<{ id: string; fact: string }>(
          `select id,(to_jsonb(r)-array['status','cancelled_at','updated_at','version'])::text as fact
       from ledger.supplier_returns r where store_id=$1 and operation_id=$2`,
          [owner.storeId, source.returnOperationId],
        )
      ).rows;
    const saved = await originalFacts();
    const body = correctionBody({ amountMinor: '100', reason: 'S4E2-03 replacement' });
    const replacement = await correct(
      'financial-returns',
      'replace',
      source.returnOperationId,
      body,
    ).expect(201);
    expect(await originalFacts()).toEqual(saved);
    expect(replacement.body).toMatchObject({
      target: { id: saved[0]?.id, status: 'cancelled' },
      replacement: {
        operationId: body.operationId,
        return: {
          purchaseInvoiceId: source.invoice.response.invoice.id,
          amountMinor: '100',
          supplierCreditCreatedMinor: '100',
        },
      },
    });
    expect(await supplierBalances(source.supplierId)).toEqual({ payable: '0', credit: '100' });
    const inverse = (
      await db().admin.query<{
        reversal_of_id: string;
        original: string;
        reference_id: string;
        accounting_period_id: string;
        p: string;
        c: string;
      }>(
        `select r.reversal_of_id,o.id as original,r.reference_id,r.accounting_period_id,
        (r.payable_delta_minor+o.payable_delta_minor)::text as p,
        (r.credit_delta_minor+o.credit_delta_minor)::text as c
       from ledger.supplier_ledger_entries r join ledger.supplier_ledger_entries o
         on o.store_id=r.store_id and o.id=r.reversal_of_id
       where r.store_id=$1 and r.transaction_group_id=$2`,
        [owner.storeId, body.operationId],
      )
    ).rows;
    expect(inverse).toHaveLength(1);
    expect(inverse[0]).toMatchObject({
      reversal_of_id: inverse[0]?.original,
      reference_id: saved[0]?.id,
      p: '0',
      c: '0',
      accounting_period_id: currentPeriodId,
    });
    expect(
      (
        await db().admin.query(
          `select status,response_body from sync.processed_operations where store_id=$1 and operation_id=$2`,
          [owner.storeId, body.operationId],
        )
      ).rows,
    ).toEqual([{ status: 'applied', response_body: replacement.body as unknown }]);
    const after = await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables);
    for (const table of [
      'audit.central_audit_logs',
      'sync.change_events',
      'sync.store_change_events_v1',
    ]) {
      expect(after[table]?.some((row) => row.includes(String(saved[0]?.id)))).toBe(true);
    }
    expect(
      (await correct('financial-returns', 'replace', source.returnOperationId, body).expect(201))
        .body,
    ).toEqual(replacement.body);
    expect(await captureReplayEvidence(db().admin, owner.storeId, supplierFinancialTables)).toEqual(
      after,
    );
    const secondOperation = randomUUID();
    await rejectUnchanged(
      correct(
        'financial-returns',
        'cancel',
        source.returnOperationId,
        correctionBody(undefined, secondOperation),
      ),
      secondOperation,
      'SUPPLIER_FINANCIAL_CORRECTION_TARGET_NOT_ACTIVE',
    );
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

  it('Stage 3B B02 reverses a Refund through its historical archived account and replaces through a current account', async () => {
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
