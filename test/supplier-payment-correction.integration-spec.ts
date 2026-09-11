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
import type { SupplierFinancialResponse } from '../src/suppliers/supplier-financial-read.types';
import type { SupplierInvoicePostingResponse } from '../src/suppliers/supplier-invoice-posting.types';
import type { SupplierPaymentCorrectionResponse } from '../src/suppliers/supplier-payment-correction.types';
import type { SupplierPaymentPostingResponse } from '../src/suppliers/supplier-payment-posting.types';
import type {
  SupplierPaymentDetailResponse,
  SupplierPaymentListResponse,
} from '../src/suppliers/supplier-payment-read.types';
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

interface DomainCounts {
  payments: number;
  allocations: number;
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
  email: `s135-owner-a-${randomUUID()}@example.test`,
  token: '',
};
const ownerB: TestIdentity = {
  storeId: randomUUID(),
  userId: randomUUID(),
  deviceId: randomUUID(),
  email: `s135-owner-b-${randomUUID()}@example.test`,
  token: '',
};

const supplierIds = {
  cancelMoney: randomUUID(),
  cancelOwner: randomUUID(),
  edit: randomUUID(),
  guard: randomUUID(),
  closed: randomUUID(),
  race: randomUUID(),
  editRace: randomUUID(),
  rollback: randomUUID(),
  foreign: randomUUID(),
} as const;
const accountIds = {
  cash: randomUUID(),
  alternate: randomUUID(),
  foreign: randomUUID(),
} as const;

describe('S13.5 Supplier Payment corrections on isolated PostgreSQL', () => {
  jest.setTimeout(120_000);

  let database: InventoryTestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let server: Server;
  let runtimePool: Pool | undefined;
  let authPool: Pool | undefined;

  function db(): InventoryTestDatabase {
    if (!database) throw new Error('Isolated S13.5 database is unavailable.');
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
  ): Promise<{ operationId: string; payableId: string }> {
    const result = await request(server)
      .post(`/v1/suppliers/${supplierId}/opening-payables`)
      .set('authorization', `Bearer ${ownerA.token}`)
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
    notes?: string;
  }): Record<string, unknown> {
    const source = input.paymentSource ?? 'money_account';
    return {
      operationId: input.operationId ?? randomUUID(),
      paymentSource: source,
      moneyAccountId:
        input.moneyAccountId === undefined
          ? source === 'money_account'
            ? accountIds.cash
            : null
          : input.moneyAccountId,
      amountMinor: input.amountMinor,
      occurredAt: input.occurredAt ?? septemberInstant,
      externalReference: 'S13.5 fixture',
      notes: input.notes ?? 'Supplier payment',
      allocations: input.allocations,
    };
  }

  async function postPayment(
    supplierId: string,
    body: Record<string, unknown>,
    identity = ownerA,
  ): Promise<SupplierPaymentPostingResponse> {
    const result = await request(server)
      .post(`/v1/suppliers/${supplierId}/payments`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body)
      .expect(201);
    return result.body as SupplierPaymentPostingResponse;
  }

  function cancelPayment(
    targetOperationId: string,
    body: Record<string, unknown>,
    identity = ownerA,
  ) {
    return request(server)
      .post(`/v1/suppliers/payments/${targetOperationId}/cancel`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function editPayment(
    targetOperationId: string,
    body: Record<string, unknown>,
    identity = ownerA,
  ) {
    return request(server)
      .post(`/v1/suppliers/payments/${targetOperationId}/edit`)
      .set('authorization', `Bearer ${identity.token}`)
      .send(body);
  }

  function editBody(input: {
    operationId: string;
    supplierId: string;
    amountMinor: string;
    paymentSource?: 'money_account' | 'owner_pocket';
    moneyAccountId?: string | null;
    occurredAt?: string;
    replacementOccurredAt?: string;
    allocations: {
      targetType: 'purchase_invoice' | 'opening_payable';
      targetId: string;
      amountMinor: string;
    }[];
    notes?: string;
  }): Record<string, unknown> {
    const replacement = paymentBody({
      operationId: input.operationId,
      paymentSource: input.paymentSource,
      moneyAccountId: input.moneyAccountId,
      amountMinor: input.amountMinor,
      occurredAt: input.replacementOccurredAt,
      allocations: input.allocations,
      notes: input.notes,
    });
    delete replacement.operationId;
    return {
      operationId: input.operationId,
      occurredAt: input.occurredAt ?? '2026-09-20T10:00:00Z',
      replacement: { supplierId: input.supplierId, ...replacement },
    };
  }

  async function supplierOutstanding(supplierId: string): Promise<string> {
    const result = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(payable_delta_minor-credit_delta_minor),0)::text as amount
       from ledger.supplier_ledger_entries where supplier_id=$1`,
      [supplierId],
    );
    return result.rows[0]?.amount ?? 'missing';
  }

  async function targetAllocated(
    targetType: 'invoice' | 'opening',
    targetId: string,
  ): Promise<string> {
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

  async function ownerLiability(): Promise<string> {
    const result = await db().admin.query<{ amount: string }>(
      `select coalesce(sum(owner_liability_delta_minor),0)::text as amount
       from ledger.owner_ledger_entries where store_id=$1`,
      [ownerA.storeId],
    );
    return result.rows[0]?.amount ?? 'missing';
  }

  async function financial(supplierId: string): Promise<SupplierFinancialResponse> {
    const result = await request(server)
      .get(`/v1/suppliers/${supplierId}/invoices`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    return result.body as SupplierFinancialResponse;
  }

  async function payments(supplierId: string): Promise<SupplierPaymentListResponse> {
    const result = await request(server)
      .get(`/v1/suppliers/${supplierId}/payments`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    return result.body as SupplierPaymentListResponse;
  }

  async function domainCounts(): Promise<DomainCounts> {
    const result = await db().admin.query<DomainCounts>(
      `select
        (select count(*)::integer from ledger.supplier_payments where store_id=$1) as payments,
        (select count(*)::integer from ledger.supplier_payment_allocations where store_id=$1) as allocations,
        (select count(*)::integer from ledger.purchase_invoices where store_id=$1) as invoices,
        (select count(*)::integer from ledger.expenses where store_id=$1) as expenses,
        (select count(*)::integer from ledger.goods_receipts where store_id=$1) as "goodsReceipts",
        (select count(*)::integer from ledger.inventory_movements where store_id=$1) as "inventoryMovements",
        (select count(*)::integer from ledger.stock_balances where store_id=$1) as "stockBalances"`,
      [ownerA.storeId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Expected S13.5 domain counts.');
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
      throw new Error('S13.5 integration database is not isolated.');
    }
    const databaseUrl = (source: string): string => {
      const parsed = new URL(source);
      parsed.pathname = `/${databaseName}`;
      return parsed.toString();
    };
    runtimePool = createTestPool(databaseUrl(environment.runtimeUrl), 'dokana-s135-runtime', 8);
    authPool = createTestPool(databaseUrl(environment.authUrl), 'dokana-s135-auth', 2);

    const password = randomUUID();
    const passwordHash = await new PasswordService().hash(password);
    for (const identity of [ownerA, ownerB]) {
      await db().admin.query(
        `insert into ledger.stores(id,name,status) values($1,'S13.5 fixture','active')`,
        [identity.storeId],
      );
      await db().admin.query(
        `insert into platform.users(id,email,normalized_email,password_hash,full_name)
         values($1,$2,$2,$3,'S13.5 owner')`,
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
        [supplierId, storeId, `S13.5 ${name}`, `s13.5 ${name}`, randomUUID()],
      );
    }
    await db().admin.query(
      `insert into ledger.money_accounts(
         id,store_id,name,normalized_name,account_type,availability,status,operation_id
       ) values
         ($1,$4,'S13.5 cash','s13.5 cash','cash','available','active',$6),
         ($2,$4,'S13.5 alternate','s13.5 alternate','transfer','available','active',$7),
         ($3,$5,'S13.5 foreign','s13.5 foreign','transfer','available','active',$8)`,
      [
        accountIds.cash,
        accountIds.alternate,
        accountIds.foreign,
        ownerA.storeId,
        ownerB.storeId,
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
          deviceName: 'S13.5 isolated',
          devicePlatform: 'android',
        })
        .expect(200);
      const body = login.body as { accessToken?: unknown };
      if (typeof body.accessToken !== 'string') throw new Error('S13.5 login token missing.');
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

  it('cancels Money Account settlement and restores Invoice and Opening Payable reads', async () => {
    const invoice = await postInvoice(supplierIds.cancelMoney, '500');
    const opening = await postOpening(supplierIds.cancelMoney, '300');
    const paymentOperationId = randomUUID();
    const posted = await postPayment(
      supplierIds.cancelMoney,
      paymentBody({
        operationId: paymentOperationId,
        amountMinor: '400',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '200',
          },
          { targetType: 'opening_payable', targetId: opening.payableId, amountMinor: '200' },
        ],
      }),
    );
    const allocationSnapshot = [...posted.allocations];
    const before = await domainCounts();
    const correctionOperationId = randomUUID();
    const result = await cancelPayment(paymentOperationId, {
      operationId: correctionOperationId,
      occurredAt: '2026-09-20T10:00:00Z',
    }).expect(201);
    const correction = result.body as SupplierPaymentCorrectionResponse;

    expect(correction).toMatchObject({
      operationId: correctionOperationId,
      targetOperationId: paymentOperationId,
      intent: 'cancel',
      target: { paymentId: posted.payment.id, status: 'cancelled' },
      reversal: {
        payable: { payableDeltaMinor: '400', reversalOfId: posted.payable.id },
        moneyMovement: {
          amountDeltaMinor: '400',
          reversalOfId: posted.moneyMovement?.id,
          movementType: 'correction',
        },
        ownerLedgerEntry: null,
      },
      replacement: null,
    });
    expect(await accountBalance(accountIds.cash)).toBe('0');
    expect(await supplierOutstanding(supplierIds.cancelMoney)).toBe('800');
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('0');
    expect(await targetAllocated('opening', opening.payableId)).toBe('0');

    const view = await financial(supplierIds.cancelMoney);
    expect(view.totalOutstandingMinor).toBe('800');
    expect(view.invoices[0]).toMatchObject({
      paidAmountMinor: '0',
      outstandingMinor: '500',
      settlementState: 'UNPAID',
    });
    expect(view.openingPayable).toMatchObject({
      paidAmountMinor: '0',
      outstandingMinor: '300',
      settlementState: 'UNPAID',
    });
    const history = await payments(supplierIds.cancelMoney);
    expect(history.payments).toHaveLength(1);
    expect(history.payments[0]).toMatchObject({ status: 'cancelled', allocationCount: 2 });
    const detailResult = await request(server)
      .get(`/v1/suppliers/${supplierIds.cancelMoney}/payments/${posted.payment.id}`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .expect(200);
    const detail = detailResult.body as SupplierPaymentDetailResponse;
    expect(detail.allocations).toHaveLength(allocationSnapshot.length);
    for (const historical of allocationSnapshot) {
      expect(
        detail.allocations.find((allocation) => allocation.id === historical.id),
      ).toMatchObject({
        amountMinor: historical.amountMinor,
        target: {
          type:
            historical.targetType === 'purchase_invoice' ? 'SUPPLIER_INVOICE' : 'OPENING_PAYABLE',
          id: historical.targetId,
        },
      });
    }
    expect(await domainCounts()).toEqual(before);
  });

  it('cancels an Owner-funded bigint payment without creating a Money Account effect', async () => {
    const amountMinor = '9007199254740993';
    const invoice = await postInvoice(supplierIds.cancelOwner, amountMinor);
    const operationId = randomUUID();
    const posted = await postPayment(
      supplierIds.cancelOwner,
      paymentBody({
        operationId,
        paymentSource: 'owner_pocket',
        moneyAccountId: null,
        amountMinor,
        allocations: [
          { targetType: 'purchase_invoice', targetId: invoice.response.invoice.id, amountMinor },
        ],
      }),
    );
    const liabilityBefore = await ownerLiability();
    const result = await cancelPayment(operationId, {
      operationId: randomUUID(),
      occurredAt: '2026-09-20T10:00:00Z',
    }).expect(201);
    const correction = result.body as SupplierPaymentCorrectionResponse;

    expect(correction.reversal.payable.payableDeltaMinor).toBe(amountMinor);
    expect(correction.reversal.moneyMovement).toBeNull();
    expect(correction.reversal.ownerLedgerEntry).toMatchObject({
      entryType: 'correction',
      ownerLiabilityDeltaMinor: `-${amountMinor}`,
      equityDeltaMinor: '0',
      moneyAccountId: null,
      reversalOfId: posted.ownerLedgerEntry?.id,
    });
    expect(BigInt(await ownerLiability()) - BigInt(liabilityBefore)).toBe(-BigInt(amountMinor));
    expect(await supplierOutstanding(supplierIds.cancelOwner)).toBe(amountMinor);
  });

  it('edits by reversing first, then posts a canonical multi-allocation replacement', async () => {
    const invoice = await postInvoice(supplierIds.edit, '500');
    const opening = await postOpening(supplierIds.edit, '200');
    const originalOperationId = randomUUID();
    const original = await postPayment(
      supplierIds.edit,
      paymentBody({
        operationId: originalOperationId,
        amountMinor: '200',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '200',
          },
        ],
      }),
    );
    const editOperationId = randomUUID();
    const allocations = [
      { targetType: 'opening_payable' as const, targetId: opening.payableId, amountMinor: '100' },
      {
        targetType: 'purchase_invoice' as const,
        targetId: invoice.response.invoice.id,
        amountMinor: '300',
      },
    ];
    const body = editBody({
      operationId: editOperationId,
      supplierId: supplierIds.edit,
      paymentSource: 'owner_pocket',
      moneyAccountId: null,
      amountMinor: '400',
      replacementOccurredAt: '2026-10-01T10:00:00Z',
      allocations,
      notes: 'Replacement owner payment',
    });
    const first = await editPayment(originalOperationId, body).expect(201);
    const correction = first.body as SupplierPaymentCorrectionResponse;

    expect(correction.reversal.moneyMovement).toMatchObject({
      amountDeltaMinor: '200',
      reversalOfId: original.moneyMovement?.id,
    });
    expect(correction.replacement).toMatchObject({
      operationId: editOperationId,
      supplierId: supplierIds.edit,
      payment: {
        paymentSource: 'owner_pocket',
        amountMinor: '400',
        status: 'posted',
      },
      ownerLedgerEntry: { ownerLiabilityDeltaMinor: '400' },
      moneyMovement: null,
    });
    expect(correction.replacement?.allocations.map((allocation) => allocation.targetType)).toEqual([
      'opening_payable',
      'purchase_invoice',
    ]);
    expect(await accountBalance(accountIds.cash)).toBe('0');
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('300');
    expect(await targetAllocated('opening', opening.payableId)).toBe('100');
    expect(await supplierOutstanding(supplierIds.edit)).toBe('300');

    const view = await financial(supplierIds.edit);
    expect(view.totalOutstandingMinor).toBe('300');
    expect(view.invoices[0]).toMatchObject({
      paidAmountMinor: '300',
      outstandingMinor: '200',
      settlementState: 'PARTIALLY_PAID',
    });
    expect(view.openingPayable).toMatchObject({
      paidAmountMinor: '100',
      outstandingMinor: '100',
      settlementState: 'PARTIALLY_PAID',
    });
    const history = await payments(supplierIds.edit);
    expect(history.payments.map((payment) => payment.status).sort()).toEqual([
      'cancelled',
      'posted',
    ]);

    const replayBody = editBody({
      operationId: editOperationId,
      supplierId: supplierIds.edit,
      paymentSource: 'owner_pocket',
      moneyAccountId: null,
      amountMinor: '400',
      replacementOccurredAt: '2026-10-01T10:00:00Z',
      allocations: [...allocations].reverse(),
      notes: 'Replacement owner payment',
    });
    const replay = await editPayment(originalOperationId, replayBody).expect(201);
    expect(replay.body).toEqual(first.body);
    await editPayment(originalOperationId, { ...body, occurredAt: '2026-09-21T10:00:00Z' })
      .expect(409)
      .expect(({ body: error }) => expect(error).toMatchObject({ code: 'OPERATION_ID_CONFLICT' }));
    await cancelPayment(originalOperationId, {
      operationId: randomUUID(),
      occurredAt: '2026-09-22T10:00:00Z',
    })
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_ACTIVE' }),
      );

    await editPayment(
      editOperationId,
      editBody({
        operationId: randomUUID(),
        supplierId: supplierIds.edit,
        paymentSource: 'owner_pocket',
        moneyAccountId: null,
        amountMinor: '701',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '501',
          },
          { targetType: 'opening_payable', targetId: opening.payableId, amountMinor: '200' },
        ],
      }),
    )
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({
          code: 'SUPPLIER_PAYMENT_ALLOCATION_EXCEEDS_OUTSTANDING',
        }),
      );
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('300');
    expect(await targetAllocated('opening', opening.payableId)).toBe('100');
  });

  it('preserves the S12 guard while any other active allocation remains', async () => {
    const invoice = await postInvoice(supplierIds.guard, '300');
    const firstOperation = randomUUID();
    const secondOperation = randomUUID();
    for (const operationId of [firstOperation, secondOperation]) {
      await postPayment(
        supplierIds.guard,
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
      );
    }
    await cancelPayment(firstOperation, {
      operationId: randomUUID(),
      occurredAt: '2026-09-20T10:00:00Z',
    }).expect(201);
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('100');
    await request(server)
      .post(`/v1/suppliers/invoices/${invoice.operationId}/cancel`)
      .set('authorization', `Bearer ${ownerA.token}`)
      .send({ operationId: randomUUID(), occurredAt: '2026-09-20T10:00:00Z' })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_CORRECTION_TARGET_HAS_ACTIVE_ALLOCATIONS' }),
      );
  });

  it('fails closed cross-Store and in a closed correction period', async () => {
    const foreignInvoice = await postInvoice(supplierIds.foreign, '100', randomUUID(), ownerB);
    const foreignOperation = randomUUID();
    await postPayment(
      supplierIds.foreign,
      paymentBody({
        operationId: foreignOperation,
        moneyAccountId: accountIds.foreign,
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: foreignInvoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
      ownerB,
    );
    await cancelPayment(foreignOperation, {
      operationId: randomUUID(),
      occurredAt: '2026-09-20T10:00:00Z',
    })
      .expect(404)
      .expect(({ body }) =>
        expect(body).toMatchObject({ code: 'SUPPLIER_PAYMENT_CORRECTION_TARGET_NOT_FOUND' }),
      );

    const decemberInstant = '2026-12-10T10:00:00Z';
    const invoice = await postInvoice(
      supplierIds.closed,
      '100',
      randomUUID(),
      ownerA,
      decemberInstant,
    );
    const paymentOperation = randomUUID();
    const posted = await postPayment(
      supplierIds.closed,
      paymentBody({
        operationId: paymentOperation,
        amountMinor: '100',
        occurredAt: decemberInstant,
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    );
    const periodId = deriveAccountingPeriodId(ownerA.storeId, 2026, 12);
    await db().admin.query(
      `update ledger.accounting_periods
       set status='closed',closed_at=clock_timestamp() where id=$1`,
      [periodId],
    );
    const correctionOperation = randomUUID();
    const body = { operationId: correctionOperation, occurredAt: decemberInstant };
    await cancelPayment(paymentOperation, body)
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    await db().admin.query(
      `update ledger.accounting_periods set status='open',closed_at=null where id=$1`,
      [periodId],
    );
    await cancelPayment(paymentOperation, body)
      .expect(409)
      .expect(({ body: error }) =>
        expect(error).toMatchObject({ code: 'ACCOUNTING_PERIOD_NOT_POSTING_ELIGIBLE' }),
      );
    const row = await db().admin.query<{ status: string; reversalCount: number }>(
      `select p.status,
        (select count(*)::integer from ledger.supplier_ledger_entries r
          where r.store_id=p.store_id and r.reversal_of_id=$3) as "reversalCount"
       from ledger.supplier_payments p where p.store_id=$1 and p.id=$2`,
      [ownerA.storeId, posted.payment.id, posted.payable.id],
    );
    expect(row.rows[0]).toEqual({ status: 'posted', reversalCount: 0 });
  });

  it('serializes competing cancel/edit and edit/edit corrections without branching', async () => {
    const invoice = await postInvoice(supplierIds.race, '100');
    const paymentOperation = randomUUID();
    const racePayment = await postPayment(
      supplierIds.race,
      paymentBody({
        operationId: paymentOperation,
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    );
    const cancel = cancelPayment(paymentOperation, {
      operationId: randomUUID(),
      occurredAt: '2026-09-20T10:00:00Z',
    });
    const edit = editPayment(
      paymentOperation,
      editBody({
        operationId: randomUUID(),
        supplierId: supplierIds.race,
        amountMinor: '100',
        moneyAccountId: accountIds.alternate,
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    );
    const competing = await Promise.all([cancel, edit]);
    expect(competing.map((result) => result.status).sort()).toEqual([201, 409]);
    const firstReversals = await db().admin.query<{ count: number }>(
      `select count(*)::integer as count from ledger.supplier_ledger_entries
       where store_id=$1 and entry_type='correction' and reference_id=$2`,
      [ownerA.storeId, racePayment.payment.id],
    );
    expect(firstReversals.rows[0]).toEqual({ count: 1 });

    const secondInvoice = await postInvoice(supplierIds.editRace, '100');
    const secondPaymentOperation = randomUUID();
    await postPayment(
      supplierIds.editRace,
      paymentBody({
        operationId: secondPaymentOperation,
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: secondInvoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    );
    const edits = await Promise.all(
      [accountIds.cash, accountIds.alternate].map((accountId) =>
        editPayment(
          secondPaymentOperation,
          editBody({
            operationId: randomUUID(),
            supplierId: supplierIds.editRace,
            amountMinor: '100',
            moneyAccountId: accountId,
            allocations: [
              {
                targetType: 'purchase_invoice',
                targetId: secondInvoice.response.invoice.id,
                amountMinor: '100',
              },
            ],
          }),
        ),
      ),
    );
    expect(edits.map((result) => result.status).sort()).toEqual([201, 409]);
    const active = (await payments(supplierIds.editRace)).payments.filter(
      (payment) => payment.status === 'posted',
    );
    expect(active).toHaveLength(1);
    expect(await targetAllocated('invoice', secondInvoice.response.invoice.id)).toBe('100');
  });

  it('rolls back every correction effect and claim on unexpected failure', async () => {
    const invoice = await postInvoice(supplierIds.rollback, '100');
    const paymentOperation = randomUUID();
    const posted = await postPayment(
      supplierIds.rollback,
      paymentBody({
        operationId: paymentOperation,
        amountMinor: '100',
        allocations: [
          {
            targetType: 'purchase_invoice',
            targetId: invoice.response.invoice.id,
            amountMinor: '100',
          },
        ],
      }),
    );
    const correctionOperation = randomUUID();
    await db().admin.query(
      `insert into ledger.money_movements(
         id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
         reference_type,reference_id,transaction_group_id,occurred_at,operation_id
       ) values($1,$2,$3,$4,'other',1,'fixture',$5,$6,$7,$8)`,
      [
        randomUUID(),
        ownerA.storeId,
        accountIds.cash,
        posted.accountingPeriodId,
        randomUUID(),
        deriveTransactionGroupId(randomUUID()),
        septemberInstant,
        deriveMoneyFactOperationId(correctionOperation, 'supplier-payment-money-reversal'),
      ],
    );
    const before = await domainCounts();
    await cancelPayment(paymentOperation, {
      operationId: correctionOperation,
      occurredAt: '2026-09-20T10:00:00Z',
    }).expect(500);
    expect(await domainCounts()).toEqual(before);
    const residue = await db().admin.query<{
      status: string;
      reversals: number;
      operationClaims: number;
    }>(
      `select p.status,
        (select count(*)::integer from ledger.supplier_ledger_entries r
          where r.store_id=p.store_id and r.reversal_of_id=$3) as reversals,
        (select count(*)::integer from sync.processed_operations o
          where o.store_id=p.store_id and o.operation_id=$4) as "operationClaims"
       from ledger.supplier_payments p where p.store_id=$1 and p.id=$2`,
      [ownerA.storeId, posted.payment.id, posted.payable.id, correctionOperation],
    );
    expect(residue.rows[0]).toEqual({ status: 'posted', reversals: 0, operationClaims: 0 });
    expect(await targetAllocated('invoice', invoice.response.invoice.id)).toBe('100');
    expect(await supplierOutstanding(supplierIds.rollback)).toBe('0');
  });

  it('creates no unrelated accounting or inventory effects and fails closed without context', async () => {
    const counts = await domainCounts();
    expect(counts.expenses).toBe(0);
    expect(counts.goodsReceipts).toBe(0);
    expect(counts.inventoryMovements).toBe(0);
    expect(counts.stockBalances).toBe(0);
    if (!runtimePool) throw new Error('S13.5 runtime pool is unavailable.');
    const hidden = await runtimePool.query<{ count: number }>(
      'select count(*)::integer as count from ledger.supplier_payments',
    );
    expect(hidden.rows[0]).toEqual({ count: 0 });
    await request(server)
      .post(`/v1/suppliers/payments/${randomUUID()}/cancel`)
      .send({ operationId: randomUUID(), occurredAt: septemberInstant })
      .expect(401);
  });
});
